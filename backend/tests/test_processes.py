import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import pytest
from app.queue import QueueService
from app.storage import lock, sha256
from worker.engine import Worker


def launch(db, url, stage, marker):
    return subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).with_name("worker_fixture.py")),
            str(db.cfg.data),
            str(db.cfg.backups),
            url,
            stage,
            str(marker),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def wait_marker(process, marker):
    limit = time.monotonic() + 10
    while not marker.exists() and time.monotonic() < limit:
        assert process.poll() is None, process.stderr.read().decode()
        time.sleep(0.03)
    assert marker.exists()


@pytest.mark.parametrize(
    "stage,expected_posts,unknown",
    [
        ("preparing", 0, False),
        ("ffmpeg", 0, False),
        ("request_started", 0, True),
        ("artifact_written", 1, False),
        ("response_persisted", 1, False),
    ],
)
def test_sigkill_worker_checkpoint(
    db, job, vendor, stage, expected_posts, unknown, tmp_path
):
    state, vendor_provider = vendor
    marker = tmp_path / "worker-ready"
    original = db.one("SELECT path FROM media_assets WHERE kind='original'")
    original_hash = sha256(db.cfg.data / original["path"])
    process = launch(db, vendor_provider.base_url, stage, marker)
    ffmpeg_pid = None
    try:
        wait_marker(process, marker)
        if stage == "ffmpeg":
            ffmpeg_pid = json.loads(marker.read_text())["ffmpeg_pid"]
        process.kill()
        process.wait(5)
        if ffmpeg_pid:
            try:
                os.kill(ffmpeg_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        assert process.returncode == -signal.SIGKILL
        assert state["posts"] == expected_posts
        worker = Worker(db, vendor_provider)
        with lock(db.cfg.data / "worker.lock", blocking=False):
            worker.reconcile()
            for _ in range(10):
                worker.step()
        if unknown:
            assert QueueService(db).job(job["id"])["state"] == "unknown_outcome"
            assert state["posts"] == expected_posts
        else:
            assert QueueService(db).job(job["id"])["state"] == "succeeded"
            assert state["posts"] == len(job["chunks"])
        assert sha256(db.cfg.data / original["path"]) == original_hash
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stderr.close()


def test_two_worker_processes_use_single_lock(db, job, vendor, tmp_path):
    state, provider = vendor
    marker = tmp_path / "worker-ready"
    first = launch(db, provider.base_url, "prepared", marker)
    try:
        wait_marker(first, marker)
        second = launch(db, provider.base_url, "never", tmp_path / "other")
        assert second.wait(5) == 23
        second.stderr.close()
        assert state["posts"] == 0
        marker.unlink()
        assert first.wait(10) == 0
        assert state["posts"] == len(job["chunks"]) and state["max_active"] == 1
    finally:
        if first.poll() is None:
            first.kill()
            first.wait()
        first.stderr.close()
