import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from app.backup import BackupService
from app.main import create_app
from app.library import Library
from app.provider import ElevenLabs, ProviderRejected
from app.queue import QueueService
from app.storage import canonical, sha256
from worker.engine import Worker


@pytest.mark.parametrize(
    "code", ["missing_permissions", "quota_exceeded", "invalid_api_key"]
)
def test_401_reason_is_redacted_persisted_and_not_retried(db, job, monkeypatch, code):
    key = "private-provider-test-credential"
    monkeypatch.setenv("ELEVENLABS_API_KEY", key)
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            401,
            json={
                "detail": {
                    "status": code,
                    "message": f"Rejected: {code}. Sensitive key {key}.",
                }
            },
            headers={"request-id": "upstream-request-123"},
        )

    provider = ElevenLabs(client=httpx.Client(transport=httpx.MockTransport(respond)))
    worker = Worker(db, provider)
    worker.step()
    failed = QueueService(db).job(job["id"])
    attempt = failed["attempts"][0]
    assert attempt["state"] == "failed_provider"
    assert attempt["http_status"] == 401 and attempt["error_code"] == code
    assert attempt["request_id"] == "upstream-request-123"
    assert "[redacted]" in attempt["error_message"]
    assert key not in json.dumps(failed)
    assert key not in json.dumps(db.all("SELECT * FROM provider_attempts"))
    assert attempt["diagnostic"]["help"]
    assert not db.all("SELECT * FROM provider_artifacts")
    worker.reconcile()
    for _ in range(4):
        worker.step()
    assert len(calls) == 1
    with TestClient(create_app(db.cfg)) as client:
        status = client.get("/api/v1/provider/status").json()
        assert status["last_transcription"]["diagnostic"]["error_code"] == code
        assert not status["transcription_verified"]
        assert key not in json.dumps(status)


@pytest.mark.parametrize(
    "body",
    [b"not json", b"[]", b'{"detail":42}', b'{"detail":{"message":10}}', b"x" * 70000],
)
def test_unexpected_error_body_has_bounded_safe_fallback(monkeypatch, body):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "private-key")
    error = ProviderRejected.from_response(
        httpx.Response(401, content=body, headers={"request-id": "private-key"})
    )
    assert error.status == 401
    assert error.request_id is None
    assert len(error.message) <= 600
    assert "private-key" not in error.message


def test_validation_errors_show_field_and_redact_credentials(monkeypatch):
    key = "private-validation-key"
    monkeypatch.setenv("ELEVENLABS_API_KEY", key)
    error = ProviderRejected.from_response(
        httpx.Response(
            422,
            json={
                "detail": [
                    {
                        "loc": ["body", "num_speakers"],
                        "msg": "Must be at most 32. " + key,
                        "input": key,
                    }
                ]
            },
        )
    )
    assert error.code == "validation_error"
    assert "num_speakers" in error.message
    assert key not in error.message


def test_restore_of_old_schema_retains_new_rejection_evidence(db, job, provider):
    backups = BackupService(db)
    old = backups.create(True)
    root = db.cfg.backups / "snapshots" / old["id"]
    snapshot = root / "app.sqlite3"
    # Reproduce a valid pre-update snapshot, including its schema revision.
    with sqlite3.connect(snapshot) as con:
        for column in ("error_code", "error_message", "request_id"):
            con.execute("ALTER TABLE provider_attempts DROP COLUMN " + column)
        con.execute("UPDATE alembic_version SET version_num='0001'")
    info = json.loads((root / "snapshot.json").read_text())
    for file in info["files"]:
        if file["path"] == "app.sqlite3":
            file.update(sha256=sha256(snapshot), size=snapshot.stat().st_size)
    (root / "snapshot.json").write_text(canonical(info))
    (root / "checksums.sha256").write_text(
        "".join(f"{file['sha256']}  {file['path']}\n" for file in info["files"])
    )
    backups.verify(old["id"])

    def reject(*_):
        provider.posts += 1
        raise ProviderRejected(
            401, "quota_exceeded", "Key credit limit reached.", "request-456"
        )

    provider.transcribe = reject
    Worker(db, provider).step()
    assert provider.posts == 1
    backups.restore(old["id"])
    failed = QueueService(db).job(job["id"])
    assert failed["attempts"][0]["error_code"] == "quota_exceeded"
    assert failed["attempts"][0]["request_id"] == "request-456"
    assert db.one("SELECT version_num FROM alembic_version")["version_num"] == "0002"
    Worker(db, provider).reconcile()
    assert Worker(db, provider).step() is False
    assert provider.posts == 1


def test_monitor_effects_preserve_source_timing_and_original(db, lecture):
    original = next(asset for asset in lecture["media"] if asset["kind"] == "original")
    original_path = db.cfg.data / original["path"]
    digest = sha256(original_path)
    Library(db).save_edl(
        lecture["id"],
        [{"start_ms": 0, "end_ms": 800}, {"start_ms": 1700, "end_ms": 3000}],
    )
    with TestClient(create_app(db.cfg)) as client:
        clean = client.post(
            f"/api/v1/lectures/{lecture['id']}/monitor-preview",
            json={
                "enabled": True,
                "highpass": False,
                "denoise": False,
                "loudness": False,
            },
        ).json()
        effects = {"enabled": True, "highpass": True, "denoise": True, "loudness": True}
        enhanced = client.post(
            f"/api/v1/lectures/{lecture['id']}/monitor-preview", json=effects
        ).json()
        repeated = client.post(
            f"/api/v1/lectures/{lecture['id']}/monitor-preview", json=effects
        ).json()
        assert enhanced == repeated
        assert enhanced["id"] != clean["id"]
        assert enhanced["duration_ms"] == original["duration_ms"]
        assert (
            db.one("SELECT sha256 FROM media_assets WHERE id=?", (clean["id"],))[
                "sha256"
            ]
            != db.one("SELECT sha256 FROM media_assets WHERE id=?", (enhanced["id"],))[
                "sha256"
            ]
        )
    assert sha256(original_path) == digest
    assert not db.all("SELECT * FROM provider_attempts")
