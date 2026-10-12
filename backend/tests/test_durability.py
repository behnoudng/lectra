import sqlite3
import pytest
from app import media, transcripts
from app.contracts import (
    JobInput,
    TranscriptionSettings,
    RetryInput,
    TranscriptSave,
    Block,
)
from app.errors import AppError
from app.queue import QueueService
from app.storage import sha256
from worker.engine import Worker


class Crash(BaseException):
    pass


@pytest.mark.parametrize(
    "stage,posts_before,unknown",
    [
        ("preparing", 0, False),
        ("prepared", 0, False),
        ("request_started", 0, True),
        ("response_received", 1, True),
        ("artifact_written", 1, False),
        ("response_persisted", 1, False),
        ("normalizing", 1, False),
        ("succeeded", 1, False),
    ],
)
def test_recovery_at_each_boundary(db, job, provider, stage, posts_before, unknown):
    def fault(current):
        if current == stage:
            raise Crash()

    worker = Worker(db, provider, fault)
    with pytest.raises(Crash):
        worker.step()
    assert provider.posts == posts_before
    resumed = Worker(db, provider)
    resumed.reconcile()
    if unknown:
        assert QueueService(db).list()["paused"]
        assert (
            db.one("SELECT state FROM transcription_chunks ORDER BY ordinal")["state"]
            == "unknown_outcome"
        )
        for _ in range(3):
            assert resumed.step() is False
        assert provider.posts == posts_before
    else:
        for _ in range(10):
            if not resumed.step():
                break
        assert QueueService(db).job(job["id"])["state"] == "succeeded"
        assert provider.posts == len(job["chunks"])
        assert not list((db.cfg.data / "tmp/chunks").glob("*.wav"))
        assert list((db.cfg.data / "media/original").iterdir())


def test_parser_failure_is_local_and_preserves_raw(db, job, provider):
    provider.fail_parse = True
    worker = Worker(db, provider)
    worker.step()
    assert provider.posts == 1
    assert QueueService(db).job(job["id"])["state"] == "failed_local"
    artifact = db.one("SELECT * FROM provider_artifacts")
    before = sha256(db.cfg.data / artifact["path"])
    provider.fail_parse = False
    result = QueueService(db).retry(
        job["id"], RetryInput(chunk_id=job["chunks"][0]["id"])
    )
    assert result["retry_type"] == "local_normalization"
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    assert sha256(db.cfg.data / artifact["path"]) == before


def test_explicit_retry_links_attempt_and_ledger(db, job, provider):
    from app.provider import UnknownOutcome

    def drop(*_):
        provider.posts += 1
        raise UnknownOutcome()

    success = provider.transcribe
    provider.transcribe = drop
    Worker(db, provider).step()
    assert provider.posts == 1
    prior = db.one("SELECT * FROM provider_attempts")
    with pytest.raises(AppError):
        QueueService(db).retry(job["id"], RetryInput(chunk_id=prior["chunk_id"]))
    assert provider.posts == 1
    QueueService(db).retry(
        job["id"],
        RetryInput(
            chunk_id=prior["chunk_id"],
            authorize_charge=True,
            reason="Approved billing risk",
        ),
    )
    QueueService(db).resume()
    provider.transcribe = success
    Worker(db, provider).step()
    assert provider.posts == 2
    attempts = db.all("SELECT * FROM provider_attempts ORDER BY attempt_no")
    assert attempts[0]["state"] == "unknown_outcome"
    assert attempts[1]["retry_of_attempt_id"] == prior["id"]
    assert attempts[1]["retry_authorized_at"]
    ledger = db.all("SELECT * FROM usage_ledger ORDER BY attempt_no")
    assert (
        len(ledger) == 2
        and ledger[0]["charge_status"] == "unknown"
        and ledger[1]["actual_cost"] is None
    )


def test_pause_during_call_completes_and_resume_skips(db, job, provider):
    transcribe = provider.transcribe

    def pausing(path, settings):
        QueueService(db).pause()
        return transcribe(path, settings)

    provider.transcribe = pausing
    worker = Worker(db, provider)
    worker.step()
    assert provider.posts == 1
    assert (
        db.one("SELECT state FROM transcription_chunks ORDER BY ordinal")["state"]
        == "succeeded"
    )
    assert not worker.step()
    assert provider.posts == 1
    provider.transcribe = transcribe
    QueueService(db).resume()
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])


def test_queue_five_reorder_restart(db, lecture, provider):
    from app.library import Library
    from app.contracts import LectureInput

    source = db.one("SELECT * FROM media_assets WHERE kind='original'")
    queue = QueueService(db)
    jobs = []
    # Other lectures reuse bytes through a separate import; originals stay independent.
    for i in range(5):
        import shutil

        lecture = Library(db).create_lecture(
            LectureInput(title=str(i), date="2026-10-11")
        )
        tmp = db.cfg.data / "tmp/upload" / str(i)
        shutil.copyfile(db.cfg.data / source["path"], tmp)
        media.finish_upload(db, lecture["id"], tmp, "audio.wav")
        jobs.append(
            queue.enqueue(
                JobInput(
                    lecture_id=lecture["id"],
                    settings=TranscriptionSettings(),
                    confirmed=True,
                )
            )
        )
    queue.reorder([j["id"] for j in reversed(jobs)])
    Worker(db, provider).reconcile()
    assert [j["id"] for j in queue.list()["jobs"]] == [j["id"] for j in reversed(jobs)]
    for _ in range(7):
        Worker(db, provider).step()
    assert provider.posts == 5


def test_words_artifacts_and_original_are_immutable(db, job, provider):
    worker = Worker(db, provider)
    for _ in range(10):
        worker.step()
    assert provider.posts == len(job["chunks"])
    t = transcripts.get_transcript(db, QueueService(db).job(job["id"])["transcript_id"])
    before_words = db.all("SELECT * FROM transcript_words")
    before_artifacts = db.all("SELECT * FROM provider_artifacts")
    blocks = [Block.model_validate(b) for b in t["blocks"]]
    blocks[0].text = "بازنویسی substantial rewrite"
    blocks[0].start_ms = 999999
    blocks[0].alignment_status = "provider_exact"
    saved = transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
    )
    assert saved["blocks"][0]["alignment_status"] == "edited_anchor"
    assert saved["blocks"][0]["start_ms"] == t["blocks"][0]["start_ms"]
    assert db.all("SELECT * FROM transcript_words") == before_words
    assert db.all("SELECT * FROM provider_artifacts") == before_artifacts
    with pytest.raises(sqlite3.IntegrityError):
        with db.tx() as con:
            con.execute("UPDATE transcript_words SET text='altered'")
    with pytest.raises(AppError):
        transcripts.save(
            db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
        )
    restored = transcripts.restore_revision(
        db, t["id"], t["revision"], saved["revision"]
    )
    assert restored["revision"] > saved["revision"]
    assert restored["blocks"][0]["text"] == t["blocks"][0]["text"]


def test_multiple_cuts_and_smart_chunks_cover_long_timeline():
    spans = [
        {"start_ms": 0, "end_ms": 1800000},
        {"start_ms": 2100000, "end_ms": 5100000},
        {"start_ms": 5500000, "end_ms": 7200000},
    ]
    assert media.virtual_duration(spans) == 6500000
    for virtual in [0, 500, 1799999, 1800000, 4800000, 6499999, 6500000]:
        assert (
            media.source_to_virtual(spans, media.virtual_to_source(spans, virtual))
            == virtual
        )
    plan = media.chunk_plan(spans, 900000, [895000, 3901000])
    assert plan == media.chunk_plan(spans, 900000, [895000, 3901000])
    assert plan[0][0] == 0 and plan[-1][1] == 6500000 and plan[0][1] == 895000
    assert all(a[1] == b[0] for a, b in zip(plan, plan[1:]))
    assert sum(e - s for s, e in plan) == 6500000


def test_preprocess_and_edl_never_change_original(db, lecture):
    orig = media.original(db, lecture["id"])
    path = db.cfg.data / orig["path"]
    digest = sha256(path)
    from app.library import Library

    cuts = [
        {"start_ms": 0, "end_ms": 800},
        {"start_ms": 1300, "end_ms": 2100},
        {"start_ms": 2400, "end_ms": 3000},
    ]
    Library(db).save_edl(lecture["id"], cuts)
    clean = media.preview(db, lecture["id"], cuts, {})
    enhanced = media.preview(db, lecture["id"], cuts, {"enabled": True})
    assert clean != enhanced and media.virtual_duration(cuts) == 2200
    assert sha256(path) == digest


def test_graceful_stop_during_render_prevents_new_request(db, job, provider):
    stopping = False

    def fault(stage):
        nonlocal stopping
        if stage == "prepared":
            stopping = True

    worker = Worker(db, provider, fault, stop_requested=lambda: stopping)
    worker.step()
    assert provider.posts == 0
    assert not db.all("SELECT * FROM provider_attempts")


def test_failed_preparation_is_a_safe_local_retry(db, job, provider):
    from app.errors import AppError

    def fault(stage):
        if stage == "preparing":
            raise AppError("local_media", "Injected renderer failure")

    Worker(db, provider, fault).step()
    assert provider.posts == 0
    result = QueueService(db).retry(
        job["id"], RetryInput(chunk_id=job["chunks"][0]["id"])
    )
    assert result["retry_type"] == "local_preparation"
    Worker(db, provider).step()
    assert provider.posts == 1


@pytest.mark.parametrize("recover_via", ["startup", "retry"])
def test_artifact_wins_over_mistaken_unknown_classification(
    db, job, provider, recover_via
):
    def fault(stage):
        if stage == "artifact_written":
            raise Crash()

    worker = Worker(db, provider, fault)
    with pytest.raises(Crash):
        worker.step()
    assert provider.posts == 1
    attempt = db.one("SELECT * FROM provider_attempts")
    Worker(db, provider).unknown(attempt)
    assert QueueService(db).job(job["id"])["state"] == "unknown_outcome"
    if recover_via == "startup":
        Worker(db, provider).reconcile()
    else:
        result = QueueService(db).retry(
            job["id"], RetryInput(chunk_id=attempt["chunk_id"])
        )
        assert result["retry_type"] == "local_normalization"
    QueueService(db).resume()
    for _ in range(10):
        Worker(db, provider).step()
    assert provider.posts == len(job["chunks"])
    assert (
        len(
            db.all(
                "SELECT id FROM provider_attempts WHERE chunk_id=?",
                (attempt["chunk_id"],),
            )
        )
        == 1
    )
    assert QueueService(db).job(job["id"])["state"] == "succeeded"
