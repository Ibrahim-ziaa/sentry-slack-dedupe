from __future__ import annotations

import httpx

from .dedupe import Decision
from .sentry import SentryEvent

LEVEL_EMOJI = {"fatal": ":rotating_light:", "error": ":red_circle:", "warning": ":large_orange_circle:", "info": ":large_blue_circle:"}


def format_message(ev: SentryEvent, d: Decision) -> dict:
    head = f"{LEVEL_EMOJI.get(ev.level, ':white_circle:')} *{ev.project}*"
    if ev.environment:
        head += f" ({ev.environment})"
    lines = [head, f"*{ev.title}*"]
    if ev.culprit:
        lines.append(f"`{ev.culprit}`")
    if d.count > 1:
        lines.append(f"seen {d.count}x, {d.suppressed_since_last} suppressed since last alert ({d.reason})")
    if ev.url:
        lines.append(f"<{ev.url}|open in Sentry>")
    return {"text": "\n".join(lines)}


class SlackClient:
    def __init__(self, webhook_url: str, transport: httpx.BaseTransport | None = None):
        self.url = webhook_url
        self._client = httpx.Client(transport=transport, timeout=10)

    def post(self, message: dict) -> None:
        r = self._client.post(self.url, json=message)
        r.raise_for_status()
