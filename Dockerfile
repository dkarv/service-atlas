FROM gradle:9.8.2-jdk25-alpine AS jars
WORKDIR /app
COPY build.gradle.kts settings.gradle.kts ./
COPY src ./src
COPY static ./static
RUN gradle --no-daemon --quiet installDist

# Static musl binary: embeds the static files and the CA certificates
FROM ghcr.io/graalvm/native-image-community:25-muslib AS native
WORKDIR /app
COPY --from=jars /app/build/install/service-atlas/lib ./lib
RUN native-image --static --libc=musl --no-fallback --install-exit-handlers \
      -Os -R:MaxHeapSize=64m -H:IncludeResources='static/.*' \
      --limit-modules=java.base,java.net.http,jdk.httpserver,jdk.crypto.ec \
      -cp 'lib/*' MainKt -o app && mkdir cache

# Static distroless image: no shell, runs as nonroot
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=native /app/app .
COPY --from=native --chown=nonroot:nonroot /app/cache ./cache
EXPOSE 8080
CMD ["/app/app"]
