# service-atlas

Minimal service that generates a service overview homepage from Certificate Transparency (CT) logs.

> **Experimental branch:** a port of the Go backend on `main` to Python 3.13, with no dependencies: only the standard library (`http.server`, `urllib`, threads). For self-hosting use `main`. How the implementations compare is measured on the [`benchmark`](https://github.com/dkarv/service-atlas/tree/benchmark) branch.

![Screenshot of the service overview](.github/assets/screenshot.png)

## Philosophy

With AI-assisted programming it has become easy to build large, complicated systems that nobody can maintain or keep a full overview of. This project is a fun counter initiative: every file stays at **150 lines or less**, including the docs, config and vendored CSS, so the whole project can still be read and verified by hand.

<!-- loc:start -->
| File | Lines | Description |
| --- | ---: | --- |
| **Backend** | **150** | |
| `backend/main.go` | 147 | crt.sh lookup, service checks, cache, API |
| `backend/go.mod` | 3 | Go module definition |
| **Frontend** | **291** | |
| `frontend/blades.min.css` | 144 | Vendored Blades CSS (Pico fork) |
| `frontend/main.js` | 73 | Loads, sorts and renders the services |
| `frontend/style.css` | 42 | Custom styles on top of Blades |
| `frontend/index.html` | 32 | Page skeleton and card template |
| **Dockerfile** | **13** | |
| `Dockerfile` | 13 | Distroless container image |
| **Total** | **454** | |
<!-- loc:end -->


## Features

- Derives the base domain from the page's hostname (works behind reverse proxy with `*.yourdomain.com`).
- Queries [crt.sh](https://crt.sh) for all subdomains of that domain.
- Caches results in `./cache/<domain>.json` and refetches once they are older than 1 day.
- Serves a static `index.html` that loads the subdomain list via `/api/subdomains`.
- JSON API: `GET /api/subdomains?domain=yourdomain.com`

No configuration files, no environment variables. Just run and access via your domain.


## Quickstart

### Build & run locally

```bash
python3 backend/main.py
```

Needs Python 3.8 or newer. There is nothing to install or build: the server serves `frontend/` next to `backend/` and keeps the cache in `cache/` in the working directory.

Open `http://localhost:8080` in your browser.

### Docker

```bash
docker build -t service-atlas .
docker run --rm -p 8080:8080 -v service-atlas-cache:/app/cache service-atlas
```

The image is `python:3.13-alpine`, running as the unprivileged user `nobody`. The published `ghcr.io/dkarv/service-atlas` images are built from `main`.

## Differences from the Go version

- An empty list is `[]` instead of `null`, and the API sends `application/json` instead of `text/plain`.
- Error messages are Python's, timestamps have microsecond precision and a reset `checked_at` is `null` in the cache file.
- A manifest is only read from a successful response, and at most 64 sites are probed at once.


## Experiments

`main` stays the Go version for self-hosting. The `experiments/*` branches port the same service to other languages and technologies, such as Kotlin on the JVM and as a GraalVM native image, to see what each choice costs. Every push to `main` or an experiment benchmarks it: image size, build time, startup, RAM, throughput and lines of code, with the same API output checked. See the [benchmark results](https://dkarv.github.io/service-atlas/) and the branch [`benchmark`](https://github.com/dkarv/service-atlas/tree/benchmark) for how they are measured.
