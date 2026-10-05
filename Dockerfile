FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum main.go ./
COPY static ./static
RUN go mod download && CGO_ENABLED=0 go build -o app -ldflags="-s -w" .

FROM alpine:3.21
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/app .
EXPOSE 8080
CMD ["/app/app"]
