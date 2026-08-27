# sentry-slack-dedupe

Sentry's Slack integration is paywalled on lower plans, and even when you have it, a single bug in a hot path can post forty messages in a minute. This is a small webhook bridge that fixes both.

```
Sentry webhook ──▶ /sentry ──▶ fingerprint ──▶ dedupe (SQLite) ──▶ Slack incoming webhook
```

## Rules

| situation | what happens |
|---|---|
| first time a fingerprint is seen | one Slack message |
| same fingerprint again inside the quiet window (default 1h) | silent, counted |
| 10th, 100th, 1000th occurrence | message anyway, with the count ("seen 100x, 89 suppressed") |
| window expires and it fires again | message, with how many were suppressed |
| restart of the bridge | nothing re-alerts; state is in SQLite |

Fingerprint is Sentry's issue id when present, otherwise a hash of project + title + culprit, so unknown payload shapes still dedupe instead of crashing.

Optional HMAC check on `Sentry-Hook-Signature` when `SENTRY_CLIENT_SECRET` is set.

## Run

```bash
pip install -e ".[dev]"
pytest                                            # 7 tests, no network (httpx MockTransport)
SLACK_WEBHOOK_URL=https://hooks.slack.com/... python -m sentry_slack.app
```

Docker:

```bash
docker build -t sentry-slack-dedupe .
docker run -p 8080:8080 -e SLACK_WEBHOOK_URL=... -v $PWD/state:/app/state -e STATE_DB=/app/state/state.db sentry-slack-dedupe
```

Then in Sentry: Settings → Integrations → Webhooks → `https://your-host/sentry`, and add an alert rule that sends to the webhook.

## Env

| var | default | |
|---|---|---|
| `SLACK_WEBHOOK_URL` | required | Slack incoming webhook |
| `SENTRY_CLIENT_SECRET` | unset | if set, signature is required |
| `DEDUPE_WINDOW_SECONDS` | 3600 | quiet window |
| `STATE_DB` | state.db | SQLite path; mount it if you want state across container restarts |

## Layout

```
sentry_slack/
  dedupe.py   the rules, testable without Sentry or Slack
  sentry.py   payload parsing + fingerprint
  slack.py    message format + client
  app.py      FastAPI wiring, signature check
```

MIT.
