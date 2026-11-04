// Measurements: image size, build time, startup time, memory and throughput.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP, PROBE, SELF, appArgs, build as buildImage, docker, get, imageSize, log, memory, rm, run, startApp } from './docker.mjs';

export const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
// Median of every field over the runs.
const medians = runs => Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(runs.map(r => r[key]))]));

export async function size(impls) {
  const results = {};
  for (const impl of impls) results[impl.name] = await imageSize(impl.tag);
  return results;
}

// Uncached builds, base images are already pulled by the setup. Interleaved, so drift hits all alike.
// Builds download their dependencies, so a failed build is retried once. Only successful builds are timed.
export function build(impls, { runs }) {
  const times = Object.fromEntries(impls.map(impl => [impl.name, []]));
  for (let i = 1; i <= runs; i++) {
    for (const impl of impls) {
      log(`Build ${i}/${runs}: ${impl.name}`);
      try {
        times[impl.name].push(buildImage(impl, true));
      } catch (e) {
        log(`${e.message}\nRetrying once`);
        times[impl.name].push(buildImage(impl, true));
      }
    }
  }
  return Object.fromEntries(impls.map(impl => [impl.name, { ms: median(times[impl.name]), all: times[impl.name] }]));
}

const now = () => performance.timeOrigin + performance.now();

// Time from the start of the process (.State.StartedAt) until the first 200 on /.
// The app joins the network namespace of this container: a closed port refuses at once, so polling is exact.
// Both clocks are the one of the Docker host, as this container runs there too.
export async function startup(impls, { startupRuns }) {
  const results = {};
  for (const impl of impls) {
    const samples = [];
    log(`Startup: ${impl.name}`);
    for (let i = 0; i < startupRuns; i++) {
      rm(APP);
      const started = spawn('docker', appArgs(impl, `container:${SELF}`), { stdio: 'ignore' });
      const exited = new Promise(resolve => started.on('close', resolve));
      let ready;
      for (const end = now() + 60000; !ready && now() < end; await sleep(1)) {
        if ((await get('http://127.0.0.1:8080/', 200))?.status === 200) ready = now();
      }
      if ((await exited) !== 0 || !ready) throw new Error(`${impl.name} did not start`);
      const startedAt = docker('inspect', '--format', '{{.State.StartedAt}}', APP).trim();
      // Date.parse keeps milliseconds only, the timestamp has nanoseconds.
      const fraction = Number(`0.${(startedAt.match(/\.\d{3}(\d+)/)?.[1] ?? '0')}`);
      samples.push({ fromStart: ready - Date.parse(startedAt) - fraction });
    }
    rm(APP);
    results[impl.name] = medians(samples);
  }
  return results;
}

function wrk(args) {
  const out = run('wrk', args);
  // wrk counts requests still open at the end as timeouts, so only connect, read and write errors count.
  const socket = out.match(/Socket errors: connect (\d+), read (\d+), write (\d+)/);
  if (/Non-2xx or 3xx responses/.test(out) || socket?.slice(1).some(n => n !== '0')) {
    throw new Error(`wrk ${args.join(' ')} reported errors:\n${out}`);
  }
  return { rps: Number(out.match(/Requests\/sec:\s+([\d.]+)/)[1]) };
}

// Per run and implementation: 3 s idle, 5 full refreshes, 15 s static file, 15 s cached API.
// The API gets a single connection: implementations may rewrite their cache per request, like the Go original.
// Each throughput test follows a discarded 5 s pass, so JIT compilers measure warm. RAM peak includes it.
function warmWrk(flags, url) {
  wrk([...flags, '-d5s', url]);
  return wrk([...flags, '-d15s', url]);
}
export async function load(impls, { runs }) {
  const samples = Object.fromEntries(impls.map(impl => [impl.name, []]));
  for (let i = 1; i <= runs; i++) {
    for (const impl of impls) {
      log(`Load ${i}/${runs}: ${impl.name}`);
      await startApp(impl);
      const base = `http://${APP}:8080`;
      await sleep(3000);
      const idle = memory().VmRSS;
      for (let n = 0; n < 5; n++) {
        const res = await get(`${base}/api/subdomains?domain=bench.test&refresh=1`, 300000);
        if (res?.status !== 200) throw new Error(`${impl.name}: refresh failed with ${res?.status}`);
      }
      const statics = warmWrk(['-t4', '-c64'], `${base}/blades.min.css`);
      const api = warmWrk(['-t1', '-c1'], `${base}/api/subdomains?domain=bench.test`);
      samples[impl.name].push({ idle, peak: memory().VmHWM, staticRps: statics.rps, apiRps: api.rps });
      rm(APP, PROBE);
    }
  }
  return Object.fromEntries(impls.map(impl => [impl.name, medians(samples[impl.name])]));
}
