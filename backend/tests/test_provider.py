import json
import pytest
from app.queue import QueueService
from app.contracts import TranscriptionSettings
from worker.engine import Worker


@pytest.mark.parametrize(
    "mode,outcome",
    [
        ("drop", "unknown_outcome"),
        ("unavailable", "unknown_outcome"),
        ("reject", "failed_provider"),
    ],
)
def test_observed_posts_not_repeated(db, job, vendor, mode, outcome):
    state, provider = vendor
    state["mode"] = mode
    worker = Worker(db, provider)
    worker.step()
    assert state["posts"] == 1
    assert QueueService(db).job(job["id"])["chunks"][0]["state"] == outcome
    worker.reconcile()
    for _ in range(5):
        worker.step()
    assert state["posts"] == 1


@pytest.mark.parametrize("model_id", ["scribe_v2", "scribe_v3"])
def test_real_multipart_adapter_and_account_safety(
    db, lecture, vendor, monkeypatch, model_id
):
    from app.contracts import JobInput

    job = QueueService(db).enqueue(
        JobInput(
            lecture_id=lecture["id"],
            settings=TranscriptionSettings(model_id=model_id, target_ms=1000),
            confirmed=True,
        )
    )
    state, provider = vendor
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert state["posts"] == len(job["chunks"]) and state["max_active"] == 1
    assert (
        model_id.encode() in state["bodies"][0]
        and b"timestamps_granularity" in state["bodies"][0]
    )
    assert provider.account()["status"] == "Connected"
    assert "api_key" not in json.dumps(provider.account(subscription=True))
    monkeypatch.setenv("ELEVENLABS_API_KEY", "invalid")
    assert provider.account()["status"] == "Invalid"
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    assert provider.account()["status"] == "Not configured"
    assert state["posts"] == len(job["chunks"])
    assert {row["model"] for row in db.all("SELECT model FROM usage_ledger")} == {
        model_id
    }


def test_keyterm_contract():
    for term in ["a" * 50, "one two three four five six", "bad\\term", "<x>", ""]:
        with pytest.raises(ValueError):
            TranscriptionSettings(keyterms=[term])
    assert TranscriptionSettings(keyterms=["logical equivalence", "هم‌ارزی"]).keyterms


def test_keyterms_are_repeated_multipart_fields(db, lecture, vendor):
    state, provider = vendor
    from app import media

    asset = media.original(db, lecture["id"])
    provider.transcribe(
        db.cfg.data / asset["path"],
        TranscriptionSettings(keyterms=["AI", "هم‌ارزی"]).model_dump(),
    )
    assert state["posts"] == 1
    assert state["bodies"][0].count(b'name="keyterms"') == 2
    assert b'name="num_speakers"' not in state["bodies"][0]
