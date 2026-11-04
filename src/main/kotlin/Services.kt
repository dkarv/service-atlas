import java.io.File
import java.io.InputStream
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpResponse.BodyHandlers
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.time.Clock
import kotlin.time.Instant
import kotlin.time.toKotlinDuration
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream

val ttl = Duration.ofHours(24) // subdomain list from crt.sh
val checkTtl = Duration.ofHours(1) // probe results
val probeTimeout: Duration = Duration.ofSeconds(5)
val zeroTime = Instant.parse("0001-01-01T00:00:00Z")
val flags = setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)
val manifestRe = Regex("""<link[^>]+rel=["']?manifest["']?[^>]*>""", flags)
val iconRe = Regex("""<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>""", flags)
val hrefRe = Regex("""href=["']([^"']+)["']""", flags)
val entities = mapOf("&amp;" to "&", "&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'")
val tasks = Executors.newVirtualThreadPerTaskExecutor()
val client: HttpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS).executor(tasks).build()
val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; encodeDefaults = true }

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
data class CacheEntry(
    @SerialName("fetched_at") val fetchedAt: Instant = zeroTime,
    @SerialName("checked_at") val checkedAt: Instant = zeroTime,
    val services: List<Service> = emptyList(),
)

@Serializable
data class Cert(@SerialName("name_value") val nameValue: String = "", @SerialName("not_before") val notBefore: String = "")

@Serializable
data class Manifest(val name: String? = null, val description: String? = null)

// fetch requests url and hands the response to read. It runs as a task because HttpRequest.timeout ends at the headers.
fun <T> fetch(url: String, timeout: Duration, read: (HttpResponse<InputStream>) -> T): T {
    val task = tasks.submit(Callable {
        val response = client.send(HttpRequest.newBuilder(URI(url)).build(), BodyHandlers.ofInputStream())
        response.body().use { read(response) }
    })
    try {
        return task.get(timeout.toMillis(), TimeUnit.MILLISECONDS)
    } catch (e: ExecutionException) {
        throw e.cause ?: e
    } finally {
        task.cancel(true)
    }
}

// fetchSubdomains lists the subdomains in the CT logs with the date of their latest certificate.
@OptIn(ExperimentalSerializationApi::class)
fun fetchSubdomains(domain: String): List<Service> {
    val query = URLEncoder.encode("%.$domain", Charsets.UTF_8)
    val certs = fetch("https://crt.sh/?output=json&q=$query", Duration.ofSeconds(20)) {
        json.decodeFromStream<List<Cert>>(it.body())
    }
    val latest = HashMap<String, String>()
    for (cert in certs) {
        for (name in cert.nameValue.lowercase().split(Regex("\\s+"))) {
            // ISO timestamps compare as strings.
            if (name.endsWith(".$domain") && !name.startsWith("*") && cert.notBefore > latest[name].orEmpty()) {
                latest[name] = cert.notBefore
            }
        }
    }
    return latest.map { (host, issued) -> Service(host, issued) }
}

// link resolves the href of the first tag matching re against the final URL of a possibly redirected request.
fun link(re: Regex, body: String, base: URI): String? {
    val href = hrefRe.find(re.find(body)?.value ?: return null)?.groupValues?.get(1) ?: return null
    val unescaped = entities.entries.fold(href) { text, (entity, char) -> text.replace(entity, char) }
    val root = if (base.rawPath.isEmpty()) base.resolve("/") else base // URI.resolve drops the slash otherwise
    return runCatching { root.resolve(unescaped.trim().replace(" ", "%20")).toString() }.getOrNull()
}

// probe requests https://host and extracts its favicon and web app manifest name and description.
@OptIn(ExperimentalSerializationApi::class)
fun probe(s: Service): Service = try {
    val (status, base, body) = fetch("https://${s.host}/", probeTimeout) {
        Triple(it.statusCode(), it.uri(), it.body().readNBytes(1 shl 20).decodeToString())
    }
    val manifest = link(manifestRe, body, base)?.let { url ->
        runCatching { fetch(url, probeTimeout) { json.decodeFromStream<Manifest>(it.body()) } }.getOrNull()
    }
    Service(
        s.host, s.issued, status,
        name = manifest?.name?.ifEmpty { null },
        description = manifest?.description?.ifEmpty { null },
        favicon = link(iconRe, body, base),
    )
} catch (e: Exception) {
    Service(s.host, s.issued, error = e.message ?: e.toString())
}

fun expired(time: Instant, maxAge: Duration) = Clock.System.now() - time > maxAge.toKotlinDuration()

// getServices returns the probed subdomains of domain, refreshing outdated parts of the cache.
fun getServices(domain: String, refresh: Boolean): CacheEntry {
    // Only the last path segment, which keeps the domain from escaping the cache directory.
    val file = File("cache", domain.trimEnd('/').substringAfterLast('/').ifEmpty { "." } + ".json")
    var e = runCatching { json.decodeFromString<CacheEntry>(file.readText()) }.getOrDefault(CacheEntry())
    if (refresh || expired(e.fetchedAt, ttl)) {
        // On errors keep the cached list, crt.sh is flaky.
        runCatching { fetchSubdomains(domain) }.onSuccess { e = CacheEntry(Clock.System.now(), zeroTime, it) }
    }
    if (refresh || expired(e.checkedAt, checkTtl)) {
        e = e.copy(services = e.services.map(::probe), checkedAt = Clock.System.now())
    }
    runCatching { File("cache").mkdirs(); file.writeText(json.encodeToString(e)) }
    return e
}
