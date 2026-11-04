# service-atlas

Minimal service that generates a service overview homepage from Certificate Transparency (CT) logs.

> **Experimental branch:** a port of the Go backend on `main` to PHP 8.5, served by [FrankenPHP](https://frankenphp.dev) (Caddy with PHP built in). For self-hosting use `main`. How the implementations compare is measured on the [`benchmark`](https://github.com/dkarv/service-atlas/tree/benchmark) branch.

![Screenshot of the service overview](.github/assets/screenshot.png)

## Philosophy

With AI-assisted programming it has become easy to build large, complicated systems that nobody can maintain or keep a full overview of. This project is a fun counter initiative: every file stays at **150 lines or less**, including the docs, config and vendored CSS, so the whole project can still be read and verified by hand.

<!-- loc:start -->
| File | Lines | Description |
| --- | ---: | --- |
| **Backend** | **158** | |
| `backend/api.php` | 141 | crt.sh lookup, service checks, cache, API |
| `backend/Caddyfile` | 17 | FrankenPHP routes: API and static files |
| **Frontend** | **297** | |
| `frontend/blades.min.css` | 144 | Vendored Blades CSS (Pico fork) |
| `frontend/main.js` | 76 | Loads, sorts and renders the services |
| `frontend/style.css` | 45 | Custom styles on top of Blades |
| `frontend/index.html` | 32 | Page skeleton and card template |
| **Dockerfile** | **10** | |
| `Dockerfile` | 10 | FrankenPHP container image |
| **Total** | **465** | |
<!-- loc:end -->


## Features

- Derives the base domain from the page's hostname (works behind reverse proxy with `*.yourdomain.com`).
- Queries [crt.sh](https://crt.sh) for all subdomains of that domain.
- Caches results in `./cache/<domain>.json` and refetches once they are older than 1 day.
- Serves a static `index.html` that loads the subdomain list via `/api/subdomains`.
- JSON API: `GET /api/subdomains?domain=yourdomain.com`

No configuration files. Just run and access via your domain. Optionally `SSL_CERT_FILE` adds trusted CA certificates, e.g. of a private CA, as it does for Go.


## Quickstart

### Build & run locally

```bash
frankenphp run --config backend/Caddyfile
```

Run it from the root of the repository, the `Caddyfile` refers to `backend/` and `frontend/` from there. [FrankenPHP](https://frankenphp.dev/docs/#standalone-binary) is a single binary with PHP 8.5 included, there is nothing to build. Caddy serves the frontend itself and runs `backend/api.php` for each API request.

Open `http://localhost:8080` in your browser.

### Docker

```bash
docker build -t service-atlas .
docker run --rm -p 8080:8080 -v service-atlas-cache:/app/cache service-atlas
```

The image is `dunglas/frankenphp:1-php8.5-alpine` with the default PHP settings, running as an unprivileged user. The published `ghcr.io/dkarv/service-atlas` images are built from `main`.


## Differences from the Go version

The JSON API returns the same results for the benchmark mock, apart from these details:

- An empty list is `[]` instead of `null`, and the API sends `application/json` instead of `text/plain`.
- The cache file is written to a temporary file and renamed, so concurrent requests never read a partial file.
- Error messages are curl's, e.g. `Could not resolve host: dead0.example.com (Domain name not found)`, and requests send `User-Agent: service-atlas`.
- Timestamps have millisecond instead of nanosecond precision.
- PHP's time and memory limits are lifted for the API, as probing all services takes longer than 30 s.
