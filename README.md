# service-atlas

Minimal service that generates a service overview homepage from Certificate Transparency (CT) logs.

## Philosophy

With AI-assisted programming it has become easy to build large, complicated systems that nobody can maintain or keep a full overview of. This project is a fun counter initiative: every file stays at **150 lines or less**, including the docs, config and vendored CSS, so the whole project can still be read and verified by hand.

<!-- loc:start -->
| File | Lines | Description |
| --- | ---: | --- |
| `main.go` | 148 | Backend: crt.sh lookup, service checks, cache, API |
| `static/blades.min.css` | 144 | Vendored Blades CSS (Pico fork) |
| `static/main.js` | 76 | Frontend: loads, sorts and renders the services |
| `static/style.css` | 45 | Custom styles on top of Blades |
| `static/index.html` | 32 | Page skeleton and card template |
| `Dockerfile` | 13 | Distroless container image |
| `go.mod` | 3 | Go module definition |
| **Total** | **461** | |
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
go mod init github.com/dkarv/service-atlas
go mod tidy
go run .
```

Open `http://localhost:8080` in your browser.

### Docker

```bash
docker run --rm -p 8080:8080 -v service-atlas-cache:/app/cache ghcr.io/dkarv/service-atlas
```

Images are published to GHCR on every push to `main` (`:latest`) and for `v*` tags (`:1.2.3`, `:1.2`). To build locally instead: `docker build -t service-atlas .`
