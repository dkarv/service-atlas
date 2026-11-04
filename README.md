# service-atlas benchmark

Compares implementations of [service-atlas](https://github.com/dkarv/service-atlas) in different languages and technologies. Every implementation lives on its own branch: `main` stays the Go version for self-hosting, alternatives live on `experiments/*`. This branch only holds the benchmark, it shares no files with the others.

Latest results: [RESULTS.md](RESULTS.md).

## Measured

| Metric | How |
| --- | --- |
| Image size | `docker export` of the image, gzipped: about the download size. |
| Build time | `docker build --no-cache` with the base images already pulled, dependencies are downloaded every time. |
| Startup | From the start of the process (`.State.StartedAt`) until the first 200 on `/`. |
| RAM | From `/proc/1/status` of the service: `VmRSS` 3 s after the start and `VmHWM` (peak) after 5 full refreshes and the throughput tests. |
| Throughput | `wrk` for 15 s on a static file (64 connections) and on the cached API (1 connection). |
| Code | Lines and non-whitespace characters of the `Dockerfile` and the files in `backend/`, except docs and hidden files. |
| API output | Each implementation's `/api/subdomains` is compared field by field with `bench/expected.json`. |

The workload never touches the internet. `bench/mock.mjs` is an HTTPS mock of crt.sh with 20,000 certificates (7 MB of JSON) and of 50 sites of about 50 KB each, with all kinds of favicon and manifest links, redirects and error codes. 5 more hosts don't resolve.

The cached API is measured with a single connection, because the Go original rewrites its cache file on every request: with concurrent requests a reader can see a half written file and trigger a full refresh.

## Running

Needs bash, git and Docker (Linux, or Docker Desktop on macOS and Windows with Git Bash). Run it from a checkout of this branch:

```bash
git fetch origin
./run.sh > results.md                 # main and all experiments/* branches, local or on origin
./run.sh main experiments/kotlin-jvm  # selected branches, tags or commits; percentages are relative to the first
./run.sh --phases diff,size --runs 1  # quick check, see ./run.sh --help
```

A full run of three implementations takes about 12 minutes on 16 CPUs. Progress goes to stderr, the Markdown report to stdout. With `--json`, the results go to stdout as JSON instead, and `node bench/wiki.mjs FILE...` renders the JSON of separate runs as one report.

`run.sh` builds a tools image (`Dockerfile`) and starts it with the Docker socket mounted, so it can build and run the other containers. Mounting the socket gives that container full control of Docker, as with any tool that drives Docker. The repository is mounted read-only to read the branches with `git archive`. Docker objects are named `sa-bench-*` and removed at the end, so only one run can happen at a time.

## Expected API output

`bench/expected.json` is the output of `main` for the mock, so no run needs `main` for the comparison. After an intended change of the output, or of the mock, write it again from a run of `main`:

```bash
./run.sh --phases diff --json main |
  node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0))[0].results.diff.output, null, 1))' > bench/expected.json
```

## GitHub Actions

The workflow `.github/workflows/benchmark.yml` on `main` (and on the branches created from it) benchmarks every push to `main` and `experiments/*`, but only the pushed branch. It shows the results on the summary page of the run and stores them in the wiki: `benchmark-data/<branch>.json` holds the latest results of each branch, and the page [Benchmark](https://github.com/dkarv/service-atlas/wiki/Benchmark) puts them side by side. `main` comes first, and the percentages are relative to it.

- The wiki must exist before the first run: create any page on the Wiki tab once.
- Branches created before the workflow need it merged or cherry-picked from `main`.
- Each column of the page comes from a different run on a GitHub runner (4 CPUs, shared hardware), so the rule below of comparing a single run doesn't hold there. Size, code and API output are exact; build time, startup, RAM and throughput are rough. For a fair comparison, run `./run.sh` locally with all branches.
- To remove a branch from the page, delete its JSON from the wiki and push any branch again.

## Adding an implementation

Create a branch `experiments/<language>-<technology>` from `main` and replace the Go code. To be comparable, the branch must:

1. Have a `Dockerfile` at the root whose default target is the image to measure. The build context is the tree of the commit.
2. Keep all of its code in `backend/`: only that and the `Dockerfile` count as code. The `Dockerfile` copies the shared frontend from `frontend/`.
3. Listen on port 8080 and serve the frontend at `/`, with `text/html` and `text/css` content types and 404 for unknown paths.
4. Answer `GET /api/subdomains?domain=<domain>[&refresh]` like `main`: subdomains from `https://crt.sh/?output=json&q=%.<domain>`, each probed on `https://<host>/` for status, favicon and web app manifest, cached for 1 day and 1 hour.
5. Trust the CA certificates in the file named by `SSL_CERT_FILE` in addition to the default ones, as Go does. This is how it trusts the mock.
6. Stop on SIGTERM, as `docker stop` sends it to PID 1.

Settings such as heap limits belong in the image of the branch. To compare settings, use one branch per variant. Small differences in the API output can be fine, the report lists them so they can be explained in the branch's README.

## Comparing fairly

- Always compare results of a single run. Between runs on the same machine, idle RAM moved by about 20% and throughput by 10-15%.
- Close other heavy programs while it runs. Builds and implementations take turns, so drift affects all of them alike.
- Each implementation is measured as its branch builds it, including base image and compiler flags.
- Report the machine with the results. `run.sh` writes it into the first line of the report.

## Files

| File | Purpose |
| --- | --- |
| `run.sh` | Entry point: builds the tools image and starts it |
| `Dockerfile` | Tools image: Node.js, Docker CLI, git, OpenSSL, wrk |
| `bench/main.mjs` | Options, branch selection, phases |
| `bench/docker.mjs` | Docker and git helpers, setup of network, CA and mock |
| `bench/measure.mjs` | Size, build, startup, RAM and throughput |
| `bench/checks.mjs` | HTTP contract, API output and lines of code |
| `bench/report.mjs` | Markdown report |
| `bench/wiki.mjs` | Markdown report of separate runs, for the wiki |
| `bench/mock.mjs` | HTTPS mock of crt.sh and the probed sites |

Like the rest of the project, every file stays at 150 lines or less.

## License

MIT, see [LICENSE.md](LICENSE.md).
