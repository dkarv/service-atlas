// Renders results as Markdown, with every value also relative to the first entry. An entry holds the results of
// one implementation: { name, commit, date, machine, counts, results: { phase: result } }. The entries can come
// from one run (main.mjs) or from separate runs (wiki.mjs).
const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;
const thousands = value => Math.round(value).toLocaleString('en-US');

// [label, phase, value of a result, format, true if higher is better]
const ROWS = [
  ['**Image size**, gzipped', 'size', r => r.gzipped, mb],
  ['**Build time**, uncached', 'build', r => r.ms / 1000, v => `${v.toFixed(1)} s`],
  ['**Startup**, process start to first 200', 'startup', r => r.fromStart, v => `${v.toFixed(0)} ms`],
  ['**RAM** idle (RSS)', 'load', r => r.idle, v => `${v.toFixed(1)} MB`],
  ['RAM peak (`VmHWM`)', 'load', r => r.peak, v => `${v.toFixed(1)} MB`],
  ['**Throughput**, static file, 64 connections', 'load', r => r.staticRps, v => `${thousands(v)} rps`, true],
  ['Throughput, cached API, 1 connection', 'load', r => r.apiRps, v => `${thousands(v)} rps`, true],
  ['**Code** in `backend/` and `Dockerfile`, lines', 'loc', r => r.lines, thousands],
  ['Code, non-whitespace characters', 'loc', r => r.chars, thousands],
];

function relative(value, ref, higherIsBetter) {
  if (!ref || value === ref) return '';
  const ratio = value / ref;
  if (higherIsBetter || (ratio > 0.5 && ratio < 2)) return ` (${ratio > 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(0)}%)`;
  return ` (${ratio.toFixed(1)}x)`;
}

// When and where an entry was measured, with the number of repetitions of the phases it has.
function runOf({ date, machine, counts, results }) {
  const repeated = [results.load || results.build ? `${counts.runs} runs of load and build` : '',
    results.startup ? `${counts.startupRuns} starts` : ''].filter(Boolean);
  return `${date} on ${machine}${repeated.length ? `, ${repeated.join(', ')}` : ''}`;
}

function measured(entries) {
  const runs = entries.map(runOf);
  if (runs.every(r => r === runs[0])) return [`Measured ${runs[0]}.`];
  return ['Each implementation was measured in a separate run, maybe on another machine. The variance between runs ' +
    'is larger than within a run, see "Comparing fairly" in the README of the branch `benchmark`.', '',
    ...entries.map((e, i) => `- \`${e.name}\` (${e.commit}): ${runs[i]}.`)];
}

export function report(entries) {
  const out = ['# Benchmark results', '', ...measured(entries), ''];
  out.push(`| Metric | ${entries.map(e => `\`${e.name}\` (${e.commit})`).join(' | ')} |`);
  out.push(`| --- | ${entries.map(() => '---:').join(' | ')} |`);
  for (const [label, phase, pick, format, higherIsBetter] of ROWS) {
    if (!entries.some(e => e.results[phase])) continue;
    const values = entries.map(e => e.results[phase] && pick(e.results[phase]));
    const cells = values.map(v => v === undefined ? '-' : format(v) + relative(v, values[0], higherIsBetter));
    out.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  out.push('', `Medians. Percentages and factors are relative to \`${entries[0].name}\`.`);

  const checked = entries.filter(e => e.results.diff);
  if (checked.length) out.push('', '## API output compared with the expected one', '');
  for (const { name, results: { diff } } of checked) {
    const { hosts, problems, differences } = diff;
    const verdict = differences.length ? `${differences.length} differences` : 'as expected';
    out.push(`- \`${name}\`: ${hosts} hosts, ${verdict}${problems.length ? `, **${problems.length} problems**` : ''}`);
    for (const p of problems) out.push(`  - ${p}`);
    for (const d of differences) {
      out.push(`  - ${d.host} \`${d.field}\`: expected \`${JSON.stringify(d.expected)}\`, got \`${JSON.stringify(d.value)}\``);
    }
  }
  return out.join('\n') + '\n';
}
