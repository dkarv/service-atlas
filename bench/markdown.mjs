// Renders the results of separate runs as one Markdown report, as on the summary page of the workflow:
//   node bench/markdown.mjs FILE... > results.md
// Each FILE is the output of ./run.sh --json. Runs on the host, needs only Node.js.
import { readEntries, report } from './report.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node bench/markdown.mjs FILE... > results.md');
  process.exit(2);
}
process.stdout.write(report(readEntries(files)));
