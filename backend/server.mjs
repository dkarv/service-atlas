// service-atlas on Node.js: crt.sh lookup, service checks, cache, API and the static frontend. No dependencies.
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import tls from 'node:tls';

const TTL = 24 * 3600e3;    // subdomain list from crt.sh
const CHECK_TTL = 3600e3;   // probe results
const MANIFEST_RE = /<link[^>]+rel=["']?manifest["']?[^>]*>/is;
const ICON_RE = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/is;
const HREF_RE = /href=["']([^"']+)["']/is;
const CACHE = new URL('../cache/', import.meta.url);
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };

// The frontend is read once at startup, so only these files can be served.
const frontend = new URL('../frontend/', import.meta.url);
const files = new Map(readdirSync(frontend).map(f => [`/${f}`,
  { body: readFileSync(new URL(f, frontend)), type: TYPES[f.split('.').pop()] ?? 'application/octet-stream' }]));
files.set('/', files.get('/index.html'));

// Like Go, trust the CA certificates in SSL_CERT_FILE in addition to the default ones.
if (process.env.SSL_CERT_FILE) {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(process.env.SSL_CERT_FILE, 'utf8')]);
}

/** GET url, following redirects. Keeps at most limit bytes of the body, which Go reads as bytes too. */
async function get(url, timeout, limit = Infinity) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'service-atlas' } });
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    chunks.push(chunk);
    if ((size += chunk.length) >= limit) break; // leaving the loop cancels the download
  }
  return { status: res.status, body: Buffer.concat(chunks).subarray(0, limit).toString(), url: res.url };
}

/** Lists the subdomains in the CT logs with the date of their latest certificate. */
async function fetchSubdomains(domain) {
  const { body } = await get('https://crt.sh/?output=json&q=' + encodeURIComponent(`%.${domain}`), 20e3);
  const certs = JSON.parse(body);
  if (!Array.isArray(certs)) throw new Error('unexpected crt.sh response');
  const latest = new Map();
  for (const c of certs) for (const name of String(c?.name_value ?? '').toLowerCase().split(/\s+/)) {
    // ISO timestamps compare as strings.
    const issued = String(c?.not_before ?? '');
    if (name.endsWith(`.${domain}`) && !name.startsWith('*') && issued > (latest.get(name) ?? '')) latest.set(name, issued);
  }
  return [...latest].map(([host, issued]) => ({ host, issued }));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => e[0] !== '#' ? ENTITIES[e.toLowerCase()] ?? m
  : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));

/** Resolves an href against base. WHATWG URLs add a / to an empty path, Go keeps the base as requested. */
function resolve(href, base) {
  href = unescape(href);
  try {
    if (/^[?#]/.test(href) && /^https?:\/\/[^/?#]+$/i.test(base)) return new URL(base + href).href.replace(/\/(?=[?#])/, '');
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

/** Requests https://host and extracts its favicon and web app manifest name and description. */
async function probe({ host, issued }) {
  const s = { host, issued, status: 0 };
  try {
    const res = await get(`https://${host}`, 5e3, 1 << 20);
    // Links are resolved against the final URL, since the request may have been redirected. fetch only
    // adds a / to the URL when it wasn't, so the URL as requested is the base then.
    const base = res.url === `https://${host}/` ? `https://${host}` : res.url;
    s.status = res.status;
    const icon = res.body.match(ICON_RE)?.[0].match(HREF_RE);
    if (icon) s.favicon = resolve(icon[1], base);
    const link = res.body.match(MANIFEST_RE)?.[0].match(HREF_RE);
    const url = link && resolve(link[1], base);
    if (url) {
      try {
        // Go matches JSON keys case-insensitively and leaves fields of other types empty.
        const manifest = Object.entries(JSON.parse((await get(url, 5e3)).body) ?? {});
        const field = key => manifest.findLast(([k, v]) => k.toLowerCase() === key && typeof v === 'string')?.[1];
        s.name = field('name');
        s.description = field('description');
      } catch {} // a failed manifest only loses the manifest
    }
  } catch (e) {
    s.error = e.cause?.message ?? e.message;
  }
  // Like Go's omitempty.
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''));
}

const age = time => Date.now() - (Date.parse(time) || 0);

/** Returns the probed subdomains of domain, refreshing outdated parts of the cache. */
async function getServices(domain, refresh) {
  // basename keeps the domain from escaping the cache directory.
  const file = new URL(`${basename(domain)}.json`, CACHE);
  // Without a cache file, fetched_at is Go's zero time.
  let e = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({ fetched_at: '0001-01-01T00:00:00Z' }));
  if (refresh || age(e.fetched_at) > TTL) {
    // On errors keep the cached list, crt.sh is flaky.
    const fetched_at = new Date().toISOString();
    e = await fetchSubdomains(domain).then(subdomains => ({ fetched_at, checked_at: null, subdomains }), () => e);
  }
  if (refresh || age(e.checked_at) > CHECK_TTL) {
    const subdomains = await Promise.all((e.subdomains ?? []).map(probe));
    e = { ...e, checked_at: new Date().toISOString(), subdomains };
    // Written to a temporary file and renamed, so concurrent requests never read a partial file.
    await mkdir(CACHE, { recursive: true });
    const tmp = new URL(`${basename(domain)}.json.${process.pid}.${Math.random()}`, CACHE);
    await writeFile(tmp, JSON.stringify(e));
    await rename(tmp, file);
  }
  return e;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/subdomains') {
    try {
      const e = await getServices((url.searchParams.get('domain') ?? '').toLowerCase(), url.searchParams.has('refresh'));
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(e));
    } catch (err) {
      // E.g. a cache directory that isn't writable. Unhandled, it would stop the whole process.
      console.error(err);
      return res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error\n');
    }
  }
  const file = files.get(url.pathname);
  if (!file) return res.writeHead(404, { 'content-type': 'text/plain' }).end('404 page not found\n');
  res.writeHead(200, { 'content-type': file.type }).end(file.body);
}).listen(8080);
// As PID 1 in a container Node gets no default handler for SIGTERM.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit());
