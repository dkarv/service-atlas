<?php
// GET /api/subdomains?domain=<domain>[&refresh]: crt.sh lookup, service checks and cache.
// The Caddyfile routes the API here and serves the frontend itself.

use Uri\Rfc3986\Uri;

const TTL = 86400;      // subdomain list from crt.sh
const CHECK_TTL = 3600; // probe results
const MANIFEST_RE = '/<link[^>]+rel=["\']?manifest["\']?[^>]*>/is';
const ICON_RE = '/<link[^>]+rel=["\'][^"\']*icon[^"\']*["\'][^>]*>/is';
const HREF_RE = '/href=["\']([^"\']+)["\']/is';
const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

/** GETs all $urls at once, following redirects. Returns [status, body, final URL] or the RuntimeException of a failed
 * request for each URL, and keeps at most $limit bytes of each body. */
function fetchAll(array $urls, int $timeout, int $limit = PHP_INT_MAX): array
{
    $mh = curl_multi_init();
    $handles = $bodies = $results = [];
    // libcurl ignores SSL_CERT_FILE. Like Go, trust its CA certificates in addition to the system ones.
    $ca = ($file = getenv('SSL_CERT_FILE')) ? [CURLOPT_CAINFO => $file, CURLOPT_CAPATH => '/etc/ssl/certs'] : [];
    foreach ($urls as $i => $url) {
        $bodies[$i] = '';
        curl_multi_add_handle($mh, $handles[$i] = curl_init($url));
        curl_setopt_array($handles[$i], $ca + [
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 10,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_ENCODING => '', // accept gzip and the like, as Go does
            CURLOPT_USERAGENT => 'service-atlas',
            // A page must not make us read file:// or other local URLs.
            CURLOPT_PROTOCOLS_STR => 'http,https', CURLOPT_REDIR_PROTOCOLS_STR => 'http,https',
            // Stops the download at $limit bytes: returning less than the chunk length aborts it.
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$bodies, $i, $limit): int {
                $bodies[$i] .= substr($chunk, 0, $limit - strlen($bodies[$i]));
                return strlen($bodies[$i]) < $limit ? strlen($chunk) : 0;
            },
        ]);
    }
    while (curl_multi_exec($mh, $running) === CURLM_OK && $running) curl_multi_select($mh);
    while ($info = curl_multi_info_read($mh)) {
        $results[spl_object_id($info['handle'])] = $info['result'];
    }
    foreach ($handles as $i => $ch) {
        // curl adds a / to an empty path, Go keeps the URL as requested unless redirected.
        $final = curl_getinfo($ch, CURLINFO_REDIRECT_COUNT) ? curl_getinfo($ch, CURLINFO_EFFECTIVE_URL) : $urls[$i];
        $handles[$i] = in_array($results[spl_object_id($ch)], [CURLE_OK, CURLE_WRITE_ERROR], true)
            ? [curl_getinfo($ch, CURLINFO_RESPONSE_CODE), $bodies[$i], $final] : new RuntimeException(curl_error($ch));
    }
    return $handles;
}

/** Lists the subdomains in the CT logs with the date of their latest certificate. */
function fetchSubdomains(string $domain): array
{
    $res = fetchAll(['https://crt.sh/?output=json&q=' . rawurlencode("%.$domain")], 20)[0];
    $certs = is_array($res) ? json_decode($res[1], true, flags: JSON_THROW_ON_ERROR) : throw $res;
    is_array($certs) || throw new RuntimeException('unexpected crt.sh response');
    $latest = [];
    foreach ($certs as $c) foreach (preg_split('/\s+/', strtolower($c['name_value'] ?? '')) as $name) {
        // ISO timestamps compare as strings, strcmp avoids PHP's numeric comparison.
        $issued = (string) ($c['not_before'] ?? '');
        if (str_ends_with($name, ".$domain") && $name[0] !== '*' && strcmp($issued, $latest[$name] ?? '') > 0) {
            $latest[$name] = $issued;
        }
    }
    return array_map(fn($h, $i) => ['host' => (string) $h, 'issued' => $i], array_keys($latest), $latest);
}

/** Resolves an href against $base like Go's net/url: HTML entities decoded, disallowed bytes such as spaces escaped. */
function resolve(string $href, string $base): ?string
{
    $href = html_entity_decode($href, ENT_QUOTES | ENT_HTML5);
    $href = preg_replace_callback('/[^\w.~:\/?#\[\]@!$&\'()*+,;=%-]/', fn($m) => rawurlencode($m[0]), $href);
    return Uri::parse($href, Uri::parse($base))?->toRawString();
}

/** Requests https://host of all services at once, extracts favicon and web app manifest name and description. */
function probe(array $services): array
{
    $pages = fetchAll(array_map(fn($s) => "https://{$s['host']}", $services), 5, 1 << 20);
    $links = [];
    foreach ($services as $i => ['host' => $host, 'issued' => $issued]) {
        $s = compact('host', 'issued') + ['status' => 0, 'error' => null, 'name' => null, 'description' => null];
        if ($pages[$i] instanceof RuntimeException) {
            $s['error'] = $pages[$i]->getMessage();
        } else {
            // Links are resolved against the final URL, since the request may have been redirected.
            [$s['status'], $body, $url] = $pages[$i];
            if (preg_match(ICON_RE, $body, $tag) && preg_match(HREF_RE, $tag[0], $href)) {
                $s['favicon'] = resolve($href[1], $url);
            }
            if (preg_match(MANIFEST_RE, $body, $tag) && preg_match(HREF_RE, $tag[0], $href)) {
                $links[$i] = resolve($href[1], $url);
            }
        }
        $services[$i] = $s;
    }
    // A failed manifest only loses the manifest.
    foreach (fetchAll(array_filter($links), 5) as $i => $res) {
        $manifest = is_array($res) ? json_decode($res[1], true) : null;
        // Go matches JSON keys case-insensitively.
        $manifest = is_array($manifest) ? array_change_key_case($manifest) : [];
        $services[$i]['name'] = is_string($manifest['name'] ?? null) ? $manifest['name'] : null;
        $services[$i]['description'] = is_string($manifest['description'] ?? null) ? $manifest['description'] : null;
    }
    return array_map(fn($s) => array_filter($s, fn($v) => $v !== null && $v !== ''), $services); // like omitempty
}

function age(?string $time): float
{
    return microtime(true) - ($time ? (float) date_create($time)?->format('U.u') : 0);
}

/** Returns the probed subdomains of $domain, refreshing outdated parts of the cache. */
function getServices(string $domain, bool $refresh): array
{
    // basename keeps the domain from escaping the cache directory.
    $dir = dirname(__DIR__) . '/cache';
    $file = $dir . '/' . basename($domain) . '.json';
    $e = json_decode(@file_get_contents($file) ?: '{}', true)
        ?: ['fetched_at' => '0001-01-01T00:00:00Z', 'checked_at' => null]; // Go's zero time without a cache file
    if ($refresh || age($e['fetched_at'] ?? null) > TTL) {
        // On errors keep the cached list, crt.sh is flaky.
        try {
            $e = ['fetched_at' => date_create()->format(DATE_RFC3339_EXTENDED), 'checked_at' => null,
                'subdomains' => fetchSubdomains($domain)];
        } catch (Exception) {}
    }
    if ($refresh || age($e['checked_at'] ?? null) > CHECK_TTL) {
        $e['subdomains'] = probe($e['subdomains'] ?? []);
        $e['checked_at'] = date_create()->format(DATE_RFC3339_EXTENDED);
        // Written to a temporary file and renamed, so concurrent requests never read a partial file.
        @mkdir($dir, 0o755);
        $tmp = tempnam($dir, 'tmp');
        file_put_contents($tmp, json_encode($e, JSON_FLAGS));
        rename($tmp, $file);
    }
    return $e;
}

// Probing all services takes longer than PHP's default limits allow.
set_time_limit(0);
ini_set('memory_limit', '-1');
$domain = is_string($_GET['domain'] ?? null) ? strtolower($_GET['domain']) : '';
header('Content-Type: application/json');
echo json_encode(getServices($domain, isset($_GET['refresh'])), JSON_FLAGS);
