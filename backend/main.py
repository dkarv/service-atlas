# service-atlas in Python: crt.sh lookup, service checks, cache, API and the static frontend. Only the standard library.
import json, os, re, signal, sys, time
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import datetime, timezone
from functools import partial
from html import unescape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from string import punctuation
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urljoin, urlsplit
from urllib.request import urlopen

TTL, CHECK_TTL = 24 * 3600, 3600  # subdomain list from crt.sh, probe results
MANIFEST_RE = re.compile(r"""<link[^>]+rel=["']?manifest["']?[^>]*>""", re.I | re.S)
ICON_RE = re.compile(r"""<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>""", re.I | re.S)
HREF_RE = re.compile(r"""href=["']([^"']+)["']""", re.I | re.S)
FRONTEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")


def get(url, timeout, limit=-1):
    """GET url, following redirects. Returns the response and at most limit bytes of the body, also for 4xx and 5xx."""
    try:
        r = urlopen(url, timeout=timeout)
    except HTTPError as e:
        r = e
    with r:
        return r, r.read(limit)


def fetch_subdomains(domain):
    """Lists the subdomains in the CT logs with the date of their latest certificate."""
    latest = {}
    for c in json.loads(get("https://crt.sh/?output=json&q=" + quote("%." + domain), 20)[1]):
        for name in c.get("name_value", "").lower().split():
            # ISO timestamps compare as strings.
            if name.endswith("." + domain) and not name.startswith("*") and c.get("not_before", "") > latest.get(name, ""):
                latest[name] = c["not_before"]
    return [{"host": host, "issued": issued} for host, issued in latest.items()]


def link(tag, body, base):
    """The href of the first tag, resolved against base like Go: spaces and non-ASCII are escaped."""
    if (m := tag.search(body)) and (href := HREF_RE.search(m[0])):
        return urljoin(base, quote(unescape(href[1]), safe=punctuation))


def probe(s):
    """Requests https://host and extracts its favicon and web app manifest name and description."""
    s = {"host": s["host"], "issued": s["issued"], "status": 0}
    try:
        r, body = get("https://" + s["host"], 5, 1 << 20)
    except Exception as e:
        return {**s, "error": str(getattr(e, "reason", e))}
    s["status"], body = r.status, body.decode(errors="replace")
    # Links are resolved against the final URL, since the request may have been redirected.
    s["favicon"] = link(ICON_RE, body, r.url)
    if url := link(MANIFEST_RE, body, r.url):
        with suppress(Exception):  # a failed manifest only loses the manifest
            r, data = get(url, 5)
            if r.status < 400:
                # Go matches JSON keys case-insensitively and leaves fields of other types empty.
                manifest = {k.lower(): v for k, v in json.loads(data).items() if isinstance(v, str)}
                s["name"], s["description"] = manifest.get("name"), manifest.get("description")
    return {k: v for k, v in s.items() if v not in (None, "")}  # like Go's omitempty


def old(timestamp, ttl):
    try:
        return time.time() - datetime.fromisoformat(timestamp).timestamp() > ttl
    except (TypeError, ValueError):
        return True


def get_services(domain, refresh):
    """Returns the probed subdomains of domain, refreshing outdated parts of the cache."""
    # basename keeps the domain from escaping the cache directory.
    file = os.path.join("cache", os.path.basename(domain) + ".json")
    e = {"fetched_at": "0001-01-01T00:00:00Z", "checked_at": None, "subdomains": []}
    with suppress(OSError, ValueError):
        with open(file) as f:
            e = json.load(f)
    if refresh or old(e.get("fetched_at"), TTL):
        # On errors keep the cached list, crt.sh is flaky.
        with suppress(Exception):
            e = {"fetched_at": datetime.now(timezone.utc).isoformat(), "checked_at": None, "subdomains": fetch_subdomains(domain)}
    if refresh or old(e.get("checked_at"), CHECK_TTL):
        with ThreadPoolExecutor(64) as pool:
            e["subdomains"] = list(pool.map(probe, e.get("subdomains") or []))
        e["checked_at"] = datetime.now(timezone.utc).isoformat()
        with suppress(OSError):
            os.makedirs("cache", exist_ok=True)
            with open(file, "w") as f:
                json.dump(e, f)
    return e


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive, every response has a Content-Length

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path != "/api/subdomains":
            return super().do_GET()
        q = parse_qs(url.query, keep_blank_values=True)
        body = json.dumps(get_services(q.get("domain", [""])[0].lower(), "refresh" in q)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # no access log, like Go
        pass


# As PID 1 in a container Python gets no default handler for SIGTERM.
signal.signal(signal.SIGTERM, lambda *_: sys.exit())
ThreadingHTTPServer(("", 8080), partial(Handler, directory=FRONTEND)).serve_forever()
