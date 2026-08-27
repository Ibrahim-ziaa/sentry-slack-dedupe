import hashlib
import hmac
import json

import httpx
from fastapi.testclient import TestClient

from sentry_slack.app import create_app
from sentry_slack.dedupe import Deduper
from sentry_slack.sentry import parse
from sentry_slack.slack import SlackClient

ISSUE_ALERT = {"action": "triggered", "data": {"event": {"title": "ZeroDivisionError: division by zero", "culprit": "billing.compute_total", "level": "error", "environment": "prod", "web_url": "https://sentry.io/x/1"}, "issue": {"id": "4242", "title": "ZeroDivisionError: division by zero", "culprit": "billing.compute_total", "level": "error", "project": {"slug": "api"}, "web_url": "https://sentry.io/x/1"}}}


def make(secret=None):
    posted = []

    def handler(request: httpx.Request):
        posted.append(json.loads(request.content))
        return httpx.Response(200, text="ok")

    slack = SlackClient("https://hooks.slack.com/test", transport=httpx.MockTransport(handler))
    app = create_app(slack=slack, deduper=Deduper(window_seconds=3600), secret=secret or "")
    return TestClient(app), posted


def test_parse_uses_issue_id_as_fingerprint_and_falls_back_to_hash():
    assert parse(ISSUE_ALERT).fingerprint == "issue:4242"
    fp = parse({"message": "boom", "culprit": "x", "project": "p"}).fingerprint
    assert fp.startswith("hash:") and fp == parse({"message": "boom", "culprit": "x", "project": "p"}).fingerprint


def test_one_bug_one_message():
    client, posted = make()
    for _ in range(40):
        client.post("/sentry", json=ISSUE_ALERT)
    assert len(posted) == 2  # first occurrence + 10th escalation
    assert "api" in posted[0]["text"] and "ZeroDivisionError" in posted[0]["text"]
    assert "seen 10x" in posted[1]["text"]


def test_signature_is_enforced_when_secret_set():
    client, posted = make(secret="s3cret")
    body = json.dumps(ISSUE_ALERT).encode()
    assert client.post("/sentry", content=body, headers={"content-type": "application/json"}).status_code == 401
    sig = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    r = client.post("/sentry", content=body, headers={"content-type": "application/json", "Sentry-Hook-Signature": sig})
    assert r.status_code == 200 and len(posted) == 1
