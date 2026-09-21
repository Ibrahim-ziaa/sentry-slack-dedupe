"""Demo mode: a scripted week of traffic for a fictional company, replayed through the real intake.

Nothing here writes to the database directly. Every event is a raw payload in its source's own shape
(a Sentry issue alert, an n8n error workflow item, a plain JSON post) handed to AlertHub.ingest with an
injected timestamp, so the parsers, fingerprints, dedupe rules, Slack formatting and outbox all run for
real. Every number the UI shows is whatever that replay produced.

Fernhill is made up: a small SaaS that sells class booking software to fitness studios.
"""
from __future__ import annotations

import random
import time
from datetime import datetime, timedelta

from .dedupe import Deduper
from .hub import AlertHub, Source
from .slack import OutboxClient
from .store import Store

COMPANY = "Fernhill"
DEMO_SECRET = "demo-signing-secret"
DAY = 86400
DEMO_TIME_OF_DAY = (15, 40)

DEMO_RULES = {
    "window_seconds": 3600,
    "escalate_at": [10, 100, 1000],
    "overrides": {
        "n8n": {"window_seconds": 4 * 3600},  # scheduled workflows fail on a cadence; hourly reminders are noise
        "uptime": {"window_seconds": 2 * 3600, "escalate_at": [10, 50, 250]},
    },
}


def demo_sources() -> list[Source]:
    return [
        Source("sentry", "sentry", "Production apps", "Application errors from the web app, API, mobile app and billing worker.", DEMO_SECRET),
        Source("n8n", "n8n", "Ops automations", "Failed executions from the ops automations, sent by one shared error workflow.", DEMO_SECRET),
        Source("workers", "generic", "Background workers", "Queue, cron and webhook dispatcher failures, posted as plain JSON.", DEMO_SECRET),
        Source("uptime", "generic", "Uptime checks", "Health probes for third party integrations and public endpoints."),
    ]


def demo_now(real_now: float | None = None) -> float:
    """The most recent 15:40 local time. Pinning the time of day makes the replay identical on every start."""
    real = datetime.fromtimestamp(time.time() if real_now is None else real_now)
    pinned = real.replace(hour=DEMO_TIME_OF_DAY[0], minute=DEMO_TIME_OF_DAY[1], second=0, microsecond=0)
    if pinned > real:
        pinned -= timedelta(days=1)
    return pinned.timestamp()


# payload builders, one per source shape ----------------------------------------------------------------------------
def sentry_payload(issue_id: int, title: str, culprit: str, project: str, level: str = "error") -> dict:
    url = f"https://sentry.example/organizations/fernhill/issues/{issue_id}/"
    shared = {"title": title, "culprit": culprit, "level": level, "web_url": url}
    return {"action": "triggered", "data": {"event": {**shared, "environment": "production"},
                                            "issue": {**shared, "id": str(issue_id), "project": {"slug": project}}}}


def n8n_payload(wf_id: str, wf_name: str, node: str, message: str, execution_id: int, retry_of: int | None = None) -> dict:
    execution = {"id": str(execution_id), "url": f"https://n8n.fernhill.example/workflow/{wf_id}/executions/{execution_id}",
                 "error": {"message": message, "name": "NodeApiError"}, "lastNodeExecuted": node, "mode": "trigger"}
    if retry_of:
        execution["retryOf"] = str(retry_of)
        execution["mode"] = "retry"
    return {"execution": execution, "workflow": {"id": wf_id, "name": wf_name}}


def generic_payload(title: str, service: str, severity: str = "error", fingerprint: str | None = None, details=None, url: str = "") -> dict:
    p = {"title": title, "service": service, "severity": severity, "environment": "production"}
    if fingerprint:
        p["fingerprint"] = fingerprint
    if details:
        p["details"] = details
    if url:
        p["url"] = url
    return p


def _burst(rng: random.Random, start: float, end: float, per_hour: float) -> list[float]:
    """Arrival times with exponential gaps: bursty, like real error traffic."""
    out, t = [], start
    while True:
        t += rng.expovariate(per_hour / 3600)
        if t >= end:
            return out
        out.append(t)


def script(now: float) -> list[tuple[float, str, dict]]:
    """The week, as (timestamp, source id, payload). Pure function of `now`."""
    midnight = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    def at(day: int, hour: int, minute: int = 0) -> float:  # day 7 is today, day 0 is a week ago
        return midnight + (day - 7) * DAY + hour * 3600 + minute * 60

    week_start = (int(now) // 3600 + 1) * 3600 - 7 * DAY  # the same edge the 7 day stats range uses
    out: list[tuple[float, str, dict]] = []

    def add(ts_list, source, payload_fn):
        for i, ts in enumerate(ts_list):
            if week_start <= ts <= now:
                out.append((ts, source, payload_fn(i)))

    def rng(name: str) -> random.Random:
        return random.Random(f"fernhill:{name}")

    # Sentry: three hot path bugs -------------------------------------------------------------------------------
    r = rng("coupon")
    coupon = _burst(r, at(2, 10, 12), at(2, 13), 95) + _burst(r, at(2, 13), at(2, 18, 40), 48)
    add(coupon, "sentry", lambda i: sentry_payload(
        48211, "TypeError: Cannot read properties of undefined (reading 'plan')", "app/checkout/applyCoupon.ts in applyCoupon", "web-app"))

    r = rng("double-booking")
    booking = _burst(r, at(4, 8, 30), at(4, 9, 30), 140) + _burst(r, at(4, 9, 30), at(4, 12), 345) + _burst(r, at(4, 12), at(4, 13, 5), 90)
    add(booking, "sentry", lambda i: sentry_payload(
        48377, 'IntegrityError: duplicate key value violates unique constraint "bookings_slot_key"',
        "bookings/services.py in create_booking", "api"))

    r = rng("payment-timeout")
    add(_burst(r, now - 4.8 * 3600, now, 47), "sentry", lambda i: sentry_payload(
        48502, "TimeoutError: payment provider did not respond within 10s", "billing/charge.py in capture_payment", "billing-worker", "fatal"))

    # Sentry: recurring medium noise ----------------------------------------------------------------------------
    r = rng("sms")
    for day in range(1, 8):
        add(_burst(r, at(day, 9, 0), at(day, 9, 25), 60), "sentry", lambda i: sentry_payload(
            47990, "RateLimitError: SMS gateway returned 429 Too Many Requests", "notifications/sms.py in send_reminder", "api", "warning"))
    r = rng("chunks")
    for day, hour, minute in ((1, 14, 2), (2, 10, 13), (5, 11, 1)):
        add(_burst(r, at(day, hour, minute), at(day, hour, minute + 22), 100), "sentry", lambda i: sentry_payload(
            47712, "ChunkLoadError: Loading chunk 418 failed", "webpack/runtime/load in __webpack_require__", "web-app", "warning"))

    # Sentry: one off errors ------------------------------------------------------------------------------------
    one_offs = [
        (48120, "KeyError: 'timezone'", "studios/serializers.py in to_representation", "api", [(1, 11, 4), (1, 11, 9), (3, 16, 40)]),
        (48144, "ValueError: invalid literal for int() with base 10: 'abc'", "classes/views.py in list_classes", "api", [(1, 19, 27)]),
        (48190, "AttributeError: 'NoneType' object has no attribute 'email'", "billing/receipts.py in send_receipt", "billing-worker", [(2, 7, 15), (5, 7, 15)]),
        (48233, "Error: Hydration failed because the initial UI does not match what was rendered on the server", "app/schedule/page.tsx in SchedulePage", "web-app", [(2, 21, 3), (2, 21, 4), (3, 8, 50), (6, 12, 31)]),
        (48260, "NSInvalidArgumentException: unrecognized selector sent to instance", "CheckInViewController.swift in didScanCode", "mobile-app", [(3, 18, 12)]),
        (48301, "OperationalError: deadlock detected", "waitlist/tasks.py in promote_from_waitlist", "api", [(3, 17, 2), (3, 17, 3)]),
        (48340, "PermissionDenied: studio owner role required", "payouts/views.py in update_bank_details", "api", [(4, 15, 44)]),
        (48412, "RangeError: Invalid time value", "app/classes/formatSlot.ts in formatSlot", "web-app", [(5, 9, 18), (5, 9, 20), (6, 9, 41)]),
        (48455, "JSONDecodeError: Expecting value: line 1 column 1 (char 0)", "integrations/calendar.py in pull_changes", "api", [(6, 4, 10), (6, 4, 40)]),
        (48470, "MemoryError", "reports/export.py in build_attendance_csv", "billing-worker", [(6, 23, 5)]),
        (48489, "IllegalStateException: Fragment not attached to a context", "ClassDetailFragment.kt in onBookingResult", "mobile-app", [(7, 8, 22)]),
    ]
    for issue_id, title, culprit, project, times in one_offs:
        add([at(*t) for t in times], "sentry", lambda i, a=(issue_id, title, culprit, project): sentry_payload(*a))

    # n8n: scheduled workflows that fail ------------------------------------------------------------------------
    exec_id = iter(range(90210, 99999))
    for day in (1, 2, 3, 5, 7):  # nightly export: the run plus two automatic retries
        first = next(exec_id)
        times = [at(day, 2, 0), at(day, 2, 5), at(day, 2, 10)]
        add(times, "n8n", lambda i, first=first: n8n_payload(
            "wf_14", "Nightly invoice export", "Upload to accounting API",
            "The service refused the connection, perhaps it is offline", first + i, first if i else None))
        for _ in range(2):
            next(exec_id)
    crm = [at(5, 14, 0) + k * 900 for k in range(79)]  # every 15 minutes until someone rotates the credential
    add(crm, "n8n", lambda i: n8n_payload("wf_03", "New signup to CRM sync", "Create CRM contact",
                                          "Authorization failed, please check your credentials", 93000 + i))
    roster = [at(3, 16, 0) + k * 300 for k in range(37)]
    add(roster, "n8n", lambda i: n8n_payload("wf_22", "Waitlist auto promote", "Get class roster",
                                             "The resource you are requesting could not be found", 91500 + i))
    add([at(1, 13, 0), at(4, 6, 0), at(7, 15, 0)], "n8n", lambda i: n8n_payload(
        "wf_09", "Failed payment dunning emails", "Send email", "Request failed with status code 502", 94000 + i))
    add([at(3, 7, 0)], "n8n", lambda i: n8n_payload(
        "wf_31", "Weekly studio report", "Build report (Code)", "Cannot read properties of undefined (reading 'rows') [line 14]", 94500))

    # Background workers: plain JSON ----------------------------------------------------------------------------
    r = rng("queue")
    queue = [at(2, 10, 40) + k * 120 for k in range(34)] + [at(4, 9, 10) + k * 120 for k in range(92)] + [at(6, 18, 0) + k * 120 for k in range(21)]
    add(queue, "workers", lambda i: generic_payload(
        f"Email queue depth above 5,000 ({5000 + r.randint(40, 4200):,} waiting)", "email-queue", "warning", "email-queue-depth",
        {"queue": "transactional", "oldest_message_age_seconds": 300 + i * 40}))
    add([at(2, 3, 31), at(4, 3, 34), at(6, 3, 32)], "workers", lambda i: generic_payload(
        "backup-db exceeded its 30 minute runtime limit", "cron", "warning", None, {"job": "backup-db", "runtime_minutes": 31 + i * 4}))
    r2 = rng("dispatch")
    dispatch = []  # studio endpoints go down for a while, so failures arrive in clumps
    for start in sorted(week_start + r2.random() * (now - week_start - 2 * 3600) for _ in range(11)) + [now - 41 * 60]:
        dispatch += sorted(start + r2.random() * 35 * 60 for _ in range(r2.randint(3, 8)))
    add(dispatch, "workers", lambda i: generic_payload(
        f"Webhook delivery to studio {r2.randint(1100, 1990)} failed after 5 retries", "webhook-dispatcher", "error", None,
        {"last_status": r2.choice([502, 503, 504, 410]), "attempts": 5}))
    add([at(3, 23, 12), at(6, 23, 6)], "workers", lambda i: generic_payload(
        "Report export job crashed: worker killed (out of memory)", "report-worker", "fatal", None, {"job": "attendance-export", "rss_mb": 2048}))

    # Uptime checks: a flapping integration ---------------------------------------------------------------------
    r = rng("flap")
    flaps, t = [], week_start + 3 * 3600
    while t < now:
        heavy = at(3, 6) <= t <= at(4, 20)
        flaps += [t + k * 60 for k in range(r.randint(3, 9) if heavy else r.randint(2, 5))]
        t += r.uniform(0.6, 2.2) * 3600 if heavy else r.uniform(2.5, 7.5) * 3600
    flaps = [f for f in flaps if f < now - 3 * 3600] + [now - 26 * 60 + k * 60 for k in range(4)]
    add(flaps, "uptime", lambda i: generic_payload(
        "Calendar sync API: health check failed", "calendar-sync", "error", "calendar-sync-health",
        {"probe": "GET /v1/health", "timeout_seconds": 5, "region": "eu-west"}, "https://status.fernhill.example/checks/calendar-sync"))
    r3 = rng("slow")
    slow = []
    for start in sorted(week_start + r3.random() * (now - week_start - 3600) for _ in range(7)):
        slow += [start + k * 60 for k in range(r3.randint(2, 6))]
    add(slow, "uptime", lambda i: generic_payload(
        f"api.fernhill.example responded in {r3.uniform(5.1, 11.8):.1f}s (limit 5s)", "public-api", "warning"))
    add([at(d, 6, 0) for d in range(1, 8)], "uptime", lambda i: generic_payload(
        f"TLS certificate for hooks.fernhill.example expires in {15 - i} days", "edge", "warning"))

    out.sort(key=lambda row: row[0])
    return out


def build_hub(channel: str = "#alerts-prod", now: float | None = None) -> AlertHub:
    """A fresh in memory hub with the week replayed into it. Used at startup and by the Reset demo control."""
    started = time.time()
    pinned = demo_now(started) if now is None else now
    offset = started - pinned
    hub = AlertHub(OutboxClient(), Deduper(), Store(), demo_sources(), channel, clock=lambda: time.time() - offset)
    hub.set_rules(DEMO_RULES)
    for ts, source, payload in script(pinned):
        hub.ingest(source, payload, now=ts)
    hub.seeded_events = hub.store.totals(0, pinned + 1)["events"]
    return hub
