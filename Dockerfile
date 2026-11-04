FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY backend/ ./
COPY frontend ./frontend
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o app . && mkdir cache

# Static distroless image: CA certificates included, no shell, runs as nonroot
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=builder /app/app .
COPY --from=builder --chown=nonroot:nonroot /app/cache ./cache
EXPOSE 8080
CMD ["/app/app"]
