FROM gradle:9.8.2-jdk25-alpine AS build
WORKDIR /app
COPY build.gradle.kts settings.gradle.kts ./
COPY src ./src
COPY static ./static
RUN gradle --no-daemon --quiet installDist && mkdir cache

# Standard JVM image with default settings, runs as an unprivileged user
FROM eclipse-temurin:25-jre-alpine
WORKDIR /app
COPY --from=build /app/build/install/service-atlas/lib ./lib
COPY --from=build --chown=65532:65532 /app/cache ./cache
USER 65532:65532
EXPOSE 8080
CMD ["java", "-cp", "lib/*", "MainKt"]
