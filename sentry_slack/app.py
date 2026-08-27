"""FastAPI app. Deploy anywhere that runs a container; point Sentry's webhook integration at /sentry.

Env:
  SLACK_WEBHOOK_URL   required
  SENTRY_CLIENT_SECRET  optional; if set, requests must carry a valid Sentry-Hook-Signature
  DEDUPE_WINDOW_SECONDS default 3600
  STATE_DB              default state.db
"""
from __future__ import annotations

import hashlib
import hmac
import os

from fastapi import FastAPI, Header, HTTPException, Request

from .dedupe import Deduper
from .sentry import parse
from .slack import SlackClient, format_message


def create_app(slack: SlackClient | None = None, deduper: Deduper | None = None, secret: str | None = None) -> FastAPI:
    app = FastAPI(title="sentry-slack-dedupe")
    slack = slack or SlackClient(os.environ["SLACK_WEBHOOK_URL"])
    deduper = deduper or Deduper(os.environ.get("STATE_DB", "state.db"), int(os.environ.get("DEDUPE_WINDOW_SECONDS", "3600")))
    secret = secret if secret is not None else os.environ.get("SENTRY_CLIENT_SECRET")

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.post("/sentry")
    async def sentry(request: Request, sentry_hook_signature: str | None = Header(default=None)):
        body = await request.body()
        if secret:
            expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            if not sentry_hook_signature or not hmac.compare_digest(expected, sentry_hook_signature):
                raise HTTPException(401, "bad signature")
        ev = parse(await request.json())
        d = deduper.decide(ev.fingerprint)
        if d.notify:
            slack.post(format_message(ev, d))
        return {"fingerprint": ev.fingerprint, "notified": d.notify, "count": d.count, "reason": d.reason}

    return app


def main():
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
