# Stage 1: build the web console
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: the Python service, which also serves the built console
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY sentry_slack ./sentry_slack
RUN pip install --no-cache-dir .
COPY --from=web /web/dist ./web/dist
ENV PORT=8080 WEB_DIST=/app/web/dist
EXPOSE 8080
CMD ["python", "-m", "sentry_slack.app"]
