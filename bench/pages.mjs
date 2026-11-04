// Renders the results of separate runs as one HTML page with a sortable table, for GitHub Pages:
//   node bench/pages.mjs FILE... > index.html
// Each FILE is the output of ./run.sh --json. Runs on the host, needs only Node.js. The page has no dependencies.
import { LEGEND, readEntries, runOf, short, table } from './report.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node bench/pages.mjs FILE... > index.html');
  process.exit(2);
}
const entries = readEntries(files);
const { headers, rows } = table(entries);
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const code = text => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
const repo = process.env.GITHUB_REPOSITORY ?? 'dkarv/service-atlas';

const head = ['Branch', 'Commit', ...headers].map((h, i) =>
  `<th${i > 1 ? ' class="num"' : ''}><button type="button">${esc(h)}</button></th>`).join('');
const body = rows.map(({ entry, cells }) => `<tr title="${esc(runOf(entry))}">` +
  `<td data-v="${esc(short(entry.name))}"><code>${esc(short(entry.name))}</code></td>` +
  `<td data-v="${esc(entry.commit)}"><a href="https://github.com/${repo}/commit/${esc(entry.commit)}">${esc(entry.commit)}</a></td>` +
  cells.map(c => `<td class="num" data-v="${c.value ?? ''}">${esc(c.text)}` +
    (c.delta ? ` <span class="${c.delta.better ? 'better' : 'worse'}">(${esc(c.delta.text)})</span>` : '') + '</td>').join('') + '</tr>').join('\n');
const runs = entries.map(e => `<li><code>${esc(short(e.name))}</code> (${esc(e.commit)}): ${esc(runOf(e))}</li>`).join('');

process.stdout.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>service-atlas benchmark</title>
<style>
:root { --bg: #fff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --head: #f6f8fa; --accent: #0969da; --better: #1a7f37; --worse: #d1242f; color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --head: #151b23; --accent: #4493f8; --better: #3fb950; --worse: #f85149; }
}
body { margin: 0 auto; max-width: 1100px; padding: 24px 16px; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, sans-serif; }
h1 { font-size: 24px; margin: 0 0 8px; }
p, li { color: var(--muted); }
a { color: var(--accent); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 10px; text-align: left; white-space: nowrap; }
th { background: var(--head); }
.num { text-align: right; }
th button { all: unset; cursor: pointer; font-weight: 600; }
th button::after { content: " \\2195"; color: var(--muted); }
th[aria-sort=ascending] button::after { content: " \\2191"; color: var(--fg); }
th[aria-sort=descending] button::after { content: " \\2193"; color: var(--fg); }
.better { color: var(--better); }
.worse { color: var(--worse); }
code { font: 13px ui-monospace, monospace; }
</style>
</head>
<body>
<h1>service-atlas benchmark</h1>
<p>One row per branch of <a href="https://github.com/${repo}">${esc(repo)}</a>. Click a header to sort.
Medians. Percentages are relative to <code>${esc(short(entries[0].name))}</code>,\n<span class="better">green</span> is better, <span class="worse">red</span> is worse. ${code(LEGEND)}</p>
<div class="scroll"><table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table></div>
<p>Each branch was measured in a separate run on a GitHub runner (shared hardware), so build time, startup, RAM and
throughput are rough. Size and code are exact. See "Comparing fairly" in the
<a href="https://github.com/${repo}/tree/benchmark#comparing-fairly">README of the branch <code>benchmark</code></a>.</p>
<ul>${runs}</ul>
<script>
// Numbers sort by value, text by name; rows without a value stay at the end.
const tbody = document.querySelector('tbody');
document.querySelectorAll('th').forEach((th, i) => th.querySelector('button').addEventListener('click', () => {
  const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
  document.querySelectorAll('th').forEach(other => other.removeAttribute('aria-sort'));
  th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
  const key = tr => tr.children[i].dataset.v;
  [...tbody.rows].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (x === '' || y === '') return (x === '') - (y === '');
    return dir * (th.classList.contains('num') ? x - y : x.localeCompare(y));
  }).forEach(tr => tbody.append(tr));
}));
</script>
</body>
</html>
`);
