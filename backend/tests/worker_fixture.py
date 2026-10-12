"""Subprocess harness used only by interruption tests."""

import json
from pathlib import Path
import subprocess
import sys
import time
import httpx
from app.config import Config
from app.db import Database
from app.errors import AppError
from app.provider import ElevenLabs
from app.storage import lock
from app import media
from worker.engine import Worker

if __name__ == "__main__":
    data, backups, url, stage, marker = sys.argv[1:]
    db = Database(Config(Path(data), Path(backups), url))
    marker = Path(marker)
    fired = False

    def fault(at):
        global fired
        if at == stage and not fired:
            fired = True
            marker.write_text("ready")
            while marker.exists():
                time.sleep(0.03)

    if stage == "ffmpeg":

        def slow_render(source, output, spans, preprocessing, **kwargs):
            proc = subprocess.Popen(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-re",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=16000",
                    "-t",
                    "60",
                    "-y",
                    str(output.with_name(output.stem + ".interrupted.wav")),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            marker.write_text(json.dumps({"ffmpeg_pid": proc.pid}))
            proc.wait()

        media.render = slow_render
    try:
        with lock(db.cfg.data / "worker.lock", blocking=False):
            worker = Worker(
                db, ElevenLabs(url, httpx.Client(timeout=5, trust_env=False)), fault
            )
            for _ in range(10):
                worker.step()
    except AppError:
        raise SystemExit(23)
