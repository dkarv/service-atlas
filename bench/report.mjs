// Renders results as Markdown, with every value also relative to the first entry. An entry holds the results of
// one implementation: { name, commit, date, machine, counts, results: { phase: result } }. The entries can come
// from one run (main.mjs) or from separate runs (markdown.mjs, pages.mjs).
import { readFileSync } from 'node:fs';

const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;
const thousands = value => Math.round(value).toLocaleString('en-US');

// [header, phase, value of a result, format, true if higher is better]. See "Measured" in the README.
const COLUMNS = [
  ['Image', 'size', r => r.gzipped, mb],
  ['Build', 'build', r => r.ms / 1000, v => `${v.toFixed(1)} s`],
  ['Startup', 'startup', r => r.fromStart, v => `${v.toFixed(0)} ms`],
  ['RAM idle', 'load', r => r.idle, v => `${v.toFixed(1)} MB`],
  ['RAM peak', 'load', r => r.peak, v => `${v.toFixed(1)} MB`],
  ['Static', 'load', r => r.staticRps, v => `${thousands(v)} rps`, true],
  ['API', 'load', r => r.apiRps, v => `${thousands(v)} rps`, true],
  ['Lines', 'loc', r => r.lines, thousands],
  ['Chars', 'loc', r => r.chars, thousands],
];
export const LEGEND = 'Image: gzipped. Build: uncached. Startup: process start to first 200. RAM: RSS when idle, peak ' +
  '`VmHWM`. Static and API: throughput on a static file with 64 connections, on the cached API with 1. ' +
  'Lines and Chars: lines and non-whitespace characters of the code in `backend/` and the `Dockerfile`.';

export const short = name => name.replace(/^experiments\//, '');

function relative(value, ref, higherIsBetter) {
  const ratio = value / ref;
  if (!ref || Math.round((ratio - 1) * 100) === 0) return '';
  if (higherIsBetter || (ratio > 0.5 && ratio < 2)) return ` (${ratio > 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(0)}%)`;
  return ` (${ratio.toFixed(1)}x)`;
}

// When and where an entry was measured, with the number of repetitions of the phases it has.
export function runOf({ date, machine, counts, results }) {
  const repeated = [results.load || results.build ? `${counts.runs} runs of load and build` : '',
    results.startup ? `${counts.startupRuns} starts` : ''].filter(Boolean);
  return `${date} on ${machine}${repeated.length ? `, ${repeated.join(', ')}` : ''}`;
}

function measured(entries) {
  const runs = entries.map(runOf);
  if (runs.every(r => r === runs[0])) return [`Measured ${runs[0]}.`];
  return ['Each implementation was measured in a separate run, maybe on another machine. The variance between runs ' +
    'is larger than within a run, see "Comparing fairly" in the README of the branch `benchmark`.', '',
    ...entries.map((e, i) => `- \`${short(e.name)}\` (${e.commit}): ${runs[i]}.`)];
}

// Reads the JSON files of ./run.sh --json: main first, then the others by name.
export function readEntries(files) {
  const entries = files.flatMap(f => JSON.parse(readFileSync(f, 'utf8')));
  return entries.sort((a, b) => (b.name === 'main') - (a.name === 'main') || a.name.localeCompare(b.name));
}

// One row per implementation, one column per measurement: { headers, rows: [{ entry, cells: [{ value, text }] }] }.
export function table(entries) {
  const columns = COLUMNS.filter(([, phase]) => entries.some(e => e.results[phase]));
  const rows = entries.map(entry => ({
    entry,
    cells: columns.map(([, phase, pick, format, higherIsBetter]) => {
      if (!entry.results[phase]) return { value: null, text: '-' };
      const value = pick(entry.results[phase]), ref = entries[0].results[phase] && pick(entries[0].results[phase]);
      return { value, text: format(value) + relative(value, ref, higherIsBetter) };
    }),
  }));
  return { headers: columns.map(([header]) => header), rows };
}

export function report(entries) {
  const { headers, rows } = table(entries);
  const out = ['# Benchmark results', '', ...measured(entries), ''];
  out.push(`| Branch | Commit | ${headers.join(' | ')} |`);
  out.push(`| --- | --- | ${headers.map(() => '---:').join(' | ')} |`);
  for (const { entry, cells } of rows) {
    out.push(`| \`${short(entry.name)}\` | ${entry.commit} | ${cells.map(c => c.text).join(' | ')} |`);
  }
  out.push('', `Medians. Percentages and factors are relative to \`${short(entries[0].name)}\`. ${LEGEND}`);
  return out.join('\n') + '\n';
}
