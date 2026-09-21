"""History: every event, the decision made about it, and every Slack delivery. SQLite, same file as the dedupe state.

The Deduper only keeps counters, which is all it needs to decide. This keeps the full record, which is what
people need to trust it: what came in, what was sent, what was held back, and which rule said so.
"""
from __future__ import annotations

import json
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL, title TEXT, service TEXT, severity TEXT, environment TEXT, culprit TEXT, url TEXT, details TEXT,
  notified INTEGER NOT NULL, rule TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL, suppressed INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_fp ON events (fingerprint, id);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, event_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL, status TEXT NOT NULL, error TEXT, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_fp ON deliveries (fingerprint, id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

EVENT_COLS = "id, ts, source, kind, fingerprint, title, service, severity, environment, culprit, url, details, notified, rule, reason, count, suppressed, window_seconds"


class Store:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # writes -----------------------------------------------------------------------------------------------------
    def add_event(self, ts: float, kind: str, ev, d, window_seconds: int) -> int:
        cur = self.db.execute(
            f"INSERT INTO events ({EVENT_COLS[4:]}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, ev.source, kind, ev.fingerprint, ev.title, ev.service, ev.severity, ev.environment, ev.culprit, ev.url, ev.details,
             int(d.notify), d.rule, d.reason, d.count, d.suppressed_since_last, window_seconds),
        )
        return cur.lastrowid

    def add_delivery(self, ts: float, event_id: int, fingerprint: str, mode: str, status: str, error: str | None, payload: dict) -> int:
        cur = self.db.execute(
            "INSERT INTO deliveries (ts, event_id, fingerprint, mode, status, error, payload) VALUES (?,?,?,?,?,?,?)",
            (ts, event_id, fingerprint, mode, status, error, json.dumps(payload)),
        )
        return cur.lastrowid

    def commit(self) -> None:
        self.db.commit()

    def get_setting(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, key: str, value) -> None:
        self.db.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
        self.db.commit()

    # reads ------------------------------------------------------------------------------------------------------
    def totals(self, since: float, until: float) -> dict:
        r = self.db.execute(
            "SELECT COUNT(*) events, COALESCE(SUM(notified),0) alerts, COUNT(DISTINCT fingerprint) incidents FROM events WHERE ts>=? AND ts<?",
            (since, until),
        ).fetchone()
        return {"events": r["events"], "alerts": r["alerts"], "suppressed": r["events"] - r["alerts"], "incidents": r["incidents"]}

    def rule_breakdown(self, since: float, until: float) -> dict:
        rows = self.db.execute("SELECT rule, COUNT(*) n FROM events WHERE ts>=? AND ts<? GROUP BY rule", (since, until)).fetchall()
        return {r["rule"]: r["n"] for r in rows}

    def buckets(self, since: float, until: float, step: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT CAST((ts-?)/? AS INTEGER) b, COUNT(*) events, SUM(notified) alerts FROM events WHERE ts>=? AND ts<? GROUP BY b",
            (since, step, since, until),
        ).fetchall()
        by = {r["b"]: r for r in rows}
        n = int((until - since + step - 1) // step)
        return [
            {"t": since + i * step, "events": by[i]["events"] if i in by else 0, "alerts": by[i]["alerts"] if i in by else 0}
            for i in range(n)
        ]

    def incidents(self, since: float | None = None, until: float | None = None) -> list[dict]:
        """One row per fingerprint. Descriptive columns come from the latest event (SQLite bare column with MAX)."""
        where, args = "", []
        if since is not None:
            where, args = "WHERE ts>=? AND ts<?", [since, until]
        rows = self.db.execute(
            f"""SELECT fingerprint, source, kind, title, service, severity, environment, culprit, url, window_seconds,
                       MAX(id) last_id, MIN(ts) first_seen, MAX(ts) last_seen, COUNT(*) events, SUM(notified) alerts,
                       SUM(rule='escalation') escalations, MAX(CASE WHEN notified=1 THEN ts END) last_alert
                FROM events {where} GROUP BY fingerprint""",
            args,
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["suppressed"] = d["events"] - d["alerts"]
            out.append(d)
        return out

    def activity(self, since: float, until: float, step: int) -> dict[str, list[int]]:
        n = int((until - since + step - 1) // step)
        out: dict[str, list[int]] = {}
        for r in self.db.execute(
            "SELECT fingerprint, CAST((ts-?)/? AS INTEGER) b, COUNT(*) n FROM events WHERE ts>=? AND ts<? GROUP BY fingerprint, b",
            (since, step, since, until),
        ):
            out.setdefault(r["fingerprint"], [0] * n)[min(r["b"], n - 1)] = r["n"]
        return out

    def events_for(self, fingerprint: str, from_id: int | None = None, to_id: int | None = None, limit: int | None = None) -> list[dict]:
        sql, args = f"SELECT {EVENT_COLS} FROM events WHERE fingerprint=?", [fingerprint]
        if from_id is not None:
            sql, args = sql + " AND id>=?", args + [from_id]
        if to_id is not None:
            sql, args = sql + " AND id<=?", args + [to_id]
        sql += " ORDER BY id"
        if limit:
            sql, args = sql + " LIMIT ?", args + [limit]
        return [dict(r) for r in self.db.execute(sql, args)]

    def deliveries(self, fingerprint: str | None = None, limit: int = 200, newest_first: bool = True) -> list[dict]:
        sql = (
            "SELECT d.id, d.ts, d.event_id, d.fingerprint, d.mode, d.status, d.error, d.payload, e.rule, e.reason, e.count, e.suppressed,"
            " e.source, e.kind, e.service, e.title, e.severity FROM deliveries d JOIN events e ON e.id=d.event_id"
        )
        args: list = []
        if fingerprint:
            sql, args = sql + " WHERE d.fingerprint=?", [fingerprint]
        sql += f" ORDER BY d.id {'DESC' if newest_first else 'ASC'} LIMIT ?"
        out = []
        for r in self.db.execute(sql, args + [limit]):
            d = dict(r)
            d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out

    def delivery_count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0]

    def source_stats(self, since: float) -> dict[str, dict]:
        rows = self.db.execute(
            """SELECT source, COUNT(*) events, SUM(notified) alerts, MAX(ts) last_seen, COUNT(DISTINCT fingerprint) incidents,
                      SUM(ts>=?) recent FROM events GROUP BY source""",
            (since,),
        ).fetchall()
        return {r["source"]: dict(r) for r in rows}

    def replay_rows(self) -> list[tuple[str, str, float]]:
        return [(r[0], r[1], r[2]) for r in self.db.execute("SELECT fingerprint, source, ts FROM events ORDER BY id")]
