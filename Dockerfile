# FrankenPHP serves the frontend and runs the PHP code, no build step needed.
FROM dunglas/frankenphp:1-php8.5-alpine
WORKDIR /app
COPY backend/api.php backend/Caddyfile ./backend/
COPY frontend ./frontend
# Runs as an unprivileged user, which needs to own the cache and Caddy's state directories.
RUN mkdir cache && chown 65532:65532 cache /data/caddy /config/caddy
USER 65532:65532
EXPOSE 8080
CMD ["frankenphp", "run", "--config", "backend/Caddyfile"]
