"""Small parsers, one per kind of source. Each returns the same Event, so every source shares one set of rules.

kinds:
  sentry   Sentry issue and issue alert webhooks
  n8n      the JSON an n8n Error Trigger node produces, forwarded with an HTTP Request node
  generic  {"title", "service", "severity", "fingerprint"?, "details"?, "url"?, "environment"?}
"""
from __future__ import annotations

import json
from typing import Callable

from .events import Event, clean_severity, stable_hash
from .sentry import parse as parse_sentry


class PayloadError(ValueError):
    """The payload cannot be turned into an event. The intake answers 422 with this message."""


def parse_n8n(payload: dict | list) -> Event:
    # n8n items often arrive wrapped in a list, or under "json" when a whole item is forwarded.
    if isinstance(payload, list):
        if not payload:
            raise PayloadError("empty n8n payload")
        payload = payload[0]
    if isinstance(payload, dict) and isinstance(payload.get("json"), dict):
        payload = payload["json"]
    if not isinstance(payload, dict):
        raise PayloadError("n8n payload must be a JSON object")

    workflow = payload.get("workflow") or {}
    execution = payload.get("execution") or {}
    trigger = payload.get("trigger") or {}  # workflows that fail in their trigger node have no execution
    error = execution.get("error") or trigger.get("error") or {}
    if not workflow and not error:
        raise PayloadError("not an n8n error workflow payload: expected 'workflow' and 'execution.error'")

    name = str(workflow.get("name") or "Unnamed workflow")
    wf_id = str(workflow.get("id") or name)
    node = str(execution.get("lastNodeExecuted") or (error.get("node") or {}).get("name") or ("trigger" if trigger else ""))
    message = str(error.get("message") or error.get("description") or "Workflow execution failed")

    facts = []
    if node:
        facts.append(f"Failed node: {node}")
    if execution.get("id"):
        facts.append(f"Execution: {execution['id']}")
    if execution.get("retryOf"):
        facts.append(f"Retry of: {execution['retryOf']}")
    mode = execution.get("mode") or trigger.get("mode")
    if mode:
        facts.append(f"Mode: {mode}")

    return Event(
        fingerprint=f"n8n:{wf_id}:{stable_hash(node, message)}",
        title=message, service=name, severity="error", source="n8n",
        culprit=node, url=str(execution.get("url") or ""), details="\n".join(facts),
    )


def parse_generic(payload: dict, source: str = "custom") -> Event:
    if not isinstance(payload, dict):
        raise PayloadError("payload must be a JSON object")
    title = str(payload.get("title") or payload.get("message") or "").strip()
    if not title:
        raise PayloadError("'title' is required")
    service = str(payload.get("service") or "unknown")
    given = str(payload.get("fingerprint") or "").strip()
    details = payload.get("details") or ""
    if not isinstance(details, str):
        details = json.dumps(details, indent=2, sort_keys=True)
    return Event(
        fingerprint=f"{source}:{given}" if given else f"{source}:{stable_hash(service, title)}",
        title=title, service=service, severity=clean_severity(payload.get("severity")), source=source,
        environment=str(payload.get("environment") or ""), url=str(payload.get("url") or ""), details=details,
    )


def _sentry(payload, source: str) -> Event:
    if not isinstance(payload, dict):
        raise PayloadError("payload must be a JSON object")
    ev = parse_sentry(payload)
    ev.source = source
    return ev


def _n8n(payload, source: str) -> Event:
    ev = parse_n8n(payload)
    ev.source = source
    return ev


PARSERS: dict[str, Callable[[object, str], Event]] = {"sentry": _sentry, "n8n": _n8n, "generic": parse_generic}
KIND_LABELS = {"sentry": "Sentry", "n8n": "n8n", "generic": "Custom"}
