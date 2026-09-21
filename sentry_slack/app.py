"""FastAPI app: webhook intake, JSON API, and the built web console, all on one port.

Env:
  DEMO_MODE             1 = in memory state, a replayed week of traffic, Slack messages go to an in app outbox
  SLACK_WEBHOOK_URL     required unless DEMO_MODE=1
  SENTRY_CLIENT_SECRET  optional; if set, /sentry and /hooks/sentry require a valid Sentry-Hook-Signature
  HOOK_SECRET_<ID>      optional; secret for source <ID> (X-Signature HMAC, or Authorization: Bearer)
  SOURCES               default "sentry:sentry,n8n:n8n,custom:generic" (id:kind pairs)
  DEDUPE_WINDOW_SECONDS default 3600
  STATE_DB              default state.db
  SLACK_CHANNEL_LABEL   default #alerts (display only; the webhook decides the real channel)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import build_router
from .dedupe import Deduper
from .hub import AlertHub, Source
from .parsers import PayloadError
from .slack import SlackClient
from .store import Store

WEB_DIST = Path(os.environ.get("WEB_DIST") or Path(__file__).resolve().parent.parent / "web" / "dist")


def sources_from_env(sentry_secret: str | None) -> list[Source]:
    out = []
    for pair in os.environ.get("SOURCES", "sentry:sentry,n8n:n8n,custom:generic").split(","):
        sid, _, kind = pair.strip().partition(":")
        secret = os.environ.get(f"HOOK_SECRET_{sid.upper().replace('-', '_')}", "")
        if kind == "sentry" and sentry_secret is not None:
            secret = sentry_secret or secret
        out.append(Source(sid, kind or "generic", "" if kind != "generic" else sid.replace("-", " ").replace("_", " ").capitalize(), secret=secret))
    return out


def verify(source: Source, body: bytes, headers) -> bool:
    if not source.secret:
        return True
    expected = hmac.new(source.secret.encode(), body, hashlib.sha256).hexdigest()
    given = headers.get(source.signature_header) or ""
    if given and hmac.compare_digest(expected, given.removeprefix("sha256=")):
        return True
    # n8n and Zapier style senders cannot always sign a body, so a bearer token is accepted for non Sentry sources
    bearer = (headers.get("authorization") or "").removeprefix("Bearer ").strip()
    return source.kind != "sentry" and bool(bearer) and hmac.compare_digest(source.secret, bearer)


def create_app(slack: SlackClient | None = None, deduper: Deduper | None = None, secret: str | None = None,
               store: Store | None = None, demo: bool | None = None) -> FastAPI:
    app = FastAPI(title="Alert Console", docs_url="/api/docs", openapi_url="/api/openapi.json")
    demo = (os.environ.get("DEMO_MODE", "") not in ("", "0", "false")) if demo is None else demo
    state = SimpleNamespace(demo=demo, company="", hub=None)

    if demo:
        from . import demo as demo_data

        state.company = demo_data.COMPANY
        state.reset = lambda: setattr(state, "hub", demo_data.build_hub())
        state.reset()
    else:
        if slack is None and not os.environ.get("SLACK_WEBHOOK_URL"):
            raise RuntimeError("Set SLACK_WEBHOOK_URL, or DEMO_MODE=1 to run the offline demo.")
        path = os.environ.get("STATE_DB", "state.db")
        secret = secret if secret is not None else os.environ.get("SENTRY_CLIENT_SECRET")
        state.hub = AlertHub(
            slack or SlackClient(os.environ["SLACK_WEBHOOK_URL"]),
            deduper or Deduper(path, int(os.environ.get("DEDUPE_WINDOW_SECONDS", "3600"))),
            store or Store(":memory:" if deduper is not None else path),
            sources_from_env(secret),
            os.environ.get("SLACK_CHANNEL_LABEL", "#alerts"),
        )
    app.state.console = state

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    async def intake(source_id: str, request: Request):
        hub = state.hub
        source = hub.sources.get(source_id)
        if source is None:
            raise HTTPException(404, f"unknown source {source_id!r}")
        body = await request.body()
        if not verify(source, body, request.headers):
            raise HTTPException(401, "bad signature")
        try:
            return hub.ingest(source_id, json.loads(body))
        except json.JSONDecodeError:
            raise HTTPException(400, "body is not valid JSON")
        except PayloadError as e:
            raise HTTPException(422, str(e))

    @app.post("/hooks/{source_id}")
    async def hooks(source_id: str, request: Request):
        return await intake(source_id, request)

    @app.post("/sentry")  # the original endpoint, kept so existing Sentry webhook settings keep working
    async def sentry(request: Request):
        return await intake("sentry", request)

    app.include_router(build_router(state))

    if (WEB_DIST / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith(("api/", "hooks/")):
                raise HTTPException(404)
            file = (WEB_DIST / path).resolve()
            if path and file.is_file() and WEB_DIST.resolve() in file.parents:
                return FileResponse(file)
            return FileResponse(WEB_DIST / "index.html")

    return app


def main():
    import uvicorn

    uvicorn.run(create_app(), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
