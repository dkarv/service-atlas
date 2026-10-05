# service-atlas

Minimal, stateless Go service that generates a service overview homepage from Certificate Transparency (CT) logs.

- Derives the base domain from the `Host` header (works behind reverse proxy with `*.yourdomain.com`).
- Queries [crt.sh](https://crt.sh) for all subdomains of that domain.
- Caches results in memory (configurable TTL).
- Serves a static `index.html` that loads the subdomain list via `/api/subdomains`.

No configuration files, no environment variables. Just run and access via your domain.

## Features

- Automatic subdomain discovery via CT logs
- In-memory caching (default: 12 hours)
- Single binary, stateless, Docker-ready
- Works with wildcard DNS + Caddy (or any reverse proxy)
- JSON API: `GET /api/subdomains?domain=yourdomain.com`

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
docker build -t service-atlas .
docker run --rm -p 8080:8080 service-atlas
```

### With Caddy

Example `Caddyfile`:

```caddy
*.yourdomain.com {
    reverse_proxy service-atlas:8080
}
```

Now visiting `https://services.yourdomain.com` (or any other subdomain) shows the overview for `yourdomain.com`.

## API

### `GET /api/subdomains`

Query parameters:

- `domain` (optional): base domain, e.g. `yourdomain.com`.
  If omitted, the domain is derived from the `Host` header.

Response:

```json
{
  "domain": "yourdomain.com",
  "subdomains": [
    "api.yourdomain.com",
    "services.yourdomain.com",
    "www.yourdomain.com"
  ],
  "cached_ttl": "15m0s"
}
```

## Project structure

```text
.
├── main.go
├── go.mod
├── Dockerfile
├── README.md
├── .devcontainer
│   └── devcontainer.json
└── static
    └── index.html
```

## License

MIT
