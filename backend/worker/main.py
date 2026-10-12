import json
import logging
import signal
import time
import threading
from datetime import datetime, timezone
from app.config import settings
from app.db import Database
from app.storage import lock, atomic_bytes, canonical
from app.backup import BackupService
from .engine import Worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main():
    cfg = settings()
    db = Database(cfg)
    db.initialize()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with lock(cfg.data / "worker.lock", blocking=False):
        heartbeat_stop = threading.Event()

        def heartbeat():
            while not heartbeat_stop.is_set():
                atomic_bytes(
                    cfg.data / "worker-heartbeat.json",
                    canonical({"at": datetime.now(timezone.utc).isoformat()}).encode(),
                )
                heartbeat_stop.wait(5)

        threading.Thread(target=heartbeat, daemon=True).start()
        worker = Worker(db, stop_requested=lambda: stopping)
        with lock(cfg.data / "runtime.lock", exclusive=False):
            worker.reconcile()
        while not stopping:
            try:
                active = worker.step()
                atomic_bytes(
                    cfg.data / "worker-heartbeat.json",
                    canonical({"at": datetime.now(timezone.utc).isoformat()}).encode(),
                )
                preferences = json.loads(
                    db.one("SELECT value FROM app_settings WHERE key='preferences'")[
                        "value"
                    ]
                )
                last = db.one(
                    "SELECT created_at FROM backup_snapshots WHERE status='verified' ORDER BY created_at DESC LIMIT 1",
                    required=False,
                )
                age = (
                    (
                        datetime.now(timezone.utc)
                        - datetime.fromisoformat(last["created_at"])
                    ).total_seconds()
                    if last
                    else float("inf")
                )
                if age >= preferences["backup_interval_hours"] * 3600:
                    with lock(cfg.data / "runtime.lock", exclusive=False):
                        BackupService(db).create(preferences["include_audio"])
                if not active:
                    time.sleep(1)
            except Exception as error:
                # Exception messages can contain remote bodies; log only class names.
                logging.error("Worker cycle failed: %s", type(error).__name__)
                time.sleep(2)
        heartbeat_stop.set()


if __name__ == "__main__":
    main()
