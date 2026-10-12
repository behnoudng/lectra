import httpx
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import struct
import wave
import pytest
from app.config import Config
from app.db import Database
from app.library import Library
from app.contracts import LectureInput, JobInput, TranscriptionSettings
from app import media
from app.provider import ElevenLabs, ProviderResponse


@pytest.fixture
def db(tmp_path):
    cfg = Config(tmp_path / "data", tmp_path / "backups", "https://api.elevenlabs.io")
    db = Database(cfg)
    db.initialize()
    return db


@pytest.fixture
def recording(tmp_path):
    path = tmp_path / "fixture.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(
            b"".join(
                struct.pack(
                    "<h",
                    int(3000 * math.sin(i * 2 * math.pi * 440 / 16000))
                    if i < 16000 or i > 32000
                    else 0,
                )
                for i in range(48000)
            )
        )
    return path


@pytest.fixture
def lecture(db, recording):
    lecture = Library(db).create_lecture(
        LectureInput(title="منطق logical equivalence", date="2026-10-11", tags=["CS"])
    )
    media.finish_upload(db, lecture["id"], recording, "../../unsafe.wav")
    return Library(db).lecture(lecture["id"])


@pytest.fixture
def job(db, lecture):
    from app.queue import QueueService

    return QueueService(db).enqueue(
        JobInput(
            lecture_id=lecture["id"],
            settings=TranscriptionSettings(target_ms=1000),
            confirmed=True,
        )
    )


class FakeProvider(ElevenLabs):
    def __init__(self):
        self.posts = 0
        self.fail_parse = False

    def before_request(self):
        pass

    def transcribe(self, path, settings):
        self.posts += 1
        text = "خب، logical equivalence و کد /tmp/a (P → Q) ۱۲۳"
        words = [
            {
                "text": text,
                "start": 0,
                "end": 0.5,
                "type": "word",
                "speaker_id": "speaker_0",
            }
        ]
        return ProviderResponse(
            json.dumps(
                {"text": text, "words": words, "transcription_id": "test"},
                ensure_ascii=False,
            ).encode(),
            200,
        )

    def normalize_response(self, raw):
        if self.fail_parse:
            raise ValueError("Injected parser failure")
        return super().normalize_response(raw)


@pytest.fixture
def provider():
    return FakeProvider()


@pytest.fixture
def vendor(monkeypatch):
    state = {"posts": 0, "active": 0, "max_active": 0, "mode": "success", "bodies": []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            status = 401 if self.headers.get("xi-api-key") == "invalid" else 200
            self.send_response(status)
            self.end_headers()
            self.wfile.write(
                b'{"tier":"test","character_count":10,"character_limit":100,"api_key":"must-not-return"}'
            )

        def do_POST(self):
            state["posts"] += 1
            state["active"] += 1
            state["max_active"] = max(state["max_active"], state["active"])
            state["bodies"].append(self.rfile.read(int(self.headers["content-length"])))
            if state["mode"] == "drop":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            else:
                self.send_response(
                    422
                    if state["mode"] == "reject"
                    else 503
                    if state["mode"] == "unavailable"
                    else 200
                )
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "text": "سلام world",
                            "words": [
                                {
                                    "text": "سلام world",
                                    "start": 0,
                                    "end": 0.5,
                                    "type": "word",
                                }
                            ],
                        }
                    ).encode()
                )
            state["active"] -= 1

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-environment-only-secret")
    provider = ElevenLabs(
        "http://127.0.0.1:" + str(server.server_port),
        httpx.Client(timeout=2, trust_env=False),
    )
    yield state, provider
    server.shutdown()
    thread.join()
    server.server_close()
