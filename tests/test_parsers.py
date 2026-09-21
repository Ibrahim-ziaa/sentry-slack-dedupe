import pytest

from sentry_slack.parsers import PARSERS, PayloadError, parse_generic, parse_n8n

N8N_ERROR = {
    "execution": {
        "id": "231",
        "url": "https://n8n.example/workflow/7/executions/231",
        "retryOf": "34",
        "error": {"message": "Authorization failed, please check your credentials", "stack": "NodeApiError: ..."},
        "lastNodeExecuted": "Create CRM contact",
        "mode": "trigger",
    },
    "workflow": {"id": "7", "name": "New signup to CRM sync"},
}


def test_n8n_error_workflow_payload():
    ev = parse_n8n(N8N_ERROR)
    assert ev.source == "n8n" and ev.service == "New signup to CRM sync"
    assert ev.title == "Authorization failed, please check your credentials"
    assert ev.culprit == "Create CRM contact" and ev.url.endswith("/executions/231")
    assert ev.fingerprint.startswith("n8n:7:")
    assert "Retry of: 34" in ev.details


def test_n8n_same_failure_is_one_fingerprint_even_when_ids_in_the_message_change():
    a = dict(N8N_ERROR, execution=dict(N8N_ERROR["execution"], id="1", error={"message": "Order 1841 not found"}))
    b = dict(N8N_ERROR, execution=dict(N8N_ERROR["execution"], id="2", error={"message": "Order 1977 not found"}))
    other_node = dict(N8N_ERROR, execution=dict(N8N_ERROR["execution"], lastNodeExecuted="Send email"))
    assert parse_n8n(a).fingerprint == parse_n8n(b).fingerprint
    assert parse_n8n(other_node).fingerprint != parse_n8n(N8N_ERROR).fingerprint


def test_n8n_accepts_item_lists_and_trigger_failures_and_rejects_junk():
    assert parse_n8n([{"json": N8N_ERROR}]).fingerprint == parse_n8n(N8N_ERROR).fingerprint
    trig = parse_n8n({"trigger": {"error": {"message": "IMAP connection closed"}, "mode": "trigger"}, "workflow": {"id": "9", "name": "Inbox watcher"}})
    assert trig.title == "IMAP connection closed" and trig.culprit == "trigger"
    with pytest.raises(PayloadError):
        parse_n8n({"hello": "world"})
    with pytest.raises(PayloadError):
        parse_n8n([])


def test_generic_payload_fields_and_explicit_fingerprint():
    ev = parse_generic(
        {"title": "backup-db failed", "service": "cron", "severity": "critical", "fingerprint": "backup-db", "details": {"exit_code": 2}},
        source="workers",
    )
    assert (ev.source, ev.service, ev.severity, ev.fingerprint) == ("workers", "cron", "fatal", "workers:backup-db")
    assert '"exit_code": 2' in ev.details


def test_generic_fingerprint_falls_back_to_service_and_normalized_title():
    a = parse_generic({"title": "Webhook delivery to studio 1841 failed", "service": "dispatcher"})
    b = parse_generic({"title": "Webhook delivery to studio 1977 failed", "service": "dispatcher"})
    c = parse_generic({"title": "Webhook delivery to studio 1977 failed", "service": "other"})
    assert a.fingerprint == b.fingerprint != c.fingerprint
    assert a.severity == "error" and parse_generic({"title": "x", "severity": "nonsense"}).severity == "error"


def test_generic_requires_a_title():
    with pytest.raises(PayloadError):
        parse_generic({"service": "cron"})
    with pytest.raises(PayloadError):
        parse_generic(["not", "an", "object"])


def test_every_kind_has_a_parser_that_stamps_the_source_id():
    sentry = PARSERS["sentry"]({"message": "boom", "project": "api"}, "apps")
    assert sentry.source == "apps" and sentry.fingerprint.startswith("hash:")
    assert PARSERS["n8n"](N8N_ERROR, "automations").source == "automations"
    assert PARSERS["generic"]({"title": "x"}, "cron").fingerprint.startswith("cron:")
