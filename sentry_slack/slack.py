"""Slack message format and delivery.

The message is Block Kit plus a plain `text` fallback (Slack uses the fallback for notifications).
Delivery sits behind one small interface, `post(message)`, so demo mode can swap the network for an
in app outbox without the rest of the code noticing.
"""
from __future__ import annotations

import time

import httpx

from .dedupe import ESCALATION, FIRST, WINDOW_EXPIRED, Decision
from .events import Event

LEVEL_EMOJI = {"fatal": ":rotating_light:", "error": ":red_circle:", "warning": ":large_orange_circle:", "info": ":large_blue_circle:"}
LINK_LABEL = {"sentry": "Open in Sentry", "n8n": "Open execution in n8n"}


def dedupe_line(d: Decision) -> str:
    if d.rule == FIRST or d.count <= 1:
        return "First occurrence. Repeats are held back and counted."
    if d.rule == ESCALATION:
        return f"Seen {d.count}x, {d.suppressed_since_last} suppressed since last alert. Escalated: it keeps firing."
    if d.rule == WINDOW_EXPIRED:
        return f"Seen {d.count}x, {d.suppressed_since_last} suppressed since last alert. Quiet window ran out and it fired again."
    return f"Seen {d.count}x, {d.suppressed_since_last} suppressed since last alert."


def format_message(ev: Event, d: Decision, source_label: str | None = None) -> dict:
    # Plain text fallback, same shape as the original bridge.
    head = f"{LEVEL_EMOJI.get(ev.severity, ':white_circle:')} *{ev.service}*"
    if ev.environment:
        head += f" ({ev.environment})"
    lines = [head, f"*{ev.title}*"]
    if ev.culprit:
        lines.append(f"`{ev.culprit}`")
    if d.count > 1:
        lines.append(f"seen {d.count}x, {d.suppressed_since_last} suppressed since last alert ({d.reason})")
    if ev.url:
        lines.append(f"<{ev.url}|{LINK_LABEL.get(ev.source, 'Open details')}>")

    title = f"*{ev.title}*"
    if ev.culprit:
        title += f"\n`{ev.culprit}`"
    service = f"{ev.service} ({ev.environment})" if ev.environment else ev.service
    fields = [f"*Service*\n{service}", f"*Severity*\n{ev.severity.capitalize()}"]
    blocks: list[dict] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": title}},
        {"type": "section", "fields": [{"type": "mrkdwn", "text": f} for f in fields]},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": dedupe_line(d)}, {"type": "mrkdwn", "text": f"via {source_label or ev.source}"}]},
    ]
    if ev.url:
        blocks.append({
            "type": "actions",
            "elements": [{"type": "button", "text": {"type": "plain_text", "text": LINK_LABEL.get(ev.source, "Open details")}, "url": ev.url}],
        })
    return {"text": "\n".join(lines), "blocks": blocks}


class SlackClient:
    """Posts to a Slack incoming webhook. Retries on network errors and 5xx, because a lost alert is the worst outcome."""

    mode = "slack"

    def __init__(self, webhook_url: str, transport: httpx.BaseTransport | None = None, retries: int = 2, backoff: float = 0.5):
        self.url = webhook_url
        self.retries = retries
        self.backoff = backoff
        self._client = httpx.Client(transport=transport, timeout=10)

    def post(self, message: dict) -> None:
        for attempt in range(self.retries + 1):
            try:
                r = self._client.post(self.url, json=message)
                if r.status_code < 500:
                    r.raise_for_status()
                    return
                error: Exception = httpx.HTTPStatusError(f"Slack answered {r.status_code}", request=r.request, response=r)
            except httpx.TransportError as e:
                error = e
            if attempt < self.retries:
                time.sleep(self.backoff * (2**attempt))
        raise error


class OutboxClient:
    """Demo mode delivery: nothing leaves the process. The hub records every message, so the UI can show them."""

    mode = "outbox"

    def post(self, message: dict) -> None:
        return None
