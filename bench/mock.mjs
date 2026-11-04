// HTTPS mock of crt.sh and the *.bench.test sites, so runs are repeatable and don't depend on the internet.
// SITES must match bench/docker.mjs, which gives the mock a network alias per site.
import fs from 'node:fs';
import https from 'node:https';

const SITES = 50, ROWS = 20000; // reachable sites, crt.sh rows
const hostOf = i => `s${i}.bench.test`;

// A busy domain: many certificates, with fields the service has to skip. dead*: never resolves.
const rows = Array.from({ length: ROWS }, (_, n) => ({
  issuer_ca_id: 183267,
  issuer_name: "C=US, O=Let's Encrypt, CN=R11",
  common_name: hostOf(n % SITES),
  name_value: `${hostOf(n % SITES)}\n*.bench.test\nDEAD${n % 5}.bench.test`,
  id: 15000000000 + n,
  entry_timestamp: `2026-10-${String(1 + n % 28).padStart(2, '0')}T08:00:00.000`,
  not_before: `2026-10-${String(1 + n % 28).padStart(2, '0')}T07:00:00`,
  not_after: '2027-01-01T07:00:00',
  serial_number: n.toString(16).padStart(36, '0'),
}));
const crt = JSON.stringify(rows);

// Every way of writing a link that the parsers have to agree on, cycled over the sites.
const icons = [
  `<link rel="icon" href="favicon.ico">`,
  `<link rel="shortcut icon" href="/a/b.png">`,
  `<LINK REL='ICON' HREF='../up.png'>`,
  `<link rel="icon" href="//cdn.bench.test/i.ico">`,
  `<link href="https://abs.bench.test/x.svg" rel="icon" type="image/svg+xml">`,
  `<link rel="icon" href="i.png?a=1&amp;b=2">`,
  `<link rel="icon" href="my icon.png">`,
  `<link rel="icon" href="?v=1">`,
  `<link rel="icon" href="data:image/png;base64,AAAA">`,
  `<link rel="apple-touch-icon"\n  sizes="180x180"\n  href="touch.png">`,
  `<link rel="stylesheet" href="no-icon.css">`,
];
const manifests = [
  `<link rel="manifest" href="/manifest.json">`,
  `<link rel=manifest href="site.webmanifest">`,
  `<link rel="manifest" href="/broken.json">`,
  `<link rel="manifest" href="/missing.json">`,
  `<link rel="manifest" href="/empty.json">`,
  ``,
];

function page(host, i) {
  const filler = '<p>lorem ipsum dolor sit amet</p>'.repeat(1500); // about 50 KB, typical homepage
  return `<!doctype html><html><head><title>${host}</title>${icons[i % icons.length]}
    ${manifests[i % manifests.length]}</head><body>${filler}</body></html>`;
}

const manifest = host => JSON.stringify({
  name: `App ${host}`, short_name: 'App', description: `Grüße from ${host}`, icons: [{ src: 'i.png', sizes: '192x192' }],
});

const server = https.createServer({
  key: fs.readFileSync('/certs/key.pem'), cert: fs.readFileSync('/certs/ca.pem'),
}, (req, res) => {
  const host = (req.headers.host || '').split(':')[0], { pathname } = new URL(req.url, 'https://x');
  const send = (status, type, body) => res.writeHead(status, { 'content-type': type }).end(body);
  if (host === 'crt.sh') return send(200, 'application/json', crt);
  const i = Number(host.match(/^s(\d+)\./)?.[1] ?? 0);
  if (pathname === '/manifest.json' || pathname.endsWith('.webmanifest')) return send(200, 'application/json', manifest(host));
  if (pathname === '/broken.json') return send(200, 'application/json', '{"name": "half');
  if (pathname === '/empty.json') return send(200, 'application/json', '{"name": "", "description": null}');
  if (pathname === '/missing.json') return send(404, 'text/plain', 'nope');
  if (i % 7 === 3 && pathname === '/') return res.writeHead(302, { location: '/deep/er/home' }).end();
  if (i % 7 === 4 && pathname === '/') return res.writeHead(301, { location: `https://${hostOf(i)}/next/` }).end();
  if (i % 10 === 9) return send(503, 'text/html', page(host, i));
  send(200, 'text/html; charset=utf-8', page(host, i));
});
server.listen(443, () => console.log(`mock ready: ${SITES} sites, ${(crt.length / 1e6).toFixed(1)} MB crt.sh response`));
