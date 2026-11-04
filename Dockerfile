# Tools image: drives the benchmark, serves the mock and reads /proc of the measured containers.
FROM node:22-alpine3.24
RUN apk add --no-cache docker-cli docker-cli-buildx git openssl wrk
WORKDIR /bench
COPY bench/ ./
ENTRYPOINT ["node", "/bench/main.mjs"]
