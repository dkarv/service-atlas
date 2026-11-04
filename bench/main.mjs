// Entry point of the tools container, started by run.sh. Progress goes to stderr, the report to stdout.
import { parseArgs } from 'node:util';
import { git, log, setup, teardown } from './docker.mjs';
import { build, load, size, startup } from './measure.mjs';
import { diff, loc } from './checks.mjs';
import { report } from './report.mjs';

const PHASES = { diff, loc, size, startup, load, build };
const usage = `Usage: ./run.sh [options] [REF...]

Builds the Dockerfile at the root of each git REF (branch, tag or commit) and compares the images.
Without REFs: main and all experiments/* branches, local or on origin. The first REF is the reference.

Options:
  --runs N           runs of the load and build phases (default 3)
  --startup-runs N   container starts per implementation (default 20)
  --phases LIST      comma separated, default: ${Object.keys(PHASES).join(',')}
  -h, --help         show this help`;

function fail(message) {
  console.error(`${message}\n\n${usage}`);
  process.exit(2);
}

let opts, positionals;
try {
  ({ values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      runs: { type: 'string', default: '3' },
      'startup-runs': { type: 'string', default: '20' },
      phases: { type: 'string', default: Object.keys(PHASES).join(',') },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  fail(e.message);
}
if (opts.help) {
  console.log(usage);
  process.exit(0);
}
const phases = opts.phases.split(',').filter(Boolean);
const unknown = phases.filter(p => !PHASES[p]);
if (unknown.length) fail(`Unknown phases: ${unknown.join(', ')}`);
const counts = { runs: Number(opts.runs), startupRuns: Number(opts['startup-runs']) };
if (!(counts.runs > 0 && counts.startupRuns > 0)) fail('--runs and --startup-runs must be positive numbers');

// main first, then the experiments in alphabetical order. Local branches win over the ones on origin.
function defaultRefs() {
  const byName = new Map();
  const refs = git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin').split('\n');
  for (const ref of refs.filter(Boolean)) {
    const name = ref.replace(/^origin\//, '');
    if ((name === 'main' || name.startsWith('experiments/')) && !byName.has(name)) byName.set(name, ref);
  }
  return [...byName.keys()].sort((a, b) => (b === 'main') - (a === 'main') || a.localeCompare(b)).map(n => byName.get(n));
}

const refs = positionals.length ? positionals : defaultRefs();
if (!refs.length) fail('No refs to benchmark: there is no main or experiments/* branch');
const commit = ref => {
  try {
    return git('rev-parse', '--short', '--verify', '--quiet', `${ref}^{commit}`).trim();
  } catch {
    fail(`Unknown git ref: ${ref}`);
  }
};
const impls = refs.map(ref => ({
  ref,
  name: ref.replace(/^origin\//, ''),
  commit: commit(ref),
  tag: `service-atlas-bench:${ref.replace(/^origin\//, '').replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase()}`,
}));

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { teardown(); process.exit(130); });

// On errors the report still contains the finished phases.
const results = {};
let failure;
try {
  log(`Implementations: ${impls.map(i => `${i.name} (${i.commit})`).join(', ')}`);
  setup(impls);
  for (const phase of phases) {
    log(`Phase ${phase}`);
    results[phase] = await PHASES[phase](impls, counts);
  }
} catch (e) {
  failure = e;
} finally {
  teardown();
}
const finished = Object.keys(results).join(', ') || 'none';
const incomplete = failure ? `\n**Incomplete:** the run failed, finished phases: ${finished}. See the error output.\n` : '';
process.stdout.write(report(impls, results, counts) + incomplete);
if (failure) {
  console.error(failure.stack);
  process.exitCode = 1;
}
