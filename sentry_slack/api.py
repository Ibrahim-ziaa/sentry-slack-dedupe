"""JSON API for the web console. Read models come from the history store; nothing here bypasses the intake."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid

from fastapi import APIRouter, Body, HTTPException, Query

from .hub import RANGES, RulesError

SAMPLE_NOTE = {
    "sentry": "A Sentry issue alert, the shape Sentry posts when an alert rule fires.",
    "n8n": "The item an n8n Error Trigger node produces, forwarded with an HTTP Request node.",
    "generic": "Plain JSON. Only 'title' is required. Send 'fingerprint' to control grouping yourself.",
}


def sample_payload(kind: str, source_id: str, fresh: bool) -> dict:
    tag = uuid.uuid4().hex[:6] if fresh else ""
    if kind == "sentry":
        issue_id = f"test-{tag}" if fresh else "test-event"
        shared = {"title": "TestError: this is a test event from the console" + (f" ({tag})" if fresh else ""),
                  "culprit": "console/sources in send_test_event", "level": "error", "web_url": "https://sentry.example/issues/test/"}
        return {"action": "triggered", "data": {"event": {**shared, "environment": "staging"},
                                                "issue": {**shared, "id": issue_id, "project": {"slug": "console-test"}}}}
    if kind == "n8n":
        return {"execution": {"id": "1", "url": "https://n8n.example/workflow/test/executions/1", "lastNodeExecuted": "HTTP Request",
                              "mode": "manual", "error": {"message": "Test failure from the console" + (f" ({tag})" if fresh else "")}},
                "workflow": {"id": f"test-{tag}" if fresh else "test", "name": "Console test workflow"}}
    payload = {"title": "Test event from the console", "service": "console-test", "severity": "warning",
               "details": {"sent_by": "Send test event button"}}
    if fresh:
        payload["fingerprint"] = f"test-{tag}"
    return payload


def build_router(state) -> APIRouter:
    """`state.hub` is looked up on every request, so Reset demo can swap in a freshly replayed hub."""
    api = APIRouter(prefix="/api")

    @api.get("/meta")
    def meta():
        hub = state.hub
        return {"product": "Alert Console", "demo": state.demo, "company": state.company, "channel": hub.channel,
                "delivery": hub.slack.mode, "now": hub.clock(), "ranges": list(RANGES),
                "seeded_events": getattr(hub, "seeded_events", 0)}

    @api.get("/stats")
    def stats(range: str = Query("7d")):
        if range not in RANGES:
            raise HTTPException(422, f"range must be one of {', '.join(RANGES)}")
        return state.hub.stats(range)

    @api.get("/incidents")
    def incidents(source: str | None = None, state_: str | None = Query(None, alias="state"), service: str | None = None,
                  q: str | None = None, range: str | None = None):
        hub = state.hub
        if range is not None and range not in RANGES:
            raise HTTPException(422, f"range must be one of {', '.join(RANGES)}")
        now = hub.clock()
        rows = hub.incidents(now, since=now - RANGES[range][0] if range else None)
        facets = {
            "sources": [{"id": s.id, "name": s.name} for s in hub.sources.values()],
            "services": sorted({r["service"] for r in rows}),
            "states": {k: sum(1 for r in rows if r["state"] == k) for k in ("active", "escalated", "quiet")},
        }
        total = len(rows)
        if source:
            rows = [r for r in rows if r["source"] == source]
        if state_:
            rows = [r for r in rows if r["state"] == state_]
        if service:
            rows = [r for r in rows if r["service"] == service]
        if q:
            needle = q.lower()
            rows = [r for r in rows if needle in f"{r['title']} {r['service']} {r['culprit']} {r['fingerprint']}".lower()]
        return {"incidents": rows, "total": total, "facets": facets, "now": now}

    @api.get("/incidents/{fingerprint:path}/events")
    def incident_events(fingerprint: str, from_id: int | None = None, to_id: int | None = None, limit: int = Query(200, le=1000)):
        hub = state.hub
        with hub.lock:
            return {"events": hub.store.events_for(fingerprint, from_id, to_id, limit)}

    @api.get("/incidents/{fingerprint:path}")
    def incident(fingerprint: str):
        found = state.hub.incident(fingerprint)
        if not found:
            raise HTTPException(404, "no incident with that fingerprint")
        return found

    @api.get("/outbox")
    def outbox(limit: int = Query(100, le=500)):
        hub = state.hub
        with hub.lock:
            return {"channel": hub.channel, "delivery": hub.slack.mode, "total": hub.store.delivery_count(),
                    "messages": hub.store.deliveries(limit=limit)}

    @api.get("/rules")
    def rules():
        hub = state.hub
        return {"rules": hub.rules, "sources": [{"id": s.id, "name": s.name} for s in hub.sources.values()]}

    @api.put("/rules")
    def put_rules(body: dict = Body(...)):
        try:
            return {"rules": state.hub.set_rules(body)}
        except RulesError as e:
            raise HTTPException(422, str(e))

    @api.post("/rules/preview")
    def preview(body: dict = Body(...)):
        try:
            return state.hub.preview_rules(body)
        except RulesError as e:
            raise HTTPException(422, str(e))

    @api.get("/sources")
    def sources():
        return {"sources": state.hub.source_list()}

    @api.get("/sources/{source_id}/sample")
    def sample(source_id: str, fresh: bool = False):
        """A ready to send test request. The browser posts it to the real intake, the same way Sentry or n8n would."""
        hub = state.hub
        source = hub.sources.get(source_id)
        if not source:
            raise HTTPException(404, "unknown source")
        body = json.dumps(sample_payload(source.kind, source.id, fresh), indent=2)
        headers = {"Content-Type": "application/json"}
        if source.secret:
            headers[source.signature_header] = hmac.new(source.secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        return {"method": "POST", "path": f"/hooks/{source.id}", "headers": headers, "body": body, "note": SAMPLE_NOTE[source.kind]}

    @api.post("/demo/reset")
    def reset():
        if not state.demo:
            raise HTTPException(403, "reset is only available in demo mode")
        state.reset()
        return {"ok": True, "seeded_events": state.hub.seeded_events}

    return api
