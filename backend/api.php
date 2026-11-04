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

/** GET $url, following redirects. Returns [status, body, final URL] and keeps at most $limit bytes of the body. */
function fetch(string $url, int $timeout, int $limit = PHP_INT_MAX): array
{
    $body = '';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 10,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_ENCODING => '', // accept gzip and the like, as Go does
        CURLOPT_USERAGENT => 'service-atlas',
        // A page must not make us read file:// or other local URLs.
        CURLOPT_PROTOCOLS_STR => 'http,https',
        CURLOPT_REDIR_PROTOCOLS_STR => 'http,https',
        // Stops the download at $limit bytes: returning less than the chunk length aborts it.
        CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, $limit): int {
            $body .= substr($chunk, 0, $limit - strlen($body));
            return strlen($body) < $limit ? strlen($chunk) : 0;
        },
    ]);
    // libcurl ignores SSL_CERT_FILE. Like Go, trust its CA certificates in addition to the system ones.
    if ($file = getenv('SSL_CERT_FILE')) {
        curl_setopt_array($ch, [CURLOPT_CAINFO => $file, CURLOPT_CAPATH => '/etc/ssl/certs']);
    }
    if (!curl_exec($ch) && curl_errno($ch) !== CURLE_WRITE_ERROR) {
        throw new RuntimeException(curl_error($ch));
    }
    // curl adds a / to an empty path, Go keeps the URL as requested unless redirected.
    $final = curl_getinfo($ch, CURLINFO_REDIRECT_COUNT) ? curl_getinfo($ch, CURLINFO_EFFECTIVE_URL) : $url;
    return [curl_getinfo($ch, CURLINFO_RESPONSE_CODE), $body, $final];
}

/** Lists the subdomains in the CT logs with the date of their latest certificate. */
function fetchSubdomains(string $domain): array
{
    [, $body] = fetch('https://crt.sh/?output=json&q=' . rawurlencode("%.$domain"), 20);
    $certs = json_decode($body, true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($certs)) {
        throw new RuntimeException('unexpected crt.sh response');
    }
    $latest = [];
    foreach ($certs as $c) {
        $issued = (string) ($c['not_before'] ?? '');
        foreach (preg_split('/\s+/', strtolower($c['name_value'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) as $name) {
            // ISO timestamps compare as strings, strcmp avoids PHP's numeric comparison.
            if (str_ends_with($name, ".$domain") && $name[0] !== '*' && strcmp($issued, $latest[$name] ?? '') > 0) {
                $latest[$name] = $issued;
            }
        }
    }
    $services = [];
    foreach ($latest as $host => $issued) {
        $services[] = ['host' => (string) $host, 'issued' => $issued];
    }
    return $services;
}

/** Resolves an href against $base like Go's net/url: HTML entities decoded, disallowed bytes such as spaces escaped. */
function resolve(string $href, string $base): ?string
{
    $href = html_entity_decode($href, ENT_QUOTES | ENT_HTML5);
    $href = preg_replace_callback('/[^\w.~:\/?#\[\]@!$&\'()*+,;=%-]/', fn($m) => rawurlencode($m[0]), $href);
    return Uri::parse($href, Uri::parse($base))?->toRawString();
}

/** Requests https://host and extracts its favicon and web app manifest name and description. */
function probe(array $s): array
{
    $s = ['host' => $s['host'], 'issued' => $s['issued'], 'status' => 0,
        'error' => null, 'name' => null, 'description' => null, 'favicon' => null];
    try {
        // Links are resolved against the final URL, since the request may have been redirected.
        [$s['status'], $body, $url] = fetch("https://{$s['host']}", 5, 1 << 20);
        if (preg_match(ICON_RE, $body, $tag) && preg_match(HREF_RE, $tag[0], $href)) {
            $s['favicon'] = resolve($href[1], $url);
        }
        if (preg_match(MANIFEST_RE, $body, $tag) && preg_match(HREF_RE, $tag[0], $href)) {
            $manifest = ($link = resolve($href[1], $url)) ? json_decode(fetch($link, 5)[1], true) : null;
            // Go matches JSON keys case-insensitively.
            $manifest = is_array($manifest) ? array_change_key_case($manifest) : [];
            $s['name'] = is_string($manifest['name'] ?? null) ? $manifest['name'] : null;
            $s['description'] = is_string($manifest['description'] ?? null) ? $manifest['description'] : null;
        }
    } catch (RuntimeException $e) {
        $s['error'] ??= $s['status'] ? null : $e->getMessage(); // a failed manifest only loses the manifest
    }
    return array_filter($s, fn($v) => $v !== null && $v !== ''); // like omitempty
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
    $e = json_decode(@file_get_contents($file) ?: '{}', true) ?: [];
    if ($refresh || age($e['fetched_at'] ?? null) > TTL) {
        // On errors keep the cached list, crt.sh is flaky.
        try {
            $e = ['fetched_at' => date_create()->format(DATE_RFC3339_EXTENDED), 'checked_at' => null,
                'services' => fetchSubdomains($domain)];
        } catch (Exception) {
        }
    }
    if ($refresh || age($e['checked_at'] ?? null) > CHECK_TTL) {
        $e['services'] = array_map(probe(...), $e['services'] ?? []);
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
$e = getServices($domain, isset($_GET['refresh']));
header('Content-Type: application/json');
echo json_encode(['subdomains' => $e['services'] ?? [], 'checked_at' => $e['checked_at']], JSON_FLAGS);
