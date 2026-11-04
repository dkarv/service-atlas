// Checks that don't measure performance: the HTTP contract, the API output and the lines of code.
import { APP, PROBE, git, log, rm, get, startApp } from './docker.mjs';

const FIELDS = ['status', 'error', 'name', 'description', 'favicon'];

// Starts each implementation and compares its API output with the one of the first implementation.
export async function diff(impls) {
  const results = {};
  let reference;
  for (const impl of impls) {
    log(`Diff: ${impl.name}`);
    await startApp(impl);
    const base = `http://${APP}:8080`;
    const problems = [];
    const expect = async (path, status, type) => {
      const res = await get(base + path, 300000);
      if (res?.status !== status || (type && !res.type?.startsWith(type))) {
        problems.push(`GET ${path}: expected ${status} ${type ?? ''}, got ${res?.status} ${res?.type ?? ''}`);
      }
      return res;
    };
    await expect('/', 200, 'text/html');
    await expect('/main.js', 200);
    await expect('/blades.min.css', 200, 'text/css');
    await expect('/not-found', 404);
    const api = await expect('/api/subdomains?domain=bench.test', 200);
    rm(APP, PROBE);

    let services = {};
    try {
      const data = JSON.parse(api.body);
      if (Number.isNaN(Date.parse(data.checked_at))) problems.push('checked_at is not a timestamp');
      // The error message is free text, only whether there is one has to match.
      for (const s of data.subdomains ?? []) services[s.host] = { ...s, error: Boolean(s.error) };
    } catch (e) {
      problems.push(`API response is not valid JSON: ${e.message}`);
    }
    const differences = [];
    if (reference) {
      const hosts = [...new Set([...Object.keys(reference), ...Object.keys(services)])].sort();
      for (const host of hosts) {
        for (const field of FIELDS) {
          const [a, b] = [reference[host]?.[field] ?? null, services[host]?.[field] ?? null];
          if (a !== b) differences.push({ host, field, reference: a, value: b });
        }
      }
    } else {
      reference = services;
    }
    results[impl.name] = { hosts: Object.keys(services).length, problems, differences };
  }
  return results;
}

// Lines of everything an implementation adds: hidden files, docs, the license and the shared frontend in static/
// don't count.
export function loc(impls) {
  const results = {};
  for (const impl of impls) {
    const files = git('ls-tree', '-r', '--name-only', impl.ref).split('\n')
      .filter(f => f && !/(^|\/)\./.test(f) && !/\.md$|^LICENSE|^static\//i.test(f))
      .map(path => ({ path, text: git('show', `${impl.ref}:${path}`) }))
      .filter(f => !f.text.includes('\0')) // binary
      .map(({ path, text }) => ({
        path,
        lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        chars: text.replace(/\s/g, '').length,
      }));
    results[impl.name] = {
      files,
      lines: files.reduce((sum, f) => sum + f.lines, 0),
      chars: files.reduce((sum, f) => sum + f.chars, 0),
    };
  }
  return results;
}
