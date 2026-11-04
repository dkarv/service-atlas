// Renders the results of separate runs as one Markdown page, for the wiki:
//   node bench/wiki.mjs FILE... > Benchmark.md
// Each FILE is the output of ./run.sh --json. main comes first, then the others by name.
// Runs on the host, needs only Node.js.
import { readFileSync } from 'node:fs';
import { report } from './report.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node bench/wiki.mjs FILE... > page.md');
  process.exit(2);
}
const entries = files.flatMap(f => JSON.parse(readFileSync(f, 'utf8')));
entries.sort((a, b) => (b.name === 'main') - (a.name === 'main') || a.name.localeCompare(b.name));
process.stdout.write(report(entries));
