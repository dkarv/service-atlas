import com.sun.net.httpserver.*
import java.net.*

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
        return respond(ex, 200, "application/json", json.encodeToString(entry).toByteArray())
    }
    val asset = assets[if (path == "/") "/index.html" else path]
    if (asset != null) respond(ex, 200, asset.type, asset.body)
    else respond(ex, 404, "text/plain; charset=utf-8", "404 page not found\n".toByteArray())
}

fun main() {
    HttpServer.create(InetSocketAddress(8080), 0).apply { executor = tasks; createContext("/", ::handle); start() }
}
