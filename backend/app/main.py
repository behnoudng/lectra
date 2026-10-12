from contextlib import asynccontextmanager
from urllib.parse import urlparse
import json
import os
import sqlite3
from fastapi import FastAPI, UploadFile, File, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from .config import settings, Config
from .db import Database, now
from .errors import AppError
from .provider_errors import attempt_diagnostic
from .storage import uid, safe_path, canonical, lock
from .contracts import (
    CourseInput,
    VocabularyInput,
    TagInput,
    LectureInput,
    EDLInput,
    Preprocessing,
    JobInput,
    RetryInput,
    OrderInput,
    TranscriptSave,
    SpeakerInput,
    Preferences,
    Budget,
    PriceInput,
    BackupInput,
)
from .library import Library
from .queue import QueueService
from .provider import ElevenLabs
from .backup import BackupService
from . import media, pricing, transcripts


class LockedFileResponse(FileResponse):
    def __init__(self, *args, runtime_lock, **kwargs):
        super().__init__(*args, **kwargs)
        self.runtime_lock = runtime_lock

    async def __call__(self, scope, receive, send):
        try:
            with lock(self.runtime_lock, exclusive=False, blocking=False):
                await super().__call__(scope, receive, send)
        except AppError as error:
            if error.category != "restore":
                raise
            await JSONResponse(
                {
                    "error": {
                        "category": "restore",
                        "message": "Restore maintenance is active. Retry after it completes.",
                    }
                },
                status_code=503,
            )(scope, receive, send)


def create_app(cfg: Config | None = None):
    cfg = cfg or settings()
    db = Database(cfg)
    library = Library(db)
    queue = QueueService(db)
    backups = BackupService(db)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await run_in_threadpool(db.initialize)
            app.state.ready = True

            # Reconcile only when no live worker owns a request.
            def reconcile():
                try:
                    from worker.engine import Worker

                    with lock(cfg.data / "worker.lock", blocking=False):
                        with lock(cfg.data / "runtime.lock", exclusive=False):
                            Worker(db).reconcile()
                except AppError as e:
                    if e.category != "restore":
                        raise
                for asset in db.all(
                    "SELECT path FROM media_assets WHERE kind='original' AND deleted_at IS NOT NULL"
                ):
                    safe_path(cfg.data, asset["path"]).unlink(missing_ok=True)

            await run_in_threadpool(reconcile)
        except AppError as error:
            app.state.readiness_error = error.message
            app.state.ready = False
        yield

    app = FastAPI(title="Lectra", version="1.0.0", lifespan=lifespan)
    app.state.db = db
    app.state.ready = False
    app.state.readiness_error = None

    @app.exception_handler(AppError)
    async def application_error(request, error):
        return JSONResponse(
            {"error": {"category": error.category, "message": error.message}},
            status_code=error.status,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse(
            {
                "error": {
                    "category": "validation",
                    "message": "Invalid request fields.",
                    "fields": [
                        {"loc": e["loc"], "type": e["type"], "message": e["msg"]}
                        for e in error.errors()
                    ],
                }
            },
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def unexpected(request, error):
        return JSONResponse(
            {
                "error": {
                    "category": "storage"
                    if isinstance(error, OSError)
                    else "database"
                    if isinstance(error, sqlite3.Error)
                    else "validation",
                    "message": "The operation failed safely. Check available storage and service status.",
                }
            },
            status_code=500,
        )

    @app.middleware("http")
    async def local_security(request: Request, call_next):
        host = request.url.hostname
        if host not in ("localhost", "127.0.0.1", "api", "testserver"):
            return JSONResponse(
                {
                    "error": {
                        "category": "validation",
                        "message": "Lectra is localhost-only.",
                    }
                },
                status_code=403,
            )
        origin = request.headers.get("origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin:
            parsed = urlparse(origin)
            if parsed.scheme not in ("http", "https") or parsed.hostname not in (
                "localhost",
                "127.0.0.1",
            ):
                return JSONResponse(
                    {
                        "error": {
                            "category": "validation",
                            "message": "Cross-origin writes are forbidden.",
                        }
                    },
                    status_code=403,
                )
        if not app.state.ready and request.url.path not in (
            "/api/v1/health",
            "/api/v1/system/status",
        ):
            return JSONResponse(
                {
                    "error": {
                        "category": "database",
                        "message": app.state.readiness_error or "Starting.",
                    }
                },
                status_code=503,
            )
        if (cfg.data / "maintenance").exists():
            return JSONResponse(
                {
                    "error": {
                        "category": "restore",
                        "message": "Restore maintenance is active.",
                    }
                },
                status_code=503,
            )
        # Shared cross-process lock spans requests, preventing DB/asset swap during reads or saves.
        # Restore acquires its own exclusive lock, so this one route must not hold a shared lock.
        if request.url.path.endswith("/restore") and request.url.path.startswith(
            "/api/v1/backups/"
        ):
            return await call_next(request)
        try:
            with lock(cfg.data / "runtime.lock", exclusive=False, blocking=False):
                response = await call_next(request)
                response.headers["X-Content-Type-Options"] = "nosniff"
                return response
        except AppError as error:
            if error.category != "restore":
                raise
            return JSONResponse(
                {
                    "error": {
                        "category": "restore",
                        "message": "Restore maintenance is active. Retry after it completes.",
                    }
                },
                status_code=503,
            )

    @app.get("/api/v1/health")
    def health():
        if not app.state.ready:
            raise AppError("database", app.state.readiness_error or "Starting.", 503)
        return {"status": "ok", "sqlite_version": sqlite3.sqlite_version}

    @app.get("/api/v1/system/status")
    def status():
        heartbeat = cfg.data / "worker-heartbeat.json"
        return {
            "ready": app.state.ready,
            "readiness_error": app.state.readiness_error,
            "sqlite_version": sqlite3.sqlite_version,
            "worker_heartbeat": json.loads(heartbeat.read_text())
            if heartbeat.exists()
            else None,
            "provider_configured": bool(os.getenv("ELEVENLABS_API_KEY")),
            "localhost_only": True,
        }

    @app.get("/api/v1/provider/status")
    def provider_status():
        configured = bool(os.getenv("ELEVENLABS_API_KEY"))
        return with_transcription_status(
            {
                "status": "Configured" if configured else "Not configured",
                "credential_source": "ELEVENLABS_API_KEY environment variable",
                "key_configured": configured,
                "transcription_verified": False,
            }
        )

    def with_transcription_status(result):
        latest = db.one(
            "SELECT * FROM provider_attempts ORDER BY created_at DESC,attempt_no DESC LIMIT 1",
            required=False,
        )
        result["last_transcription"] = (
            {
                "state": latest["state"],
                "created_at": latest["created_at"],
                "diagnostic": attempt_diagnostic(latest)
                if latest["state"] == "failed_provider"
                else None,
            }
            if latest
            else None
        )
        return result

    @app.post("/api/v1/provider/test")
    def provider_test():
        return with_transcription_status(ElevenLabs(cfg.provider_url).account())

    @app.get("/api/v1/provider/subscription")
    def subscription():
        return ElevenLabs(cfg.provider_url).account(subscription=True)

    @app.get("/api/v1/settings")
    def preferences():
        return Preferences.model_validate(
            json.loads(
                db.one("SELECT value FROM app_settings WHERE key='preferences'")[
                    "value"
                ]
            )
        ).model_dump()

    @app.patch("/api/v1/settings")
    def save_preferences(data: Preferences):
        with db.tx() as con:
            con.execute(
                "UPDATE app_settings SET value=? WHERE key='preferences'",
                (canonical(data.model_dump()),),
            )
        return preferences()

    @app.get("/api/v1/budget")
    def budget():
        return {
            "budget": json.loads(
                db.one("SELECT value FROM app_settings WHERE key='budget'")["value"]
            ),
            "ledger": pricing.totals(db),
        }

    @app.patch("/api/v1/budget")
    def save_budget(data: Budget):
        with db.tx() as con:
            con.execute(
                "UPDATE app_settings SET value=? WHERE key='budget'",
                (canonical(data.model_dump()),),
            )
        return budget()

    @app.get("/api/v1/pricing")
    def prices():
        return db.all("SELECT * FROM pricing_rules ORDER BY effective_from DESC")

    @app.post("/api/v1/pricing")
    def save_price(data: PriceInput):
        return {"id": pricing.save_rule(db, data)}

    @app.get("/api/v1/usage")
    def usage():
        return db.all("SELECT * FROM usage_ledger ORDER BY created_at DESC")

    @app.get("/api/v1/courses")
    def courses():
        return library.courses()

    @app.post("/api/v1/courses", status_code=201)
    def create_course(data: CourseInput):
        return library.create_course(data)

    @app.get("/api/v1/courses/{course_id}")
    def course(course_id: str):
        return library.course(course_id)

    @app.patch("/api/v1/courses/{course_id}")
    def update_course(course_id: str, data: CourseInput):
        return library.update_course(course_id, data)

    @app.delete("/api/v1/courses/{course_id}")
    def delete_course(course_id: str):
        library.course(course_id)
        with db.tx() as con:
            ids = [
                r[0]
                for r in con.execute(
                    "SELECT id FROM lectures WHERE course_id=?", (course_id,)
                )
            ]
            con.execute("DELETE FROM courses WHERE id=?", (course_id,))
            for lecture_id in ids:
                transcripts.index_lecture(con, lecture_id)
        return {"deleted": True}

    @app.get("/api/v1/courses/{course_id}/vocabulary")
    def vocabulary(course_id: str):
        return {"terms": library.course(course_id)["vocabulary"]}

    @app.put("/api/v1/courses/{course_id}/vocabulary")
    def update_vocabulary(course_id: str, data: VocabularyInput):
        return library.vocabulary(course_id, data.terms)

    @app.get("/api/v1/tags")
    def tags():
        return db.all("SELECT * FROM tags ORDER BY name")

    @app.post("/api/v1/tags", status_code=201)
    def create_tag(data: TagInput):
        tag_id = uid()
        with db.tx() as con:
            con.execute("INSERT INTO tags VALUES(?,?)", (tag_id, data.name))
        return {"id": tag_id, "name": data.name}

    @app.get("/api/v1/lectures")
    def lectures():
        return library.lectures()

    @app.post("/api/v1/lectures", status_code=201)
    def create_lecture(data: LectureInput):
        return library.create_lecture(data)

    @app.get("/api/v1/lectures/{lecture_id}")
    def lecture(lecture_id: str):
        return library.lecture(lecture_id)

    @app.patch("/api/v1/lectures/{lecture_id}")
    def update_lecture(lecture_id: str, data: LectureInput):
        return library.update_lecture(lecture_id, data)

    @app.post("/api/v1/lectures/{lecture_id}/audio")
    async def upload(lecture_id: str, file: UploadFile = File(...)):
        library.lecture(lecture_id)
        temporary = cfg.data / "tmp/upload" / uid()
        try:
            total = 0
            with temporary.open("xb") as output:
                while data := await file.read(1024 * 1024):
                    total += len(data)
                    if total > 20 * 1024**3:
                        raise AppError(
                            "validation", "Upload exceeds the 20 GiB safety limit.", 413
                        )
                    output.write(data)
                output.flush()
                os.fsync(output.fileno())
            return await run_in_threadpool(
                media.finish_upload,
                db,
                lecture_id,
                temporary,
                file.filename or "recording",
            )
        finally:
            temporary.unlink(missing_ok=True)
            await file.close()

    @app.post("/api/v1/lectures/{lecture_id}/proxy")
    def proxy(lecture_id: str):
        return {"id": media.generate_proxy(db, lecture_id)}

    @app.delete("/api/v1/lectures/{lecture_id}/original-audio")
    def delete_original(lecture_id: str, confirmed: bool = False):
        if not confirmed:
            raise AppError(
                "validation",
                "Confirm deletion of the original recording. Transcript and playback proxies remain.",
                409,
            )
        return library.delete_original(lecture_id)

    @app.get("/api/v1/media/{asset_id}")
    def stream(asset_id: str):
        asset = db.one(
            "SELECT * FROM media_assets WHERE id=? AND deleted_at IS NULL", (asset_id,)
        )
        return LockedFileResponse(
            safe_path(cfg.data, asset["path"]),
            media_type=asset["mime"],
            runtime_lock=cfg.data / "runtime.lock",
        )

    @app.get("/api/v1/media/{asset_id}/peaks")
    def waveform(asset_id: str):
        return media.peaks(
            db,
            db.one(
                "SELECT * FROM media_assets WHERE id=? AND deleted_at IS NULL",
                (asset_id,),
            ),
        )

    @app.put("/api/v1/lectures/{lecture_id}/edl")
    def edl(lecture_id: str, data: EDLInput):
        return library.save_edl(lecture_id, [s.model_dump() for s in data.spans])

    @app.put("/api/v1/lectures/{lecture_id}/preprocess")
    def preprocess(lecture_id: str, data: Preprocessing):
        library.lecture(lecture_id)
        with db.tx() as con:
            con.execute(
                "UPDATE lectures SET preprocessing=? WHERE id=?",
                (canonical(data.model_dump()), lecture_id),
            )
        return data

    @app.post("/api/v1/lectures/{lecture_id}/preprocess-preview")
    def preprocess_preview(lecture_id: str, data: Preprocessing):
        lecture = library.lecture(lecture_id)
        return {
            "clean_id": media.preview(db, lecture_id, lecture["edl"], {}),
            "enhanced_id": media.preview(
                db, lecture_id, lecture["edl"], {**data.model_dump(), "enabled": True}
            ),
            "duration_ms": lecture["duration_ms"],
        }

    @app.post("/api/v1/lectures/{lecture_id}/monitor-preview")
    def monitor_preview(lecture_id: str, data: Preprocessing):
        library.lecture(lecture_id)
        source = db.one(
            "SELECT * FROM media_assets WHERE lecture_id=? AND kind IN ('original','proxy') AND deleted_at IS NULL ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END LIMIT 1",
            (lecture_id,),
        )
        # Keep recording times intact: monitoring applies effects to the source,
        # while the player skips the retained-span gaps separately.
        return {
            "id": media.preview(
                db,
                lecture_id,
                [{"start_ms": 0, "end_ms": source["duration_ms"]}],
                {**data.model_dump(), "enabled": True},
            ),
            "duration_ms": source["duration_ms"],
        }

    @app.post("/api/v1/jobs/estimate")
    def estimate(data: JobInput):
        return queue.estimate(data)

    @app.post("/api/v1/jobs", status_code=201)
    def enqueue(data: JobInput):
        if not os.getenv("ELEVENLABS_API_KEY"):
            raise AppError(
                "provider_auth",
                "Transcription is disabled until ELEVENLABS_API_KEY is set in the backend environment.",
                409,
            )
        if not data.review_hash:
            raise AppError(
                "preflight_changed",
                "Obtain and review a current estimate before enqueueing.",
                409,
            )
        return queue.enqueue(data)

    @app.get("/api/v1/jobs/{job_id}")
    def job(job_id: str):
        return queue.job(job_id)

    @app.post("/api/v1/jobs/{job_id}/retry")
    def retry(job_id: str, data: RetryInput):
        return queue.retry(job_id, data)

    @app.post("/api/v1/jobs/{job_id}/cancel")
    def cancel(job_id: str):
        queue.cancel(job_id)
        return {"state": "canceled"}

    @app.get("/api/v1/queue")
    def get_queue():
        return queue.list()

    @app.patch("/api/v1/queue/order")
    def order(data: OrderInput):
        queue.reorder(data.job_ids)
        return queue.list()

    @app.post("/api/v1/queue/pause")
    def pause():
        queue.pause()
        return queue.list()

    @app.post("/api/v1/queue/resume")
    def resume():
        queue.resume()
        return queue.list()

    @app.get("/api/v1/transcripts/{transcript_id}")
    def transcript(transcript_id: str):
        return transcripts.get_transcript(db, transcript_id)

    @app.patch("/api/v1/transcripts/{transcript_id}")
    def save_transcript(transcript_id: str, data: TranscriptSave):
        return transcripts.save(db, transcript_id, data)

    @app.put("/api/v1/transcripts/{transcript_id}/speakers")
    def speakers(transcript_id: str, data: SpeakerInput):
        with db.tx() as con:
            t = con.execute(
                "SELECT * FROM transcripts WHERE id=?", (transcript_id,)
            ).fetchone()
            if not t:
                raise AppError("validation", "Transcript not found.", 404)
            if t["revision"] != data.base_revision:
                raise AppError(
                    "editor_conflict",
                    "Transcript changed before speaker edits. Keep your draft and review the current revision.",
                    409,
                )
            for key, label in data.labels.items():
                con.execute(
                    "INSERT INTO speaker_labels VALUES(?,?,?) ON CONFLICT(transcript_id,speaker_key) DO UPDATE SET label=excluded.label",
                    (transcript_id, key, label),
                )
            for old, new in data.merges.items():
                con.execute(
                    "UPDATE transcript_blocks SET speaker_key=? WHERE transcript_id=? AND speaker_key=?",
                    (new, transcript_id, old),
                )
            con.execute(
                "UPDATE transcripts SET revision=revision+1,updated_at=? WHERE id=?",
                (now(), transcript_id),
            )
            transcripts.snapshot(
                con, transcript_id, t["revision"] + 1, "speaker labels"
            )
        return transcripts.get_transcript(db, transcript_id)

    @app.get("/api/v1/transcripts/{transcript_id}/words")
    def words(transcript_id: str):
        return db.all(
            "SELECT * FROM transcript_words WHERE transcript_id=? ORDER BY start_ms,ordinal",
            (transcript_id,),
        )

    @app.get("/api/v1/transcripts/{transcript_id}/revisions")
    def revisions(transcript_id: str):
        return db.all(
            "SELECT revision,reason,created_at FROM transcript_revisions WHERE transcript_id=? ORDER BY revision DESC",
            (transcript_id,),
        )

    @app.post("/api/v1/transcripts/{transcript_id}/revisions/{revision}/restore")
    def restore_revision(transcript_id: str, revision: int, base_revision: int):
        return transcripts.restore_revision(db, transcript_id, revision, base_revision)

    @app.post("/api/v1/transcripts/{transcript_id}/playback")
    def transcript_playback(transcript_id: str):
        t = db.one("SELECT * FROM transcripts WHERE id=?", (transcript_id,))
        job = db.one("SELECT * FROM transcription_jobs WHERE id=?", (t["job_id"],))
        spans = json.loads(job["source_spans"])
        opts = json.loads(job["settings"])
        return {
            "id": media.preview(db, t["lecture_id"], spans, opts["preprocessing"]),
            "duration_ms": job["duration_ms"],
        }

    @app.get("/api/v1/search")
    def search(q: str = Query(max_length=500)):
        return transcripts.search(db, q)

    @app.get("/api/v1/lectures/{lecture_id}/export")
    def export(
        lecture_id: str,
        format: str = "txt",
        timestamps: bool = False,
        speakers: bool = False,
    ):
        if format not in ("txt", "md"):
            raise AppError("validation", "Choose TXT or Markdown.")
        text = transcripts.export(db, lecture_id, format == "md", timestamps, speakers)
        return Response(
            text,
            media_type="text/markdown" if format == "md" else "text/plain",
            headers={"Content-Disposition": f'attachment; filename="lecture.{format}"'},
        )

    @app.get("/api/v1/backups")
    def get_backups():
        return backups.list()

    @app.post("/api/v1/backups", status_code=201)
    def backup(data: BackupInput):
        return backups.create(data.include_audio)

    @app.post("/api/v1/backups/{backup_id}/verify")
    def verify_backup(backup_id: str):
        return backups.verify(backup_id)

    @app.post("/api/v1/backups/{backup_id}/restore")
    def restore_backup(backup_id: str):
        return backups.restore(backup_id)

    return app


app = create_app()
