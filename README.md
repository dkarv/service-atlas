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
| Throughput | `wrk` for 15 s on a static file (64 connections) and on the cached API (1 connection), each after a discarded 5 s warm-up. |
| Code | Lines and non-whitespace characters of the `Dockerfile` and the files in `backend/`, except docs and hidden files. |
| API output | Each implementation's `/api/subdomains` is compared field by field with `bench/expected.json`. Any difference that the branch doesn't list as intended, or a wrong status or content type, fails the run right after the `diff` phase. |

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

By default the load and build phases run 5 times and each implementation starts 30 times. A full run of three implementations took about 12 minutes on 16 CPUs with 3 runs and no warm-up; expect roughly 20 minutes now, and more on a 4 CPU GitHub runner. Progress goes to stderr, the Markdown report to stdout. With `--json`, the results go to stdout as JSON instead, `node bench/markdown.mjs FILE...` renders the JSON of separate runs as one report, and `node bench/pages.mjs FILE...` as the HTML page.

`run.sh` builds a tools image (`Dockerfile`) and starts it with the Docker socket mounted, so it can build and run the other containers. Mounting the socket gives that container full control of Docker, as with any tool that drives Docker. The repository is mounted read-only to read the branches with `git archive`. Docker objects are named `sa-bench-*` and removed at the end, so only one run can happen at a time.

## Expected API output

`bench/expected.json` is the output of `main` for the mock, so no run needs `main` for the comparison. After an intended change of the output, or of the mock, write it again from a run of `main`:

```bash
./run.sh --phases diff --json main |
  node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0))[0].results.diff.output, null, 1))' > bench/expected.json
```

Only the hosts and fields in `bench/expected.json` have to match, additional hosts and fields in the output are ignored. A favicon URL may keep `../` in its path, e.g. `https://s2.bench.test/../up.png` like `java.net.URI`, as long as it resolves to the expected URL.

A branch whose output differs on purpose otherwise lists those differences in `.bench-differences.json` at its root. Each entry accepts exactly one value of one field of one host, `reason` is for the reader:

```json
[{ "host": "s5.bench.test", "field": "name", "value": "App", "reason": "keeps only the first word" }]
```

Listed differences are kept in the JSON under `intended` and don't fail the run. An entry that no longer matches the output does, so the list stays current. As a hidden file it doesn't count as code.

## GitHub Actions

The workflow `.github/workflows/benchmark.yml` on `main` (and on the branches created from it) benchmarks every push to `main` and `experiments/*`, but only the pushed branch. It shows the results on the summary page of the run and publishes them with `bench/publish.sh` on [GitHub Pages](https://dkarv.github.io/service-atlas/): the branch `gh-pages` keeps the latest results of each branch in `benchmark-data/<branch>.json`, and `index.html` puts them side by side in a table that sorts by any column. One row per branch, without the `experiments/` prefix: `main` comes first, and the percentages are relative to it. A branch whose API output differs, other than listed in its `.bench-differences.json`, fails its run and stays off the page.

- The first run creates the branch `gh-pages`. Then turn on Pages once: Settings, Pages, "Deploy from a branch", `gh-pages`, `/ (root)`.
- The workflow only calls `run.sh`, `bench/markdown.mjs` and `bench/publish.sh` of this branch, so changes here need no change on the other branches. Branches created before the workflow need it merged or cherry-picked from `main`.
- Each row of the page comes from a different run on a GitHub runner (4 CPUs, shared hardware), so the rule below of comparing a single run doesn't hold there. Size, code and API output are exact; build time, startup, RAM and throughput are rough. For a fair comparison, run `./run.sh` locally with all branches.
- To remove a branch from the page, delete its JSON on `gh-pages` and push any branch again.

## Adding an implementation

Create a branch `experiments/<language>-<technology>` from `main` and replace the Go code. To be comparable, the branch must:

1. Have a `Dockerfile` at the root whose default target is the image to measure. The build context is the tree of the commit.
2. Keep all of its code in `backend/`: only that and the `Dockerfile` count as code. The `Dockerfile` copies the shared frontend from `frontend/`.
3. Listen on port 8080 and serve the frontend at `/`, with `text/html` and `text/css` content types and 404 for unknown paths.
4. Answer `GET /api/subdomains?domain=<domain>[&refresh]` like `main`: subdomains from `https://crt.sh/?output=json&q=%.<domain>`, each probed on `https://<host>/` for status, favicon and web app manifest, cached for 1 day and 1 hour.
5. Trust the CA certificates in the file named by `SSL_CERT_FILE` in addition to the default ones, as Go does. This is how it trusts the mock.
6. Stop on SIGTERM, as `docker stop` sends it to PID 1.

Settings such as heap limits belong in the image of the branch. To compare settings, use one branch per variant. The API output must match `bench/expected.json`, apart from the differences listed in `.bench-differences.json`, otherwise the run fails and lists the differences in its error output.

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
| `bench/report.mjs` | Table of the results and Markdown report |
| `bench/markdown.mjs` | Markdown report of separate runs, for the summary of the workflow |
| `bench/pages.mjs` | HTML page with a sortable table of separate runs, for GitHub Pages |
| `bench/publish.sh` | Publishes a result on the branch `gh-pages`, for the workflow |
| `bench/mock.mjs` | HTTPS mock of crt.sh and the probed sites |

Like the rest of the project, every file stays at 150 lines or less.

## License

MIT, see [LICENSE.md](LICENSE.md).
