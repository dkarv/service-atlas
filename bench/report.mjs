// Renders the results as Markdown, with every value also relative to the first implementation.
import { docker } from './docker.mjs';

const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;
const fixed = digits => value => value.toFixed(digits);
const thousands = value => Math.round(value).toLocaleString('en-US');

// [label, phase, value of a result, format, true if higher is better]
const ROWS = [
  ['**Image size**, filesystem', 'size', r => r.raw, mb],
  ['Image size, gzipped', 'size', r => r.gzipped, mb],
  ['**Build time**, uncached', 'build', r => r.ms / 1000, v => `${v.toFixed(1)} s`],
  ['**Startup**, process start to first 200', 'startup', r => r.fromStart, v => `${v.toFixed(0)} ms`],
  ['Startup, `docker run` to first 200', 'startup', r => r.fromRun, v => `${v.toFixed(0)} ms`],
  ['**RAM** idle (RSS)', 'load', r => r.idle, v => `${v.toFixed(1)} MB`],
  ['RAM after 5 full refreshes (RSS)', 'load', r => r.refreshed, v => `${v.toFixed(1)} MB`],
  ['RAM peak (`VmHWM`)', 'load', r => r.peak, v => `${v.toFixed(1)} MB`],
  ['Static file, 64 connections', 'load', r => r.staticRps, v => `${thousands(v)} rps`, true],
  ['Cached API, 1 connection', 'load', r => r.apiRps, v => `${thousands(v)} rps`, true],
  ['Cached API p99 latency', 'load', r => r.apiP99, v => `${fixed(2)(v)} ms`],
  ['**Code**, lines', 'loc', r => r.lines, thousands],
  ['Code, non-whitespace characters', 'loc', r => r.chars, thousands],
];

function relative(value, ref, higherIsBetter) {
  if (!ref || value === ref) return '';
  const ratio = value / ref;
  if (higherIsBetter || (ratio > 0.5 && ratio < 2)) return ` (${ratio > 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(0)}%)`;
  return ` (${ratio.toFixed(1)}x)`;
}

function machine() {
  const info = JSON.parse(docker('info', '--format', '{{json .}}'));
  return `${info.OperatingSystem}, kernel ${info.KernelVersion}, ${info.NCPU} CPUs, ` +
    `${(info.MemTotal / 2 ** 30).toFixed(1)} GB RAM, Docker ${info.ServerVersion}`;
}

export function report(impls, results, { runs, startupRuns }) {
  const out = [`# Benchmark results`, '', `Measured on ${new Date().toISOString().slice(0, 10)}: ${machine()}.`, ''];
  const names = impls.map(i => i.name);
  out.push(`| Metric | ${impls.map(i => `\`${i.name}\` (${i.commit})`).join(' | ')} |`);
  out.push(`| --- | ${names.map(() => '---:').join(' | ')} |`);
  for (const [label, phase, pick, format, higherIsBetter] of ROWS) {
    if (!results[phase]) continue;
    const ref = pick(results[phase][names[0]]);
    const cells = names.map(n => pick(results[phase][n])).map(v => format(v) + relative(v, ref, higherIsBetter));
    out.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  out.push('', `Medians. Startup: ${startupRuns} starts, load and build: ${runs} runs. ` +
    `Percentages and factors are relative to \`${names[0]}\`.`);

  if (results.startup) {
    out.push('', 'Startup range, process start to first 200: ' +
      names.map(n => `\`${n}\` ${results.startup[n].min.toFixed(0)}-${results.startup[n].max.toFixed(0)} ms`).join(', ') + '.');
  }
  if (results.diff) {
    out.push('', `## API output compared with \`${names[0]}\``, '');
    for (const n of names) {
      const { hosts, problems, differences } = results.diff[n];
      const verdict = n === names[0] ? 'reference' : differences.length ? `${differences.length} differences` : 'identical';
      out.push(`- \`${n}\`: ${hosts} hosts, ${verdict}${problems.length ? `, **${problems.length} problems**` : ''}`);
      for (const p of problems) out.push(`  - ${p}`);
      for (const d of differences) {
        out.push(`  - ${d.host} \`${d.field}\`: \`${JSON.stringify(d.reference)}\` vs. \`${JSON.stringify(d.value)}\``);
      }
    }
  }
  if (results.loc) {
    out.push('', '## Files counted as code', '');
    for (const n of names) {
      out.push(`- \`${n}\`: ${results.loc[n].files.map(f => `\`${f.path}\` ${f.lines}`).join(', ')}`);
    }
  }
  return out.join('\n') + '\n';
}
