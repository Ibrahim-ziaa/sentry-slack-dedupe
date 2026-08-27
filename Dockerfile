FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
COPY sentry_slack ./sentry_slack
RUN pip install --no-cache-dir .
ENV PORT=8080
CMD ["python", "-m", "sentry_slack.app"]
