# Node.js runs the JavaScript directly, no build step and no dependencies to install.
FROM node:24-alpine
WORKDIR /app
COPY backend/server.mjs ./backend/
COPY frontend ./frontend
# Runs as the unprivileged user of the image, which needs to own the cache directory.
RUN mkdir cache && chown node:node cache
USER node
EXPOSE 8080
CMD ["node", "backend/server.mjs"]
