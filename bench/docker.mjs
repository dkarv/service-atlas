// Helpers around the Docker CLI and git. All containers run on the Docker host, next to this one.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGzip } from 'node:zlib';

export const SELF = 'service-atlas-bench'; // this container and its image, see run.sh
export const NET = 'sa-bench', APP = 'sa-bench-app', PROBE = 'sa-bench-probe', MOCK = 'sa-bench-mock';
const CERTS = 'sa-bench-certs'; // volume, mounted at /certs here
const SITES = 50; // must match bench/mock.mjs

export const log = msg => console.error(`[bench] ${msg}`);

export function run(cmd, args, { check = true } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (check && r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.error}`);
  return r.stdout;
}
export const docker = (...args) => run('docker', args);
// The repository is mounted read-only and owned by another user, hence safe.directory.
export const git = (...args) => run('git', ['--git-dir=/repo.git', '-c', 'safe.directory=*', ...args]);
export const rm = (...names) => run('docker', ['rm', '-f', ...names], { check: false });

// GET url with node:http: resolves to { status, type, body }, or null on errors and timeouts.
export function get(url, timeout = 1000) {
  return new Promise(resolve => {
    const req = http.get(url, { agent: false, timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

export async function waitFor(url, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) {
    if ((await get(url))?.status === 200) return;
  }
  throw new Error(`${url} did not answer with 200 within ${ms / 1000} s`);
}

// Builds the Dockerfile at the root of the ref, the context is the tree of that commit. Returns milliseconds.
export function build(impl, noCache) {
  const script = 'set -o pipefail; git --git-dir=/repo.git -c safe.directory="*" archive "$1" |' +
    ' docker build --progress=plain $2 -t "$3" - 2>&1';
  const start = performance.now();
  const r = spawnSync('sh', ['-c', script, 'sh', impl.ref, noCache ? '--no-cache' : '', impl.tag],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error(`Building ${impl.name} failed, end of the log:\n${r.stdout.trim().split('\n').slice(-40).join('\n')}`);
  }
  return performance.now() - start;
}

// Starts an implementation with an empty cache. SSL_CERT_FILE makes it trust the CA of the mock.
export function appArgs(impl, network) {
  return ['run', '-d', '--name', APP, '--network', network, '-v', `${CERTS}:/certs:ro`, '-e', 'SSL_CERT_FILE=/certs/ca.pem', impl.tag];
}
export async function startApp(impl) {
  rm(APP, PROBE);
  docker(...appArgs(impl, NET));
  // The probe shares the PID namespace of the app, so it can read /proc/1 even if the image has no shell.
  docker('run', '-d', '--name', PROBE, '--pid', `container:${APP}`, '--entrypoint', 'sleep', SELF, 'infinity');
  await waitFor(`http://${APP}:8080/`);
}

// Memory of the app in MB, e.g. VmRSS and VmHWM (peak RSS).
export function memory() {
  const status = docker('exec', PROBE, 'cat', '/proc/1/status');
  return Object.fromEntries(status.split('\n').filter(l => /^(Vm|Rss)/.test(l))
    .map(l => l.split(/:\s+/)).map(([key, value]) => [key, parseInt(value, 10) / 1024]));
}

// Size of the image filesystem in bytes, as tar and gzipped.
export async function imageSize(tag) {
  rm('sa-bench-size');
  docker('create', '--name', 'sa-bench-size', tag);
  let raw = 0, gzipped = 0;
  const exported = spawn('docker', ['export', 'sa-bench-size'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await pipeline(
    exported.stdout,
    async function* (source) { for await (const chunk of source) { raw += chunk.length; yield chunk; } },
    createGzip(),
    async function (source) { for await (const chunk of source) gzipped += chunk.length; },
  );
  rm('sa-bench-size');
  return { raw, gzipped };
}

// Network, CA and mock shared by all phases, plus a first build of every image that pulls the base images.
export function setup(impls) {
  teardown();
  docker('network', 'create', NET);
  docker('network', 'connect', NET, SELF);
  run('sh', ['-c', `cd /certs && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 \
    -keyout key.pem -out ca.pem -subj /CN=bench.test -addext subjectAltName=DNS:crt.sh,DNS:*.bench.test \
    -addext basicConstraints=critical,CA:TRUE 2>/dev/null && chmod 644 key.pem ca.pem`]);
  const aliases = ['crt.sh', ...Array.from({ length: SITES }, (_, i) => `s${i}.bench.test`)];
  docker('run', '-d', '--name', MOCK, '--network', NET, ...aliases.flatMap(a => ['--network-alias', a]),
    '-v', `${CERTS}:/certs:ro`, '--entrypoint', 'node', SELF, '/bench/mock.mjs');
  for (const impl of impls) {
    log(`Building ${impl.name}`);
    build(impl, false);
  }
  if (!docker('logs', MOCK).includes('mock ready')) throw new Error(`Mock failed:\n${docker('logs', MOCK)}`);
}

export function teardown() {
  rm(APP, PROBE, MOCK, 'sa-bench-size');
  run('docker', ['network', 'disconnect', '-f', NET, SELF], { check: false });
  run('docker', ['network', 'rm', NET], { check: false });
}
