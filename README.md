# service-atlas

Minimal service that generates a service overview homepage from Certificate Transparency (CT) logs.

![Screenshot of the service overview](.github/assets/screenshot.png)

## Philosophy

With AI-assisted programming it has become easy to build large, complicated systems that nobody can maintain or keep a full overview of. This project is a fun counter initiative: every file stays at **150 lines or less**, including the docs, config and vendored CSS, so the whole project can still be read and verified by hand.

<!-- loc:start -->
| File | Lines | Description |
| --- | ---: | --- |
| **Backend** | **151** | |
| `backend/main.go` | 148 | crt.sh lookup, service checks, cache, API |
| `backend/go.mod` | 3 | Go module definition |
| **Frontend** | **297** | |
| `frontend/blades.min.css` | 144 | Vendored Blades CSS (Pico fork) |
| `frontend/main.js` | 76 | Loads, sorts and renders the services |
| `frontend/style.css` | 45 | Custom styles on top of Blades |
| `frontend/index.html` | 32 | Page skeleton and card template |
| **Dockerfile** | **13** | |
| `Dockerfile` | 13 | Distroless container image |
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
# The frontend is embedded into the binary, so copy it next to main.go first (git-ignored)
rm -rf backend/frontend && cp -r frontend backend/
cd backend && go run .
```

Open `http://localhost:8080` in your browser.

### Docker

```bash
docker run --rm -p 8080:8080 -v service-atlas-cache:/app/cache ghcr.io/dkarv/service-atlas
```

Images are published to GHCR on every push to `main` (`:latest`) and for `v*` tags (`:1.2.3`, `:1.2`). To build locally instead: `docker build -t service-atlas .`
