import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLDecoder
import kotlin.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ApiResponse(val subdomains: List<Service>, @SerialName("checked_at") val checkedAt: Instant)

class Asset(val type: String, val body: ByteArray)

val types = mapOf("html" to "text/html", "js" to "text/javascript", "css" to "text/css")
val assets = listOf("index.html", "main.js", "style.css", "blades.min.css").associate { file ->
    val type = types.getValue(file.substringAfterLast('.')) + "; charset=utf-8"
    "/$file" to Asset(type, ClassLoader.getSystemResourceAsStream("frontend/$file")!!.readBytes())
}

fun respond(ex: HttpExchange, status: Int, type: String, body: ByteArray) {
    val head = ex.requestMethod == "HEAD"
    ex.responseHeaders["Content-Type"] = type
    ex.sendResponseHeaders(status, if (head) -1 else body.size.toLong())
    if (!head) ex.responseBody.write(body)
    ex.close()
}

/** Decodes the URL query, skipping malformed pairs. Like in Go, the first value of a key wins. */
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
        val entry = getServices(params["domain"].orEmpty().lowercase(), "refresh" in params)
        val body = json.encodeToString(ApiResponse(entry.services, entry.checkedAt)).toByteArray()
        return respond(ex, 200, "application/json", body)
    }
    val asset = assets[if (path == "/") "/index.html" else path]
    if (asset != null) respond(ex, 200, asset.type, asset.body)
    else respond(ex, 404, "text/plain; charset=utf-8", "404 page not found\n".toByteArray())
}

fun main() {
    val server = HttpServer.create(InetSocketAddress(8080), 0)
    server.executor = tasks
    server.createContext("/", ::handle)
    server.start()
}
