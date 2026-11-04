import java.io.*
import java.net.URI
import java.net.http.*
import java.net.http.HttpResponse.BodyHandlers
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.*
import javax.net.ssl.*
import kotlin.time.Duration

/** Virtual threads for the HTTP server and client, like goroutines in the Go version. */
val tasks: ExecutorService = Executors.newVirtualThreadPerTaskExecutor()

val client: HttpClient = HttpClient.newBuilder()
    .followRedirects(HttpClient.Redirect.ALWAYS)
    .executor(tasks)
    .sslContext(sslContext())
    .build()

/** Requests [url] and hands the response to [read]. Runs as a task, because HttpRequest.timeout ends at the headers. */
fun <T> fetch(url: String, timeout: Duration, read: (HttpResponse<InputStream>) -> T): T {
    val task = tasks.submit(Callable {
        val response = client.send(HttpRequest.newBuilder(URI(url)).build(), BodyHandlers.ofInputStream())
        response.body().use { read(response) }
    })
    try {
        return task.get(timeout.inWholeMilliseconds, TimeUnit.MILLISECONDS)
    } catch (e: ExecutionException) {
        throw e.cause ?: e
    } finally {
        task.cancel(true)
    }
}

fun trustManagers(store: KeyStore?): Array<out TrustManager> =
    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }.trustManagers

/** Also trusts the CA certificates in SSL_CERT_FILE, e.g. of a private CA. Go does the same on Linux. */
fun sslContext(): SSLContext {
    val file = System.getenv("SSL_CERT_FILE") ?: return SSLContext.getDefault()
    val defaults = trustManagers(null).filterIsInstance<X509TrustManager>().flatMap { it.acceptedIssuers.asList() }
    val extra = File(file).inputStream().use { CertificateFactory.getInstance("X.509").generateCertificates(it) }
    val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) }
    (defaults + extra).forEachIndexed { i, cert -> store.setCertificateEntry("ca$i", cert) }
    return SSLContext.getInstance("TLS").apply { init(null, trustManagers(store), null) }
}
