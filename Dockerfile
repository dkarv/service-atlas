FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod main.go ./
COPY static ./static
RUN CGO_ENABLED=0 go build -o app -ldflags="-s -w" . && mkdir cache

# Static distroless image: CA certificates included, no shell, runs as nonroot
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=builder /app/app .
COPY --from=builder --chown=nonroot:nonroot /app/cache ./cache
EXPOSE 8080
CMD ["/app/app"]
