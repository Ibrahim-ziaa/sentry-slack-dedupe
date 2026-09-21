"""The intake pipeline every source shares: parse, fingerprint, decide, record, deliver.

    payload -> parser for the source kind -> Event -> Deduper.decide (rules for that source)
            -> events table (what happened and why) -> Slack client or demo outbox -> deliveries table
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

from .dedupe import ESCALATE_AT, Deduper
from .parsers import KIND_LABELS, PARSERS, PayloadError
from .slack import format_message
from .store import Store

RANGES = {"24h": (24 * 3600, 3600), "3d": (72 * 3600, 2 * 3600), "7d": (7 * 24 * 3600, 2 * 3600)}


@dataclass
class Source:
    id: str
    kind: str  # sentry | n8n | generic
    name: str = ""
    description: str = ""
    secret: str = ""
    signature_header: str = field(init=False, default="")

    def __post_init__(self):
        if self.kind not in PARSERS:
            raise ValueError(f"unknown source kind {self.kind!r}")
        self.name = self.name or KIND_LABELS[self.kind]
        self.signature_header = "Sentry-Hook-Signature" if self.kind == "sentry" else "X-Signature"


class RulesError(ValueError):
    pass


def clean_rules(raw: dict, source_ids: set[str]) -> dict:
    """Validate rules coming from the API. Returns the normalized document or raises RulesError."""

    def window(v):
        if isinstance(v, bool) or not isinstance(v, int) or not 60 <= v <= 7 * 24 * 3600:
            raise RulesError("quiet window must be between 1 minute and 7 days")
        return v

    def thresholds(v):
        if not isinstance(v, list) or len(v) > 6 or any(isinstance(n, bool) or not isinstance(n, int) or n < 2 or n > 1_000_000 for n in v):
            raise RulesError("escalation thresholds must be up to 6 whole numbers, each 2 or more")
        return sorted(set(v))

    if not isinstance(raw, dict):
        raise RulesError("rules must be an object")
    out = {"window_seconds": window(raw.get("window_seconds")), "escalate_at": thresholds(raw.get("escalate_at")), "overrides": {}}
    for sid, o in (raw.get("overrides") or {}).items():
        if sid not in source_ids:
            raise RulesError(f"unknown source {sid!r}")
        clean = {}
        if o.get("window_seconds") is not None:
            clean["window_seconds"] = window(o["window_seconds"])
        if o.get("escalate_at") is not None:
            clean["escalate_at"] = thresholds(o["escalate_at"])
        if clean:
            out["overrides"][sid] = clean
    return out


class AlertHub:
    def __init__(self, slack, deduper: Deduper | None = None, store: Store | None = None, sources: list[Source] | None = None,
                 channel: str = "#alerts", clock=time.time):
        self.slack = slack
        self.clock = clock  # demo mode pins this so the replayed week is identical on every start
        self.deduper = deduper or Deduper()
        self.store = store or Store()
        self.channel = channel
        self.sources: dict[str, Source] = {s.id: s for s in (sources or default_sources())}
        self.lock = threading.RLock()
        if self.store.get_setting("rules") is None:
            self.store.set_setting("rules", {"window_seconds": self.deduper.window, "escalate_at": list(self.deduper.escalate_at), "overrides": {}})

    # rules ------------------------------------------------------------------------------------------------------
    @property
    def rules(self) -> dict:
        return self.store.get_setting("rules")

    def set_rules(self, raw: dict) -> dict:
        with self.lock:
            rules = clean_rules(raw, set(self.sources))
            self.store.set_setting("rules", rules)
            return rules

    @staticmethod
    def effective(rules: dict, source_id: str) -> tuple[int, tuple[int, ...]]:
        o = rules["overrides"].get(source_id, {})
        return o.get("window_seconds", rules["window_seconds"]), tuple(o.get("escalate_at", rules["escalate_at"]))

    # intake -----------------------------------------------------------------------------------------------------
    def ingest(self, source_id: str, payload, now: float | None = None) -> dict:
        source = self.sources[source_id]
        ev = PARSERS[source.kind](payload, source.id)  # raises PayloadError
        now = self.clock() if now is None else now
        with self.lock:
            window, thresholds = self.effective(self.rules, source.id)
            d = self.deduper.decide(ev.fingerprint, now=now, window_seconds=window, escalate_at=thresholds)
            event_id = self.store.add_event(now, source.kind, ev, d, window)
            delivered = None
            if d.notify:
                message = format_message(ev, d, source.name)
                try:
                    self.slack.post(message)
                    status, error = ("outbox" if self.slack.mode == "outbox" else "sent"), None
                except Exception as e:  # a Slack outage must not turn into webhook retries that double count events
                    status, error = "failed", str(e)
                self.store.add_delivery(now, event_id, ev.fingerprint, self.slack.mode, status, error, message)
                delivered = status != "failed"
            self.store.commit()
        return {
            "event_id": event_id, "source": source.id, "fingerprint": ev.fingerprint, "notified": d.notify, "delivered": delivered,
            "count": d.count, "suppressed_since_last": d.suppressed_since_last, "rule": d.rule, "reason": d.reason,
        }

    # read models ------------------------------------------------------------------------------------------------
    def _state(self, inc: dict, now: float, rules: dict) -> str:
        window, _ = self.effective(rules, inc["source"])
        if now - inc["last_seen"] >= window:
            return "quiet"
        return "escalated" if inc["escalations"] else "active"

    def incidents(self, now: float | None = None, since: float | None = None) -> list[dict]:
        now = self.clock() if now is None else now
        with self.lock:
            rules = self.rules
            rows = self.store.incidents(since, now + 1) if since is not None else self.store.incidents()
            spark_since = now - 7 * 24 * 3600
            activity = self.store.activity(spark_since, now + 1, 6 * 3600)
        for r in rows:
            r["state"] = self._state(r, now, rules)
            r["kind_label"] = KIND_LABELS[r["kind"]]
            r["source_name"] = self.sources[r["source"]].name if r["source"] in self.sources else r["source"]
            r["activity"] = activity.get(r["fingerprint"], [0] * 28)
        rows.sort(key=lambda r: r["last_seen"], reverse=True)
        return rows

    def incident(self, fingerprint: str, now: float | None = None) -> dict | None:
        now = self.clock() if now is None else now
        with self.lock:
            events = self.store.events_for(fingerprint)
            if not events:
                return None
            deliveries = self.store.deliveries(fingerprint, limit=500, newest_first=False)
            summary = next(i for i in self.incidents(now) if i["fingerprint"] == fingerprint)
        by_event = {d["event_id"]: d["id"] for d in deliveries}
        timeline: list[dict] = []
        for e in events:
            if e["notified"]:
                timeline.append({"type": "alert", "event_id": e["id"], "ts": e["ts"], "count": e["count"], "rule": e["rule"],
                                 "reason": e["reason"], "suppressed": e["suppressed"], "window_seconds": e["window_seconds"],
                                 "delivery_id": by_event.get(e["id"])})
            elif timeline and timeline[-1]["type"] == "suppressed":
                run = timeline[-1]
                run.update(n=run["n"] + 1, to_ts=e["ts"], to_id=e["id"], to_count=e["count"])
            else:
                timeline.append({"type": "suppressed", "n": 1, "rule": e["rule"], "from_ts": e["ts"], "to_ts": e["ts"], "from_id": e["id"],
                                 "to_id": e["id"], "from_count": e["count"], "to_count": e["count"], "window_seconds": e["window_seconds"]})
        latest = events[-1]
        summary["details"] = latest["details"]
        return {"incident": summary, "timeline": timeline, "deliveries": deliveries, "channel": self.channel, "now": now}

    def stats(self, range_key: str = "7d", now: float | None = None) -> dict:
        span, step = RANGES[range_key]
        now = self.clock() if now is None else now
        # end the range on the next full hour so bucket edges do not shimmer between reloads
        until = (int(now) // 3600 + 1) * 3600
        since = until - span
        with self.lock:
            totals = self.store.totals(since, until)
            buckets = self.store.buckets(since, until, step)
            breakdown = self.store.rule_breakdown(since, until)
            in_range = self.store.incidents(since, until)
            per_source = self.store.source_stats(since)
        totals["reduction_pct"] = round(100 * totals["suppressed"] / totals["events"], 1) if totals["events"] else None
        noisy = sorted(in_range, key=lambda r: r["events"], reverse=True)[:6]
        top = [{k: r[k] for k in ("fingerprint", "title", "service", "source", "kind", "severity", "events", "alerts", "suppressed")}
               | {"kind_label": KIND_LABELS[r["kind"]]} for r in noisy]
        sources = []
        range_by_source: dict[str, dict] = {}
        for r in in_range:
            agg = range_by_source.setdefault(r["source"], {"events": 0, "alerts": 0, "incidents": 0})
            agg["events"] += r["events"]; agg["alerts"] += r["alerts"]; agg["incidents"] += 1
        for s in self.sources.values():
            agg = range_by_source.get(s.id, {"events": 0, "alerts": 0, "incidents": 0})
            sources.append({"id": s.id, "name": s.name, "kind": s.kind, "kind_label": KIND_LABELS[s.kind], **agg,
                            "last_seen": per_source.get(s.id, {}).get("last_seen")})
        return {"range": range_key, "since": since, "until": until, "step": step, "now": now, "totals": totals, "buckets": buckets,
                "rules_fired": breakdown, "top_noisy": top, "sources": sources}

    def preview_rules(self, raw: dict) -> dict:
        """Replay every stored event through a scratch Deduper twice: with the saved rules and with the proposed ones."""
        proposed = clean_rules(raw, set(self.sources))
        with self.lock:
            rows = self.store.replay_rows()
            current = self.rules

        def simulate(rules: dict) -> dict[str, int]:
            scratch, sent = Deduper(), {}
            for fp, source, ts in rows:
                window, thresholds = self.effective(rules, source)
                if scratch.decide(fp, now=ts, window_seconds=window, escalate_at=thresholds).notify:
                    sent[source] = sent.get(source, 0) + 1
            return sent

        cur, new = simulate(current), simulate(proposed)
        events_by_source: dict[str, int] = {}
        for _, source, _ in rows:
            events_by_source[source] = events_by_source.get(source, 0) + 1
        return {
            "events": len(rows), "current_alerts": sum(cur.values()), "proposed_alerts": sum(new.values()),
            "by_source": [{"id": s, "events": events_by_source.get(s, 0), "current_alerts": cur.get(s, 0), "proposed_alerts": new.get(s, 0)}
                          for s in self.sources],
        }

    def source_list(self, now: float | None = None) -> list[dict]:
        now = self.clock() if now is None else now
        with self.lock:
            stats = self.store.source_stats(now - 24 * 3600)
            rules = self.rules
        out = []
        for s in self.sources.values():
            st = stats.get(s.id, {})
            window, thresholds = self.effective(rules, s.id)
            out.append({
                "id": s.id, "name": s.name, "kind": s.kind, "kind_label": KIND_LABELS[s.kind], "description": s.description,
                "path": f"/hooks/{s.id}", "signature_required": bool(s.secret), "signature_header": s.signature_header,
                "events": st.get("events", 0), "alerts": st.get("alerts", 0) or 0, "incidents": st.get("incidents", 0),
                "events_24h": st.get("recent", 0) or 0, "last_seen": st.get("last_seen"),
                "window_seconds": window, "escalate_at": list(thresholds), "has_override": s.id in rules["overrides"],
            })
        return out


def default_sources(sentry_secret: str = "") -> list[Source]:
    return [
        Source("sentry", "sentry", "Sentry", "Application errors from Sentry issue alerts.", sentry_secret),
        Source("n8n", "n8n", "n8n", "Failed workflow executions, sent by an n8n error workflow."),
        Source("custom", "generic", "Custom webhook", "Anything that can POST JSON: cron jobs, workers, Zapier or Make scenarios."),
    ]


__all__ = ["AlertHub", "Source", "RulesError", "PayloadError", "RANGES", "ESCALATE_AT", "default_sources"]
