# Python runs the script directly, no build step and no dependencies to install.
FROM python:3.13-alpine
WORKDIR /app
COPY backend/main.py ./backend/
COPY frontend ./frontend
# Runs as an unprivileged user, which needs to own the cache directory.
RUN mkdir cache && chown nobody cache
USER nobody
EXPOSE 8080
CMD ["python", "backend/main.py"]
