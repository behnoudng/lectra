"""A real two-hour media pipeline. Opt in with LECTRA_LONG_TEST=1."""

import os
import pytest
from app import media, transcripts
from app.storage import sha256
from app.library import Library
from app.queue import QueueService
from app.contracts import (
    LectureInput,
    JobInput,
    TranscriptionSettings,
    Block,
    TranscriptSave,
)
from app.backup import BackupService
from worker.engine import Worker


@pytest.mark.skipif(
    os.getenv("LECTRA_LONG_TEST") != "1",
    reason="Set LECTRA_LONG_TEST=1 for the two-hour FFmpeg acceptance run.",
)
def test_two_hour_recording_end_to_end(db, provider, tmp_path):
    fixture = tmp_path / "two-hour.mp3"
    media.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000",
            "-t",
            "7200",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "32k",
            str(fixture),
        ]
    )
    lecture = Library(db).create_lecture(
        LectureInput(title="Two hour Persian/English lecture", date="2026-10-11")
    )
    media.finish_upload(db, lecture["id"], fixture, "two-hour.mp3")
    original = media.original(db, lecture["id"])
    original_path = db.cfg.data / original["path"]
    digest = sha256(original_path)
    spans = [
        {"start_ms": 0, "end_ms": 1800000},
        {"start_ms": 1830000, "end_ms": 4800000},
        {"start_ms": 4830000, "end_ms": 7200000},
    ]
    Library(db).save_edl(lecture["id"], spans)
    options = TranscriptionSettings()
    queue = QueueService(db)
    estimate = queue.estimate(JobInput(lecture_id=lecture["id"], settings=options))
    assert estimate["duration_ms"] == 7140000 and estimate["requests"] == 8
    job = queue.enqueue(
        JobInput(lecture_id=lecture["id"], settings=options, confirmed=True)
    )
    worker = Worker(db, provider)
    for _ in range(12):
        worker.step()
    assert provider.posts == 8 and queue.job(job["id"])["state"] == "succeeded"
    t = transcripts.get_transcript(db, queue.job(job["id"])["transcript_id"])
    blocks = [Block.model_validate(b) for b in t["blocks"]]
    blocks[0].text = "هم‌ارزی logical equivalence و P → Q"
    transcripts.save(
        db, t["id"], TranscriptSave(base_revision=t["revision"], blocks=blocks)
    )
    assert transcripts.search(db, "logical equivalence")
    assert blocks[0].text in transcripts.export(db, lecture["id"], False, False, False)
    backup = BackupService(db)
    snapshot = backup.create(True)
    backup.verify(snapshot["id"])
    backup.restore(snapshot["id"])
    assert sha256(original_path) == digest
    assert provider.posts == 8 and not list((db.cfg.data / "tmp/chunks").glob("*.wav"))
