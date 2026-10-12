from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.db import verify_sqlite
from app import transcripts, pricing
from app.contracts import (
    Block,
    TranscriptSave,
    PriceInput,
    JobInput,
    TranscriptionSettings,
)
from app.queue import QueueService
from app.library import Library
from app.backup import BackupService
from app.errors import AppError
from app.storage import lock
from worker.engine import Worker


@pytest.mark.parametrize("version", ["3.40.1", "3.50.4", "3.51.1", "3.51.2", "3.52.0"])
def test_bad_sqlite_fails_readiness(version):
    with pytest.raises(AppError, match="Unsafe SQLite"):
        verify_sqlite(version)


@pytest.mark.parametrize("version", ["3.51.3", "3.51.4", "3.52.1", "3.53.1"])
def test_fixed_sqlite(version):
    verify_sqlite(version)


def test_missing_key_usable_app_and_range_stream(db, lecture, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with TestClient(create_app(db.cfg)) as client:
        assert client.get("/api/v1/health").status_code == 200
        assert (
            client.get("/api/v1/provider/status").json()["status"] == "Not configured"
        )
        assert len(client.get("/api/v1/lectures").json()) == 1
        result = client.post(
            "/api/v1/jobs",
            json={"lecture_id": lecture["id"], "settings": {}, "confirmed": True},
        )
        assert result.status_code == 409
        proxy = next(a for a in lecture["media"] if a["kind"] == "proxy")
        r = client.get("/api/v1/media/" + proxy["id"], headers={"Range": "bytes=0-99"})
        assert r.status_code == 206 and len(r.content) == 100
        assert (
            client.patch(
                "/api/v1/settings", json={"ELEVENLABS_API_KEY": "do-not-echo"}
            ).status_code
            == 422
        )
        assert (
            "do-not-echo"
            not in client.patch(
                "/api/v1/settings", json={"ELEVENLABS_API_KEY": "do-not-echo"}
            ).text
        )
        assert (
            client.post(
                "/api/v1/queue/pause", headers={"Origin": "https://evil.example"}
            ).status_code
            == 403
        )


def test_readiness_endpoint_for_unfixed_image(db, monkeypatch):
    import app.db

    monkeypatch.setattr(app.db.sqlite3, "sqlite_version", "3.52.0")
    with TestClient(create_app(db.cfg)) as client:
        result = client.get("/api/v1/health")
        assert result.status_code == 503
        assert "WAL-reset" in result.text
        assert client.get("/api/v1/lectures").status_code == 503


def test_search_bidi_exports_and_revision_conflicts(db, job, provider):
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    t = transcripts.get_transcript(db, QueueService(db).job(job["id"])["transcript_id"])
    text = "خب، اینجا logical equivalence رو بررسی کنیم. كليد، کلید، مسیر /usr/bin و P → Q (¬P ∨ Q) 123، می‌خوایم"
    blocks = [Block.model_validate(b) for b in t["blocks"]]
    blocks[0].text = text
    blocks[0].direction_override = "rtl"
    saved = transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
    )
    assert saved["blocks"][0]["text"] == text
    for query in ["کلید", "كليد", "logical equivalence", "می خوایم", "CS"]:
        assert transcripts.search(db, query), query
    for markdown in [True, False]:
        exported = transcripts.export(db, job["lecture_id"], markdown, True, True)
        assert text in exported and "[00:00:00]" in exported
    with pytest.raises(AppError, match="newer revision"):
        transcripts.save(
            db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
        )
    assert provider.posts == len(job["chunks"])


def test_versioned_pricing_fixed_point_and_unknown_cost(db, lecture):
    queue = QueueService(db)
    data = JobInput(
        lecture_id=lecture["id"], settings=TranscriptionSettings(keyterms=["AI"])
    )
    unknown = queue.estimate(data)
    assert unknown["estimated_cost"] is None and unknown["incremental_payment"] is None
    price = PriceInput(
        effective_from="2026-01-01",
        currency="USD",
        base_micros_per_hour=1000000,
        source_note="Test-only rule",
    )
    rule_id = pricing.save_rule(db, price)
    estimate = queue.estimate(data)
    assert estimate["pricing_rule"]["id"] == rule_id
    assert (
        estimate["estimated_cost"] == 1000
        and estimate["feature_adjustment_basis_points"] == 2000
    )
    data.confirmed = True
    job = queue.enqueue(data)
    pricing.save_rule(
        db,
        price.model_copy(
            update={"effective_from": "2026-02-01", "base_micros_per_hour": 2000000}
        ),
    )
    assert queue.job(job["id"])["pricing_rule_id"] == rule_id


def test_verified_backup_restore_and_corruption_refusal(db, job, provider):
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    backups = BackupService(db)
    snapshot = backups.create(True)
    assert backups.verify(snapshot["id"])["status"] == "verified"
    t = transcripts.get_transcript(db, QueueService(db).job(job["id"])["transcript_id"])
    blocks = [Block.model_validate(b) for b in t["blocks"]]
    blocks[0].text = "later edit"
    transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
    )
    restored = backups.restore(snapshot["id"])
    assert restored["queue_paused"]
    assert (
        transcripts.get_transcript(db, t["id"])["blocks"][0]["text"]
        == t["blocks"][0]["text"]
    )
    assert len(backups.list()) == 2
    root = db.cfg.backups / "snapshots" / snapshot["id"]
    (root / "checksums.sha256").write_text("corrupt")
    with pytest.raises(AppError, match="verification failed"):
        backups.restore(snapshot["id"])
    assert provider.posts == len(job["chunks"])


def test_backup_omitted_originals_truthful_restore(db, lecture):
    backup = BackupService(db)
    snapshot = backup.create(False)
    original = db.one("SELECT * FROM media_assets WHERE kind='original'")
    assert not (
        db.cfg.backups / "snapshots" / snapshot["id"] / original["path"]
    ).exists()
    backup.verify(snapshot["id"])
    Library(db).delete_original(lecture["id"])
    result = backup.restore(snapshot["id"])
    assert result["missing_originals"] == 1
    assert Library(db).lecture(lecture["id"])["media"]
    assert not db.one(
        "SELECT * FROM media_assets WHERE kind='original' AND deleted_at IS NULL",
        required=False,
    )


def test_restore_blocked_inflight_and_active_lock(db, job, provider):
    backups = BackupService(db)
    snapshot = backups.create(True)

    class Crash(BaseException):
        pass

    def fault(stage):
        if stage == "request_started":
            raise Crash()

    with pytest.raises(Crash):
        Worker(db, provider, fault).step()
    assert provider.posts == 0
    with pytest.raises(AppError, match="in-flight"):
        backups.restore(snapshot["id"])
    Worker(db, provider).reconcile()
    with lock(db.cfg.data / "runtime.lock", exclusive=False):
        with pytest.raises(AppError, match="active"):
            backups.restore(snapshot["id"])
    assert provider.posts == 0


def test_original_deletion_blocked_then_preserves_transcript_and_proxy(
    db, job, provider
):
    library = Library(db)
    with pytest.raises(AppError):
        library.delete_original(job["lecture_id"])
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    t = QueueService(db).job(job["id"])["transcript_id"]
    with TestClient(create_app(db.cfg)) as client:
        url = "/api/v1/lectures/" + job["lecture_id"] + "/original-audio"
        assert client.delete(url).status_code == 409
        assert client.delete(url + "?confirmed=true").status_code == 200
        assert client.get("/api/v1/transcripts/" + t).status_code == 200
        playback = client.post("/api/v1/transcripts/" + t + "/playback").json()
        assert client.get("/api/v1/media/" + playback["id"]).status_code == 200
    assert not list((db.cfg.data / "media/original").iterdir())
    assert provider.posts == len(job["chunks"])


def test_secret_absent_in_state_backups_and_payloads(
    db, job, provider, monkeypatch, caplog
):
    secret = "ENV-ONLY-test-key-123456"
    monkeypatch.setenv("ELEVENLABS_API_KEY", secret)
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    BackupService(db).create(True)
    for root in [db.cfg.data, db.cfg.backups]:
        for p in root.rglob("*"):
            if p.is_file():
                assert secret.encode() not in p.read_bytes(), p
    with TestClient(create_app(db.cfg)) as client:
        for url in [
            "/api/v1/settings",
            "/api/v1/system/status",
            "/api/v1/queue",
            "/api/v1/usage",
            "/api/v1/lectures",
            "/api/v1/backups",
        ]:
            assert secret not in client.get(url).text
    assert secret not in caplog.text


def test_migrations_repeat_and_foreign_keys(db):
    db.initialize()
    with db.read() as con:
        assert con.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert con.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert (
            con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            == "0001"
        )


def test_restore_never_rewinds_billing_or_completed_chunks(db, job, provider):
    backup = BackupService(db)
    old = backup.create(True)
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    attempts = db.all("SELECT * FROM provider_attempts")
    ledger = db.all("SELECT * FROM usage_ledger")
    backup.restore(old["id"])
    assert db.all("SELECT * FROM provider_attempts") == attempts
    assert db.all("SELECT * FROM usage_ledger") == ledger
    assert QueueService(db).job(job["id"])["state"] == "succeeded"
    QueueService(db).resume()
    for _ in range(5):
        worker.step()
    assert provider.posts == len(job["chunks"])
    assert QueueService(db).job(job["id"])["transcript_id"]


def test_restored_waiting_work_requires_explicit_authorization(db, job, provider):
    backup = BackupService(db)
    snapshot = backup.create(True)
    backup.restore(snapshot["id"])
    assert QueueService(db).job(job["id"])["state"] == "needs_retry_approval"
    QueueService(db).resume()
    worker = Worker(db, provider)
    assert not worker.step()
    assert provider.posts == 0
    chunk = job["chunks"][0]
    from app.contracts import RetryInput

    with pytest.raises(AppError):
        QueueService(db).retry(job["id"], RetryInput(chunk_id=chunk["id"]))
    QueueService(db).retry(
        job["id"],
        RetryInput(
            chunk_id=chunk["id"],
            authorize_charge=True,
            reason="Reviewed restored queue",
        ),
    )
    QueueService(db).resume()
    worker.step()
    assert provider.posts == 1
    # Next restored chunk is still attention-required, never implicitly authorized.
    worker.step()
    assert provider.posts == 1


def test_cancel_during_preparation_prevents_spending(db, job, provider):
    def fault(stage):
        if stage == "prepared":
            QueueService(db).cancel(job["id"])

    worker = Worker(db, provider, fault)
    worker.step()
    assert provider.posts == 0
    assert QueueService(db).job(job["id"])["state"] == "canceled"


def test_rich_markdown_and_logical_order(db, job, provider):
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    t = transcripts.get_transcript(db, QueueService(db).job(job["id"])["transcript_id"])
    blocks = [Block.model_validate(b) for b in t["blocks"]]
    blocks[0].text = "عنوان English کد /tmp/x"
    blocks[0].marks_json = {
        "lexical": {
            "root": {
                "type": "root",
                "children": [
                    {
                        "type": "heading",
                        "tag": "h2",
                        "children": [
                            {"type": "text", "text": "عنوان ", "format": 0},
                            {"type": "text", "text": "English", "format": 1},
                            {"type": "text", "text": " کد ", "format": 2},
                            {"type": "text", "text": "/tmp/x", "format": 16},
                        ],
                    }
                ],
            }
        }
    }
    transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
    )
    out = transcripts.export(db, job["lecture_id"], True, False, False)
    assert "## عنوان **English*** کد *`/tmp/x`" in out
    plain = transcripts.export(db, job["lecture_id"], False, False, False)
    assert blocks[0].text in plain


def test_restore_preserves_revision_history(db, job, provider):
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    t = transcripts.get_transcript(db, QueueService(db).job(job["id"])["transcript_id"])
    old = BackupService(db).create(True)
    b = [Block.model_validate(x) for x in t["blocks"]]
    b[0].text = "new edit"
    newer = transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=b)
    )
    BackupService(db).restore(old["id"])
    restored = transcripts.get_transcript(db, t["id"])
    assert restored["revision"] > newer["revision"]
    assert restored["blocks"][0]["text"] == t["blocks"][0]["text"]
    assert db.one(
        "SELECT reason FROM transcript_revisions WHERE transcript_id=? AND revision=?",
        (t["id"], newer["revision"]),
    )


def test_missing_key_never_crosses_financial_boundary(db, job, monkeypatch):
    from app.provider import ElevenLabs

    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    Worker(db, ElevenLabs()).step()
    assert not db.all("SELECT * FROM provider_attempts")
    assert not db.all("SELECT * FROM usage_ledger")
    assert QueueService(db).job(job["id"])["state"] == "failed_local"


def test_search_shadow_does_not_rewrite_displayed_snippet(db, job, provider):
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    result = transcripts.search(db, "logical")
    assert "P → Q" in result[0]["snippet"]


def test_restore_process_death_rolls_back_on_startup(db, job, provider):
    import subprocess
    import sys

    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    t = transcripts.get_transcript(db, QueueService(db).job(job["id"])["transcript_id"])
    old = BackupService(db).create(True)
    blocks = [Block.model_validate(b) for b in t["blocks"]]
    blocks[0].text = "latest edit must survive restore crash"
    transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
    )
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).with_name("restore_fixture.py")),
            str(db.cfg.data),
            str(db.cfg.backups),
            old["id"],
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 81, result.stderr
    assert (db.cfg.data / "restore-journal.json").exists()
    db.initialize()
    assert (
        transcripts.get_transcript(db, t["id"])["blocks"][0]["text"]
        == "latest edit must survive restore crash"
    )
    assert not (db.cfg.data / "maintenance").exists()
    assert not (db.cfg.data / "restore-journal.json").exists()
    assert provider.posts == len(job["chunks"])


def test_restore_commit_maintenance_marker_recovers(db):
    (db.cfg.data / "maintenance").write_text("restore")
    db.initialize()
    assert not (db.cfg.data / "maintenance").exists()


def test_many_keyterms_minimum_billable_duration(db):
    price = PriceInput(
        effective_from="2026-01-01",
        currency="USD",
        base_micros_per_hour=1000000,
        source_note="Test rule",
    )
    pricing.save_rule(db, price)
    estimate = pricing.estimate_chunk(
        1000, {"keyterms": ["term" + str(i) for i in range(101)]}, pricing.rule_for(db)
    )
    assert estimate["billable_ms"] == 20000 and estimate["feature_basis_points"] == 2000
    assert estimate["estimated_cost"] == 6667
