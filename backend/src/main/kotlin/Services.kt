@file:OptIn(ExperimentalSerializationApi::class)

import java.io.File
import java.net.*
import java.util.concurrent.Callable
import kotlin.time.*
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.*
import kotlinx.serialization.json.*

// Cache and limits
val ttl = 24.hours // subdomain list from crt.sh
val checkTtl = 1.hours // probe results
val crtShTimeout = 20.seconds
val probeTimeout = 5.seconds
const val MAX_BODY_SIZE = 1 shl 20 // read of a probed page, 1 MiB
/** Go's zero time, so cache files stay compatible with the Go version. */
val zeroTime = Instant.parse("0001-01-01T00:00:00Z")

// HTML parsing
val manifestRe = Regex("""<link[^>]+rel=["']?manifest["']?[^>]*>""", RegexOption.IGNORE_CASE)
val iconRe = Regex("""<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>""", RegexOption.IGNORE_CASE)
val hrefRe = Regex("""href=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
val htmlEntities = mapOf("&amp;" to "&", "&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'")
val whitespace = Regex("\\s+")

// JSON, snake_case like the APIs of crt.sh and Go
val json = Json {
    ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; encodeDefaults = true
    namingStrategy = JsonNamingStrategy.SnakeCase
}

@Serializable
data class Service(
    val host: String,
    val issued: String, // date of the latest certificate
    val status: Int = 0,
    val error: String? = null,
    val name: String? = null,
    val description: String? = null,
    val favicon: String? = null,
)

@Serializable
data class CacheEntry(val fetchedAt: Instant = zeroTime, val checkedAt: Instant = zeroTime, val subdomains: List<Service> = emptyList())

@Serializable
data class Cert(val nameValue: String = "", val notBefore: String = "")

@Serializable
data class Manifest(val name: String? = null, val description: String? = null)

/** The start of a probed page and the URL it came from, which differs from the requested one after redirects. */
class Page(val status: Int, val url: URI, val body: String)

/** Lists the subdomains in the CT logs with the date of their latest certificate. */
fun fetchSubdomains(domain: String): List<Service> {
    val url = "https://crt.sh/?output=json&q=" + URLEncoder.encode("%.$domain", Charsets.UTF_8)
    val certs = fetch(url, crtShTimeout) { json.decodeFromStream<List<Cert>>(it.body()) }
    val latest = HashMap<String, String>()
    for (cert in certs) for (name in cert.nameValue.lowercase().split(whitespace)) {
        // ISO timestamps compare as strings.
        if (name.endsWith(".$domain") && !name.startsWith("*") && cert.notBefore > latest[name].orEmpty()) {
            latest[name] = cert.notBefore
        }
    }
    return latest.map { (host, issued) -> Service(host, issued) }
}

/** Resolves the href of the first tag matching [tag] in the page against the URL of the page. */
fun link(tag: Regex, page: Page): String? {
    val element = tag.find(page.body)?.value ?: return null
    val href = hrefRe.find(element)?.groupValues?.get(1) ?: return null
    val unescaped = htmlEntities.entries.fold(href) { text, (entity, char) -> text.replace(entity, char) }
    // URI.resolve drops the slash before a relative path if the base URL has no path at all.
    val base = if (page.url.rawPath.isEmpty()) page.url.resolve("/") else page.url
    return runCatching { base.resolve(unescaped.trim().replace(" ", "%20")).toString() }.getOrNull()
}

/** Requests https://host and extracts its favicon and the name and description of its web app manifest. */
fun probe(service: Service): Service {
    val page = try {
        fetch("https://${service.host}/", probeTimeout) {
            Page(it.statusCode(), it.uri(), it.body().readNBytes(MAX_BODY_SIZE).decodeToString())
        }
    } catch (e: Exception) {
        return Service(service.host, service.issued, error = e.message ?: e.toString())
    }
    val manifest = link(manifestRe, page)?.let { url ->
        runCatching { fetch(url, probeTimeout) { json.decodeFromStream<Manifest>(it.body()) } }.getOrNull()
    }
    return Service(
        service.host, service.issued, page.status,
        name = manifest?.name?.ifEmpty { null },
        description = manifest?.description?.ifEmpty { null },
        favicon = link(iconRe, page),
    )
}

fun expired(time: Instant, maxAge: Duration) = Clock.System.now() - time > maxAge

/** Returns the probed subdomains of [domain], refreshing outdated parts of the cache. */
fun getServices(domain: String, refresh: Boolean): CacheEntry {
    // Only the last path segment of the domain, so it can't escape the cache directory.
    val name = domain.trimEnd('/').substringAfterLast('/').ifEmpty { "." }
    val file = File("cache", "$name.json")
    var entry = runCatching { json.decodeFromString<CacheEntry>(file.readText()) }.getOrDefault(CacheEntry())
    if (refresh || expired(entry.fetchedAt, ttl)) {
        // On errors keep the cached list, crt.sh is flaky.
        runCatching { fetchSubdomains(domain) }.onSuccess { entry = CacheEntry(Clock.System.now(), zeroTime, it) }
    }
    if (refresh || expired(entry.checkedAt, checkTtl)) {
        val probes = entry.subdomains.map { tasks.submit(Callable { probe(it) }) }
        entry = entry.copy(subdomains = probes.map { it.get() }, checkedAt = Clock.System.now())
        runCatching { File("cache").mkdirs(); file.writeText(json.encodeToString(entry)) }
    }
    return entry
}
