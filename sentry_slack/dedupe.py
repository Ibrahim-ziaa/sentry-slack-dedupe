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

ESCALATE_AT = (10, 100, 1000)


@dataclass
class Decision:
    notify: bool
    count: int
    suppressed_since_last: int
    reason: str


class Deduper:
    def __init__(self, path: str = ":memory:", window_seconds: int = 3600):
        self.window = window_seconds
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS seen (fp TEXT PRIMARY KEY, count INTEGER, last_notified REAL, notified_count INTEGER)"
        )

    def decide(self, fingerprint: str, now: float | None = None) -> Decision:
        now = time.time() if now is None else now
        row = self.db.execute("SELECT count, last_notified, notified_count FROM seen WHERE fp=?", (fingerprint,)).fetchone()
        if row is None:
            self.db.execute("INSERT INTO seen VALUES (?,?,?,?)", (fingerprint, 1, now, 1))
            self.db.commit()
            return Decision(True, 1, 0, "first occurrence")

        count, last_notified, notified_count = row[0] + 1, row[1], row[2]
        suppressed = count - notified_count - 1
        if count in ESCALATE_AT:
            reason = f"escalation: {count}th occurrence"
        elif now - last_notified >= self.window:
            reason = f"window expired, {suppressed} suppressed"
        else:
            self.db.execute("UPDATE seen SET count=? WHERE fp=?", (count, fingerprint))
            self.db.commit()
            return Decision(False, count, suppressed, "inside quiet window")

        self.db.execute("UPDATE seen SET count=?, last_notified=?, notified_count=? WHERE fp=?", (count, now, count, fingerprint))
        self.db.commit()
        return Decision(True, count, suppressed, reason)
