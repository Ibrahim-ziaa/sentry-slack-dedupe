"""Pull the few fields we need out of a Sentry webhook payload.

Sentry sends different shapes for "issue alert" and "issue" webhooks. We look in both places and
fall back to hashing title + culprit, so an unknown shape still gets a stable fingerprint instead
of a crash.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass
class SentryEvent:
    fingerprint: str
    title: str
    culprit: str
    level: str
    project: str
    url: str
    environment: str


def parse(payload: dict) -> SentryEvent:
    data = payload.get("data", {})
    issue = data.get("issue") or {}
    event = data.get("event") or payload.get("event") or {}

    title = issue.get("title") or event.get("title") or payload.get("message") or "Unknown error"
    culprit = issue.get("culprit") or event.get("culprit") or payload.get("culprit") or ""
    level = issue.get("level") or event.get("level") or payload.get("level") or "error"
    project = (issue.get("project") or {}).get("slug") or payload.get("project_slug") or payload.get("project") or "unknown"
    url = issue.get("web_url") or event.get("web_url") or payload.get("url") or ""
    environment = event.get("environment") or payload.get("environment") or ""

    issue_id = issue.get("id") or payload.get("id")
    if issue_id:
        fp = f"issue:{issue_id}"
    else:
        fp = "hash:" + hashlib.sha1(f"{project}|{title}|{culprit}".encode()).hexdigest()[:16]
    return SentryEvent(fp, title, culprit, level, project, url, environment)
