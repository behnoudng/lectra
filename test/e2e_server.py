"""Test-only localhost vendor + real API/worker; never calls the paid service."""

import json
import os
from pathlib import Path
import shutil
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.config import Config
from app.db import Database
from app.main import create_app
from app.provider import ElevenLabs
from app.storage import lock
from worker.engine import Worker
import httpx
import uvicorn

state = {
    "posts": 0,
    "mode": "success",
    "active": 0,
    "max_active": 0,
    "account_mode": "connected",
}


class Vendor(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        restricted = (
            self.path != "/test/stats" and state["account_mode"] == "restricted"
        )
        self.send_response(401 if restricted else 200)
        self.end_headers()
        self.wfile.write(
            json.dumps(
                state
                if self.path == "/test/stats"
                else {
                    "detail": {
                        "status": "missing_permissions",
                        "message": "Test upstream sentinel: "
                        + os.environ["ELEVENLABS_API_KEY"],
                    }
                }
                if restricted
                else {"tier": "test", "character_count": 0, "character_limit": 100}
            ).encode()
        )

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path == "/test/mode":
            options = json.loads(body)
            if "mode" in options:
                state["mode"] = options["mode"]
            if "account_mode" in options:
                state["account_mode"] = options["account_mode"]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")
            return
        state["posts"] += 1
        state["active"] += 1
        state["max_active"] = max(state["max_active"], state["active"])
        if state["mode"] == "drop":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
        elif state["mode"] == "quota_rejected":
            self.send_response(401)
            self.send_header("request-id", "e2e-quota-request-123")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "detail": {
                            "status": "quota_exceeded",
                            "message": "The key's credit limit was exceeded. Sentinel "
                            + os.environ["ELEVENLABS_API_KEY"],
                        }
                    }
                ).encode()
            )
        else:
            time.sleep(0.2)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "text": "خب، logical equivalence را بررسی کنیم.",
                        "words": [
                            {"text": "خب، ", "start": 0, "end": 0.2, "type": "word"},
                            {
                                "text": "logical equivalence را بررسی کنیم.",
                                "start": 0.2,
                                "end": 0.7,
                                "type": "word",
                                "speaker_id": "speaker_0",
                            },
                        ],
                    },
                    ensure_ascii=False,
                ).encode()
            )
        state["active"] -= 1


root = Path(os.getenv("LECTRA_E2E_DIR", "/tmp/lectra-e2e"))
# This is a test-specific root, never APP_DATA_DIR or a user directory.
if root.exists():
    shutil.rmtree(root)
cfg = Config(root / "data", root / "backups", "http://127.0.0.1:8121")
db = Database(cfg)
db.initialize()
os.environ["ELEVENLABS_API_KEY"] = "lectra-e2e-environment-sentinel"
server = ThreadingHTTPServer(("127.0.0.1", 8121), Vendor)
threading.Thread(target=server.serve_forever, daemon=True).start()


def work():
    with lock(cfg.data / "worker.lock", blocking=False):
        worker = Worker(
            db, ElevenLabs(cfg.provider_url, httpx.Client(timeout=10, trust_env=False))
        )
        worker.reconcile()
        while True:
            worker.step()
            time.sleep(0.1)


threading.Thread(target=work, daemon=True).start()
uvicorn.run(create_app(cfg), host="127.0.0.1", port=8000, access_log=False)
