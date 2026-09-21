"""The intake, the persisted decisions, and the JSON API, driven over HTTP with no network."""
import hashlib
import hmac
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from sentry_slack.app import create_app
from sentry_slack.dedupe import Deduper
from sentry_slack.hub import AlertHub, Source
from sentry_slack.slack import OutboxClient, SlackClient
from sentry_slack.store import Store

GENERIC = {"title": "Email queue depth above 5,000", "service": "email-queue", "severity": "warning", "fingerprint": "queue-depth"}
N8N = {"execution": {"id": "1", "error": {"message": "502 Bad Gateway"}, "lastNodeExecuted": "Send email"}, "workflow": {"id": "9", "name": "Dunning emails"}}


def make_hub(**kw):
    sources = [Source("sentry", "sentry"), Source("n8n", "n8n"), Source("workers", "generic", "Workers", secret=kw.pop("secret", ""))]
    return AlertHub(OutboxClient(), Deduper(window_seconds=3600), Store(), sources, **kw)


def live_client(handler=None):
    posted = []

    def ok(request: httpx.Request):
        posted.append(json.loads(request.content))
        return httpx.Response(200, text="ok")

    slack = SlackClient("https://hooks.slack.test/x", transport=httpx.MockTransport(handler or ok), backoff=0)
    return TestClient(create_app(slack=slack, deduper=Deduper(window_seconds=3600), secret="", demo=False)), posted


# persisted decisions ---------------------------------------------------------------------------------------------
def test_every_event_is_persisted_with_its_decision_and_rule():
    hub = make_hub()
    for i in range(12):
        hub.ingest("workers", GENERIC, now=1000 + i)
    hub.ingest("workers", GENERIC, now=1009 + 3600)  # the 10th alerted at t=1009, so this is exactly one window later

    rows = hub.store.events_for("workers:queue-depth")
    assert len(rows) == 13
    assert [(r["count"], r["rule"]) for r in rows if r["notified"]] == [(1, "first_occurrence"), (10, "escalation"), (13, "window_expired")]
    assert all(r["rule"] == "quiet_window" and r["reason"] == "inside quiet window" for r in rows if not r["notified"])
    assert rows[-1]["suppressed"] == 2 and rows[-1]["reason"] == "window expired, 2 suppressed"

    deliveries = hub.store.deliveries("workers:queue-depth", newest_first=False)
    assert [d["status"] for d in deliveries] == ["outbox"] * 3
    assert deliveries[1]["payload"]["blocks"][0]["text"]["text"].startswith("*Email queue depth")
    assert "Seen 10x, 8 suppressed" in deliveries[1]["payload"]["blocks"][2]["elements"][0]["text"]


def test_incident_timeline_groups_suppressed_runs_between_alerts():
    hub = make_hub()
    for i in range(12):
        hub.ingest("workers", GENERIC, now=1000 + i)
    detail = hub.incident("workers:queue-depth", now=1020)
    shape = [(t["type"], t.get("n", t.get("count"))) for t in detail["timeline"]]
    assert shape == [("alert", 1), ("suppressed", 8), ("alert", 10), ("suppressed", 2)]
    assert detail["incident"]["state"] == "escalated" and detail["incident"]["suppressed"] == 10
    assert hub.incident("workers:queue-depth", now=1011 + 3600)["incident"]["state"] == "quiet"
    assert hub.incident("nope") is None


def test_per_source_override_changes_the_decision():
    hub = make_hub()
    hub.set_rules({"window_seconds": 3600, "escalate_at": [10], "overrides": {"n8n": {"window_seconds": 60, "escalate_at": [3]}}})
    n8n = [hub.ingest("n8n", N8N, now=t) for t in (0, 10, 20, 100)]
    assert [(r["notified"], r["rule"]) for r in n8n] == [(True, "first_occurrence"), (False, "quiet_window"), (True, "escalation"), (True, "window_expired")]
    workers = [hub.ingest("workers", GENERIC, now=t) for t in (0, 10, 20, 100)]
    assert [r["notified"] for r in workers] == [True, False, False, False]


def test_rules_preview_replays_history_without_touching_it():
    hub = make_hub()
    for t in range(0, 7200, 600):  # every 10 minutes for 2 hours
        hub.ingest("workers", GENERIC, now=t)
    before = hub.store.totals(0, 10**9)
    preview = hub.preview_rules({"window_seconds": 1800, "escalate_at": [], "overrides": {}})
    assert preview["events"] == 12 and preview["current_alerts"] == before["alerts"] == 3  # first, 10th, one expiry
    assert preview["proposed_alerts"] == 4  # t=0, 1800, 3600, 5400
    assert hub.store.totals(0, 10**9) == before and hub.rules["window_seconds"] == 3600


# HTTP ------------------------------------------------------------------------------------------------------------
def test_hooks_intake_accepts_each_source_and_shares_the_dedupe_rules():
    client, posted = live_client()
    first = client.post("/hooks/n8n", json=N8N).json()
    again = client.post("/hooks/n8n", json=N8N).json()
    assert first["notified"] and first["delivered"] and first["rule"] == "first_occurrence"
    assert not again["notified"] and again["count"] == 2 and again["rule"] == "quiet_window"
    assert client.post("/hooks/custom", json=GENERIC).json()["fingerprint"] == "custom:queue-depth"
    assert client.post("/hooks/sentry", json={"message": "boom", "project": "api"}).json()["notified"]
    assert len(posted) == 3 and "Dunning emails" in posted[0]["text"]

    assert client.post("/hooks/unknown", json=GENERIC).status_code == 404
    assert client.post("/hooks/custom", json={"service": "no title"}).status_code == 422
    assert client.post("/hooks/custom", content=b"not json").status_code == 400


def test_hook_secret_accepts_hmac_or_bearer_and_rejects_the_rest(monkeypatch):
    monkeypatch.setenv("HOOK_SECRET_CUSTOM", "s3cret")
    client, _ = live_client()
    body = json.dumps(GENERIC).encode()
    headers = {"content-type": "application/json"}
    assert client.post("/hooks/custom", content=body, headers=headers).status_code == 401
    sig = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert client.post("/hooks/custom", content=body, headers={**headers, "X-Signature": sig}).status_code == 200
    assert client.post("/hooks/custom", content=body, headers={**headers, "Authorization": "Bearer s3cret"}).status_code == 200
    assert client.post("/hooks/custom", content=body, headers={**headers, "Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/incidents").json()["incidents"][0]["events"] == 2  # rejected calls were not counted


def test_failed_slack_delivery_is_recorded_not_lost():
    client, _ = live_client(lambda request: httpx.Response(503, text="slack is down"))
    r = client.post("/hooks/custom", json=GENERIC)
    assert r.status_code == 200 and r.json()["notified"] and r.json()["delivered"] is False
    message = client.get("/api/outbox").json()["messages"][0]
    assert message["status"] == "failed" and "503" in message["error"]


def test_stats_endpoint_is_computed_from_persisted_events():
    client, _ = live_client()
    for _ in range(25):
        client.post("/hooks/custom", json=GENERIC)
    client.post("/hooks/n8n", json=N8N)

    stats = client.get("/api/stats?range=24h").json()
    assert stats["totals"] == {"events": 26, "alerts": 3, "suppressed": 23, "incidents": 2, "reduction_pct": 88.5}
    assert stats["rules_fired"] == {"first_occurrence": 2, "escalation": 1, "quiet_window": 23}
    assert sum(b["events"] for b in stats["buckets"]) == 26 and sum(b["alerts"] for b in stats["buckets"]) == 3
    assert len(stats["buckets"]) == 24 and stats["step"] == 3600
    assert stats["top_noisy"][0]["fingerprint"] == "custom:queue-depth" and stats["top_noisy"][0]["suppressed"] == 23
    by_source = {s["id"]: s for s in stats["sources"]}
    assert by_source["custom"]["events"] == 25 and by_source["n8n"]["alerts"] == 1 and by_source["sentry"]["last_seen"] is None
    assert client.get("/api/stats?range=1y").status_code == 422


def test_empty_stats_do_not_divide_by_zero():
    client, _ = live_client()
    totals = client.get("/api/stats").json()["totals"]
    assert totals["events"] == 0 and totals["reduction_pct"] is None


def test_incident_list_filters_and_detail_endpoint():
    client, _ = live_client()
    for _ in range(3):
        client.post("/hooks/custom", json=GENERIC)
    client.post("/hooks/n8n", json=N8N)

    assert len(client.get("/api/incidents").json()["incidents"]) == 2
    only = client.get("/api/incidents?source=n8n").json()
    assert [i["service"] for i in only["incidents"]] == ["Dunning emails"] and only["total"] == 2
    assert client.get("/api/incidents?q=queue").json()["incidents"][0]["suppressed"] == 2
    assert client.get("/api/incidents?state=quiet").json()["incidents"] == []

    detail = client.get("/api/incidents/custom:queue-depth").json()
    assert [t["type"] for t in detail["timeline"]] == ["alert", "suppressed"] and len(detail["deliveries"]) == 1
    run = detail["timeline"][1]
    events = client.get(f"/api/incidents/custom:queue-depth/events?from_id={run['from_id']}&to_id={run['to_id']}").json()["events"]
    assert [e["count"] for e in events] == [2, 3]
    assert client.get("/api/incidents/custom:missing").status_code == 404


def test_rules_api_validates_and_applies():
    client, _ = live_client()
    assert client.get("/api/rules").json()["rules"] == {"window_seconds": 3600, "escalate_at": [10, 100, 1000], "overrides": {}}
    assert client.put("/api/rules", json={"window_seconds": 5, "escalate_at": [10], "overrides": {}}).status_code == 422
    assert client.put("/api/rules", json={"window_seconds": 600, "escalate_at": [10], "overrides": {"ghost": {"window_seconds": 60}}}).status_code == 422
    ok = client.put("/api/rules", json={"window_seconds": 600, "escalate_at": [3, 3, 2], "overrides": {}})
    assert ok.status_code == 200 and ok.json()["rules"]["escalate_at"] == [2, 3]
    assert [client.post("/hooks/custom", json=GENERIC).json()["notified"] for _ in range(4)] == [True, True, True, False]


def test_sample_request_is_accepted_by_the_real_intake(monkeypatch):
    monkeypatch.setenv("HOOK_SECRET_N8N", "abc")
    client, _ = live_client()
    for source in ("sentry", "n8n", "custom"):
        sample = client.get(f"/api/sources/{source}/sample").json()
        r = client.post(sample["path"], content=sample["body"], headers=sample["headers"])
        assert r.status_code == 200 and r.json()["notified"], source
    listed = {s["id"]: s for s in client.get("/api/sources").json()["sources"]}
    assert listed["n8n"]["signature_required"] and not listed["custom"]["signature_required"]
    assert listed["n8n"]["events"] == 1 and listed["n8n"]["path"] == "/hooks/n8n"


# demo mode -------------------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def demo():
    return TestClient(create_app(demo=True))


def test_demo_numbers_all_come_from_the_replay(demo):
    meta = demo.get("/api/meta").json()
    stats = demo.get("/api/stats?range=7d").json()
    incidents = demo.get("/api/incidents").json()["incidents"]
    outbox = demo.get("/api/outbox").json()

    assert meta["demo"] and meta["delivery"] == "outbox" and meta["seeded_events"] > 2000
    t = stats["totals"]
    assert t["events"] == meta["seeded_events"] == sum(i["events"] for i in incidents)
    assert t["alerts"] == outbox["total"] == sum(i["alerts"] for i in incidents)
    assert t["suppressed"] == t["events"] - t["alerts"] and t["reduction_pct"] == round(100 * t["suppressed"] / t["events"], 1)
    assert {i["kind"] for i in incidents} == {"sentry", "n8n", "generic"}
    assert {i["state"] for i in incidents} == {"active", "escalated", "quiet"}


def test_demo_replay_is_deterministic_and_reset_restores_it(demo):
    before = demo.get("/api/stats?range=7d").json()["totals"]
    sample = demo.get("/api/sources/uptime/sample?fresh=true").json()
    assert demo.post(sample["path"], content=sample["body"], headers=sample["headers"]).json()["notified"]
    assert demo.get("/api/stats?range=7d").json()["totals"]["events"] == before["events"] + 1
    assert demo.post("/api/demo/reset").status_code == 200
    assert demo.get("/api/stats?range=7d").json()["totals"] == before


def test_demo_sources_enforce_their_signature(demo):
    assert demo.post("/hooks/sentry", json={"message": "unsigned"}).status_code == 401
    assert demo.post("/sentry", json={"message": "unsigned"}).status_code == 401


def test_reset_is_refused_outside_demo_mode():
    client, _ = live_client()
    assert client.post("/api/demo/reset").status_code == 403
