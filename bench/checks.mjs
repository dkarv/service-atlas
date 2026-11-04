// Checks that don't measure performance: the HTTP contract, the API output and the lines of code.
import { readFileSync } from 'node:fs';
import { APP, PROBE, git, log, rm, get, startApp } from './docker.mjs';

const FIELDS = ['status', 'error', 'name', 'description', 'favicon'];
// The API output of main for the mock, by host. See "Expected API output" in the README.
const EXPECTED = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8'));

// Starts each implementation, checks the HTTP contract and compares its API output field by field with EXPECTED.
export async function diff(impls) {
  const results = {};
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

    const output = {};
    try {
      const data = JSON.parse(api.body);
      if (Number.isNaN(Date.parse(data.checked_at))) problems.push('checked_at is not a timestamp');
      // The error message is free text, only whether there is one has to match.
      for (const s of data.subdomains ?? []) {
        output[s.host] = Object.fromEntries(FIELDS.map(f => [f, f === 'error' ? Boolean(s.error) : s[f] ?? null]));
      }
    } catch (e) {
      problems.push(`API response is not valid JSON: ${e.message}`);
    }
    const sorted = Object.fromEntries(Object.keys(output).sort().map(host => [host, output[host]]));
    // Differences the branch lists as intended are only reported. A listed one that doesn't occur is a problem.
    const accepted = intended(impl), found = differences(sorted);
    const matches = (a, d) => a.host === d.host && a.field === d.field && a.value === d.value;
    for (const a of accepted.filter(a => !found.some(d => matches(a, d)))) {
      problems.push(`${INTENDED} lists ${a.host} ${a.field} ${JSON.stringify(a.value)}, but the output differs from that`);
    }
    results[impl.name] = {
      hosts: Object.keys(output).length, problems, output: sorted,
      differences: found.filter(d => !accepted.some(a => matches(a, d))),
      intended: found.filter(d => accepted.some(a => matches(a, d))),
    };
  }
  return results;
}

// Differences from EXPECTED that a branch accepts on purpose, see "Expected API output" in the README.
const INTENDED = '.bench-differences.json';
function intended(impl) {
  if (!git('ls-tree', '--name-only', impl.ref, INTENDED).trim()) return [];
  return JSON.parse(git('show', `${impl.ref}:${INTENDED}`));
}

function differences(output) {
  const found = [];
  for (const host of [...new Set([...Object.keys(EXPECTED), ...Object.keys(output)])].sort()) {
    for (const field of FIELDS) {
      const [expected, value] = [EXPECTED[host]?.[field] ?? null, output[host]?.[field] ?? null];
      if (expected !== value) found.push({ host, field, expected, value });
    }
  }
  return found;
}

// Throws unless every implementation passed the HTTP contract and returned the expected or intended API output.
export function verify(results) {
  const failed = Object.entries(results).flatMap(([name, { problems, differences }]) => [
    ...problems.map(p => `${name}: ${p}`),
    ...differences.map(d => `${name}: ${d.host} ${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.value)}`),
  ]);
  if (failed.length) throw new Error(`Unexpected HTTP responses or API output:\n${failed.join('\n')}`);
}

// Lines of the code in backend/, where every implementation keeps all of its code, and of the Dockerfile.
// Docs and hidden files don't count.
export function loc(impls) {
  const results = {};
  for (const impl of impls) {
    const files = git('ls-tree', '-r', '--name-only', impl.ref, 'backend/', 'Dockerfile').split('\n')
      .filter(f => f && !/(^|\/)\./.test(f) && !/\.md$/i.test(f))
      .map(path => ({ path, text: git('show', `${impl.ref}:${path}`) }))
      .filter(f => !f.text.includes('\0')) // binary
      .map(({ path, text }) => ({
        path,
        lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        chars: text.replace(/\s/g, '').length,
      }));
    results[impl.name] = {
      lines: files.reduce((sum, f) => sum + f.lines, 0),
      chars: files.reduce((sum, f) => sum + f.chars, 0),
    };
  }
  return results;
}
