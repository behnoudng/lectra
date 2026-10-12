"""Regression coverage for gaps found during the second specification audit."""

from concurrent.futures import ThreadPoolExecutor
import time
import pytest
from fastapi.testclient import TestClient
from app import media, transcripts, pricing
from app.backup import BackupService
from app.contracts import (
    Block,
    TranscriptSave,
    PriceInput,
    JobInput,
    TranscriptionSettings,
)
from app.errors import AppError
from app.main import create_app
from app.provider import ProviderResponse
from app.queue import QueueService
from app.storage import sha256
from worker.engine import Worker


def test_restore_preserves_unregistered_successful_response(db, job, provider):
    snapshot = BackupService(db).create(True)

    def fail_registration(stage):
        if stage == "artifact_written":
            raise AppError("database", "Registration interrupted")

    Worker(db, provider, fail_registration).step()
    assert provider.posts == 1
    assert not db.all("SELECT * FROM provider_artifacts")
    attempt = db.one("SELECT * FROM provider_attempts")
    raw = db.cfg.data / "artifacts/provider" / (attempt["id"] + ".json")
    digest = sha256(raw)
    BackupService(db).restore(snapshot["id"])
    assert raw.exists() and sha256(raw) == digest
    assert (
        db.one("SELECT state FROM transcription_chunks ORDER BY ordinal")["state"]
        == "succeeded"
    )
    assert db.one("SELECT * FROM provider_artifacts")["sha256"] == digest
    for _ in range(3):
        Worker(db, provider).step()
    assert provider.posts == 1


def test_reconcile_does_not_reimport_completed_untimed_response(db, job, provider):
    class Crash(BaseException):
        pass

    def pause(stage):
        if stage == "response_persisted":
            raise Crash()

    def untimed(*_):
        provider.posts += 1
        return ProviderResponse(b'{"text":"Untimed passage","words":[]}', 200)

    provider.transcribe = untimed
    with pytest.raises(Crash):
        Worker(db, provider, pause).step()
    chunk = db.one("SELECT * FROM transcription_chunks ORDER BY ordinal")
    tid = transcripts.import_chunk(
        db, chunk, provider.normalize_response(b'{"text":"Untimed passage","words":[]}')
    )
    before = transcripts.get_transcript(db, tid)
    blocks = [Block.model_validate(b) for b in before["blocks"]]
    blocks[0].text = "User correction"
    saved = transcripts.save(
        db, tid, TranscriptSave(base_revision=before["revision"], blocks=blocks)
    )
    Worker(db, provider).reconcile()
    after = transcripts.get_transcript(db, tid)
    assert after["blocks"] == saved["blocks"]
    assert after["revision"] == saved["revision"]
    assert provider.posts == 1


@pytest.mark.parametrize("change", ["missing_review", "edl", "pricing"])
def test_enqueue_requires_current_review(db, lecture, monkeypatch, change):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-only-key")
    with TestClient(create_app(db.cfg)) as client:
        data = {"lecture_id": lecture["id"], "settings": {}, "confirmed": True}
        estimate = client.post("/api/v1/jobs/estimate", json=data).json()
        if change != "missing_review":
            data["review_hash"] = estimate.get("review_hash", "0" * 64)
        if change == "edl":
            client.put(
                f"/api/v1/lectures/{lecture['id']}/edl",
                json={"spans": [{"start_ms": 0, "end_ms": 1000}]},
            )
        elif change == "pricing":
            pricing.save_rule(
                db,
                PriceInput(
                    effective_from="2026-01-01",
                    currency="USD",
                    base_micros_per_hour=1000000,
                    source_note="Test-only price",
                ),
            )
        rejected = client.post("/api/v1/jobs", json=data)
        assert rejected.status_code == 409
        assert rejected.json()["error"]["category"] == "preflight_changed"
        assert not db.all("SELECT * FROM transcription_jobs")
        assert not db.all("SELECT * FROM provider_attempts")
        fresh = client.post("/api/v1/jobs/estimate", json=data).json()
        data["review_hash"] = fresh["review_hash"]
        assert client.post("/api/v1/jobs", json=data).status_code == 201


def test_concurrent_preview_reuses_one_immutable_asset(db, lecture, monkeypatch):
    render = media.render
    calls = []

    def slow_render(*args, **kwargs):
        calls.append(1)
        time.sleep(0.2)
        return render(*args, **kwargs)

    monkeypatch.setattr(media, "render", slow_render)
    original = media.original(db, lecture["id"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(media.preview, db, lecture["id"], lecture["edl"], {})
            for _ in range(2)
        ]
        ids = [f.result(timeout=20) for f in futures]
    assert ids[0] == ids[1] and len(calls) == 1
    assert sha256(db.cfg.data / original["path"]) == original["sha256"]


def test_new_job_cannot_bypass_failed_job_or_retranscribe_silently(db, job, provider):
    provider.fail_parse = True
    Worker(db, provider).step()
    assert provider.posts == 1
    queue = QueueService(db)
    data = JobInput(
        lecture_id=job["lecture_id"], settings=TranscriptionSettings(), confirmed=True
    )
    with pytest.raises(AppError, match="unfinished"):
        queue.enqueue(data)
    provider.fail_parse = False
    Worker(db, provider).reconcile()
    assert queue.job(job["id"])["state"] == "queued"
    for _ in range(10):
        Worker(db, provider).step()
    assert provider.posts == len(job["chunks"])
    with pytest.raises(AppError, match="explicit retranscription"):
        queue.enqueue(data)
    data.retranscribe_completed = True
    assert queue.enqueue(data)["state"] == "queued"
    assert provider.posts == len(job["chunks"])


def test_speaker_edits_require_current_revision(db, job, provider):
    for _ in range(10):
        Worker(db, provider).step()
    tid = QueueService(db).job(job["id"])["transcript_id"]
    with TestClient(create_app(db.cfg)) as client:
        before = client.get("/api/v1/transcripts/" + tid).json()
        speaker = before["blocks"][0]["speaker_key"]
        data = {"base_revision": before["revision"], "labels": {speaker: "Professor"}}
        result = client.put("/api/v1/transcripts/" + tid + "/speakers", json=data)
        assert (
            result.status_code == 200
            and result.json()["speakers"][speaker] == "Professor"
        )
        assert (
            client.put(
                "/api/v1/transcripts/" + tid + "/speakers", json=data
            ).status_code
            == 409
        )
        assert provider.posts == len(job["chunks"])


def test_preferences_upgrade_old_settings_and_validate_shortcuts(db):
    with TestClient(create_app(db.cfg)) as client:
        old = client.get("/api/v1/settings").json()
        assert old["shortcuts"]["play_pause"] == "Ctrl+Space"
        old.update(
            skip_seconds=3,
            skip_forward_seconds=9,
            shortcuts={
                "play_pause": "Alt+P",
                "backward": "Alt+J",
                "forward": "Alt+L",
                "help": "Alt+H",
            },
        )
        assert client.patch("/api/v1/settings", json=old).status_code == 200
        assert client.get("/api/v1/settings").json() == old
        old["shortcuts"]["play_pause"] = "Ctrl+W"
        assert client.patch("/api/v1/settings", json=old).status_code == 422


def test_ab_preview_enhances_without_selecting_paid_processing(db, lecture):
    with TestClient(create_app(db.cfg)) as client:
        result = client.post(
            f"/api/v1/lectures/{lecture['id']}/preprocess-preview",
            json={"enabled": False},
        ).json()
        clean = db.one("SELECT * FROM media_assets WHERE id=?", (result["clean_id"],))
        enhanced = db.one(
            "SELECT * FROM media_assets WHERE id=?", (result["enhanced_id"],)
        )
        assert clean["sha256"] != enhanced["sha256"] and enhanced["kind"] == "enhanced"
        assert (
            not client.get(f"/api/v1/lectures/{lecture['id']}")
            .json()["preprocessing"]
            .get("enabled", False)
        )
        original = media.original(db, lecture["id"])
        assert sha256(db.cfg.data / original["path"]) == original["sha256"]


def test_account_allowlist_rejects_nested_and_echoed_credentials(monkeypatch):
    import httpx
    from app.provider import ElevenLabs

    sentinel = "account-test-environment-key"
    monkeypatch.setenv("ELEVENLABS_API_KEY", sentinel)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "tier": sentinel,
                    "character_count": {"credential": sentinel},
                    "character_limit": 100,
                    "next_character_count_reset_unix": sentinel,
                },
            )
        )
    )
    result = ElevenLabs(client=client).account(subscription=True)
    assert result["status"] == "Connected"
    assert result["subscription"] == {"character_limit": 100}
    assert sentinel not in str(result)


def test_api_returns_maintenance_instead_of_blocking_on_restore_lock(db):
    from app.storage import lock

    with TestClient(create_app(db.cfg)) as client:
        with lock(db.cfg.data / "runtime.lock"):
            response = client.get("/api/v1/lectures")
            assert response.status_code == 503
            assert response.json()["error"]["category"] == "restore"
        assert client.get("/api/v1/health").status_code == 200
