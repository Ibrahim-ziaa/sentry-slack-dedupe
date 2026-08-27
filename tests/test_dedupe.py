from sentry_slack.dedupe import Deduper


def test_first_notifies_repeats_are_silent_inside_window():
    d = Deduper(window_seconds=60)
    assert d.decide("a", now=0).notify
    for t in range(1, 9):
        assert not d.decide("a", now=t).notify


def test_escalates_at_10_and_100_even_inside_window():
    d = Deduper(window_seconds=10_000)
    results = [d.decide("a", now=i) for i in range(100)]
    notified_at = [r.count for r in results if r.notify]
    assert notified_at == [1, 10, 100]
    assert results[9].suppressed_since_last == 8


def test_window_expiry_reports_suppressed_count():
    d = Deduper(window_seconds=60)
    d.decide("a", now=0)
    for t in range(1, 5):
        d.decide("a", now=t)
    r = d.decide("a", now=61)
    assert r.notify and r.suppressed_since_last == 4 and "window expired" in r.reason


def test_state_survives_restart(tmp_path):
    path = str(tmp_path / "s.db")
    Deduper(path, 60).decide("a", now=0)
    assert not Deduper(path, 60).decide("a", now=1).notify
