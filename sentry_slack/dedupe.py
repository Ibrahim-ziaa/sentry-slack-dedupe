"""Decide whether an event deserves a Slack message.

Rules (all in one place so they can be tested without Slack or Sentry):
- First occurrence of a fingerprint: notify.
- Repeats inside the quiet window: silent, but count them.
- Escalation counts (10th, 100th, 1000th occurrence): notify even inside the window, with the count.
- After the window expires: notify again, with how many were suppressed.

State is SQLite so a restart does not re-alert everything that is already known.
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from typing import Iterable

ESCALATE_AT = (10, 100, 1000)

# Stable codes for the rule that decided an event. The reason string is for people, the code is for the UI and API.
FIRST, QUIET, ESCALATION, WINDOW_EXPIRED = "first_occurrence", "quiet_window", "escalation", "window_expired"


@dataclass
class Decision:
    notify: bool
    count: int
    suppressed_since_last: int
    reason: str
    rule: str = ""


def ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


class Deduper:
    def __init__(self, path: str = ":memory:", window_seconds: int = 3600, escalate_at: Iterable[int] = ESCALATE_AT):
        self.window = window_seconds
        self.escalate_at = tuple(escalate_at)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS seen (fp TEXT PRIMARY KEY, count INTEGER, last_notified REAL, notified_count INTEGER)"
        )

    def decide(
        self, fingerprint: str, now: float | None = None, window_seconds: int | None = None, escalate_at: Iterable[int] | None = None
    ) -> Decision:
        """window_seconds and escalate_at override the defaults for this one call (per source rules)."""
        now = time.time() if now is None else now
        window = self.window if window_seconds is None else window_seconds
        thresholds = self.escalate_at if escalate_at is None else tuple(escalate_at)
        row = self.db.execute("SELECT count, last_notified, notified_count FROM seen WHERE fp=?", (fingerprint,)).fetchone()
        if row is None:
            self.db.execute("INSERT INTO seen VALUES (?,?,?,?)", (fingerprint, 1, now, 1))
            self.db.commit()
            return Decision(True, 1, 0, "first occurrence", FIRST)

        count, last_notified, notified_count = row[0] + 1, row[1], row[2]
        suppressed = count - notified_count - 1
        if count in thresholds:
            reason, rule = f"escalation: {ordinal(count)} occurrence", ESCALATION
        elif now - last_notified >= window:
            reason, rule = f"window expired, {suppressed} suppressed", WINDOW_EXPIRED
        else:
            self.db.execute("UPDATE seen SET count=? WHERE fp=?", (count, fingerprint))
            self.db.commit()
            return Decision(False, count, suppressed, "inside quiet window", QUIET)

        self.db.execute("UPDATE seen SET count=?, last_notified=?, notified_count=? WHERE fp=?", (count, now, count, fingerprint))
        self.db.commit()
        return Decision(True, count, suppressed, reason, rule)
