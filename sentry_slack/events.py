"""One normalized event shape for every source, so the dedupe rules never care where it came from."""
from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass

SEVERITIES = ("fatal", "error", "warning", "info")

_VOLATILE = re.compile(r"[0-9a-f]{8}-[0-9a-f-]{27}|0x[0-9a-f]+|\d+", re.I)


@dataclass
class Event:
    fingerprint: str
    title: str
    service: str = "unknown"
    severity: str = "error"
    source: str = "sentry"
    culprit: str = ""
    environment: str = ""
    url: str = ""
    details: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def stable_hash(*parts: str) -> str:
    """Hash with ids, counters and uuids stripped, so 'order 1841 failed' and 'order 1842 failed' are one incident."""
    normalized = "|".join(_VOLATILE.sub("#", p or "").strip().lower() for p in parts)
    return hashlib.sha1(normalized.encode()).hexdigest()[:16]


def clean_severity(value: object, default: str = "error") -> str:
    v = str(value or "").strip().lower()
    aliases = {"critical": "fatal", "crit": "fatal", "err": "error", "warn": "warning", "notice": "info", "debug": "info"}
    v = aliases.get(v, v)
    return v if v in SEVERITIES else default
