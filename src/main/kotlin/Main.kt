import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLDecoder
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ApiResponse(val subdomains: List<Service>, @SerialName("checked_at") val checkedAt: Instant)

class Asset(val type: String, val body: ByteArray)

val types = mapOf("html" to "text/html", "js" to "text/javascript", "css" to "text/css")
val assets = listOf("index.html", "main.js", "style.css", "blades.min.css").associate { file ->
    val type = types.getValue(file.substringAfterLast('.')) + "; charset=utf-8"
    "/$file" to Asset(type, ClassLoader.getSystemResourceAsStream("static/$file")!!.readBytes())
}

fun respond(ex: HttpExchange, status: Int, type: String, body: ByteArray) {
    val head = ex.requestMethod == "HEAD"
    ex.responseHeaders["Content-Type"] = type
    ex.sendResponseHeaders(status, if (head) -1 else body.size.toLong())
    if (!head) ex.responseBody.write(body)
    ex.close()
}

// query decodes the URL query, skipping malformed pairs. Like in Go the first value of a key wins.
fun query(uri: URI): Map<String, String> = uri.rawQuery.orEmpty().split('&').asReversed().mapNotNull { pair ->
    runCatching {
        val (key, value) = listOf(pair.substringBefore('='), pair.substringAfter('=', ""))
        URLDecoder.decode(key, Charsets.UTF_8) to URLDecoder.decode(value, Charsets.UTF_8)
    }.getOrNull()
}.toMap()

fun handle(ex: HttpExchange) {
    val path = ex.requestURI.path
    if (path == "/api/subdomains") {
        val params = query(ex.requestURI)
        val e = getServices(params["domain"].orEmpty().lowercase(), "refresh" in params)
        val body = json.encodeToString(ApiResponse(e.services, e.checkedAt)).toByteArray()
        return respond(ex, 200, "application/json", body)
    }
    val asset = assets[if (path == "/") "/index.html" else path]
    if (asset != null) respond(ex, 200, asset.type, asset.body)
    else respond(ex, 404, "text/plain; charset=utf-8", "404 page not found\n".toByteArray())
}

fun trustManagers(store: KeyStore?) =
    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }.trustManagers

// sslContext also trusts the CA certificates in SSL_CERT_FILE, e.g. of a private CA. Go does the same on Linux.
fun sslContext(): SSLContext {
    val file = System.getenv("SSL_CERT_FILE") ?: return SSLContext.getDefault()
    val defaults = trustManagers(null).filterIsInstance<X509TrustManager>().flatMap { it.acceptedIssuers.asList() }
    val extra = File(file).inputStream().use { CertificateFactory.getInstance("X.509").generateCertificates(it) }
    val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) }
    (defaults + extra).forEachIndexed { i, cert -> store.setCertificateEntry("ca$i", cert) }
    return SSLContext.getInstance("TLS").apply { init(null, trustManagers(store), null) }
}

fun main() {
    val server = HttpServer.create(InetSocketAddress(8080), 0)
    server.executor = tasks
    server.createContext("/", ::handle)
    server.start()
}
