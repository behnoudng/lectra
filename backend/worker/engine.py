"""A single process owns the worker lock. Each step has a durable checkpoint."""

import hashlib
import json
from app import media, pricing, transcripts
from app.db import now
from app.errors import AppError
from app.provider import ElevenLabs, ProviderRejected
from app.storage import uid, canonical, immutable_bytes, sha256, safe_path, lock


class Worker:
    def __init__(self, db, provider=None, fault=None, stop_requested=None):
        self.db = db
        self.provider = provider or ElevenLabs(db.cfg.provider_url)
        self.fault = fault or (lambda stage: None)
        self.stop_requested = stop_requested or (lambda: False)

    def transition(self, chunk_id, state):
        with self.db.tx() as con:
            con.execute(
                "UPDATE transcription_chunks SET state=?,error_category=NULL WHERE id=?",
                (state, chunk_id),
            )
        self.fault(state)

    def unknown(self, attempt):
        with self.db.tx() as con:
            con.execute(
                "UPDATE provider_attempts SET state='unknown_outcome' WHERE id=?",
                (attempt["id"],),
            )
            con.execute(
                "UPDATE usage_ledger SET outcome='unknown_outcome',charge_status='unknown' WHERE attempt_id=?",
                (attempt["id"],),
            )
            con.execute(
                "UPDATE transcription_chunks SET state='unknown_outcome',error_category='unknown_provider_outcome' WHERE id=?",
                (attempt["chunk_id"],),
            )
            con.execute(
                "UPDATE transcription_jobs SET state='unknown_outcome',error_category='unknown_provider_outcome' WHERE id=?",
                (attempt["job_id"],),
            )
            con.execute("UPDATE app_settings SET value='true' WHERE key='queue_paused'")

    def register_response(self, attempt, path, status=None):
        digest = sha256(path)
        with self.db.tx() as con:
            existing = con.execute(
                "SELECT * FROM provider_artifacts WHERE attempt_id=?", (attempt["id"],)
            ).fetchone()
            if existing and existing["sha256"] != digest:
                raise AppError(
                    "storage",
                    "Provider artifact integrity failure. Restore verified evidence.",
                    409,
                )
            if not existing:
                con.execute(
                    "INSERT INTO provider_artifacts VALUES(?,?,?,?,?,?)",
                    (
                        uid(),
                        attempt["id"],
                        str(path.relative_to(self.db.cfg.data)),
                        digest,
                        path.stat().st_size,
                        now(),
                    ),
                )
            con.execute(
                "UPDATE provider_attempts SET state=CASE WHEN state='succeeded' THEN state ELSE 'response_persisted' END,response_persisted_at=coalesce(response_persisted_at,?),http_status=coalesce(http_status,?) WHERE id=?",
                (now(), status, attempt["id"]),
            )
            con.execute(
                "UPDATE usage_ledger SET outcome=CASE WHEN outcome='succeeded' THEN outcome ELSE 'response_persisted' END,charge_status='processed_unconfirmed',response_persisted_at=coalesce(response_persisted_at,?),http_status=coalesce(http_status,?),raw_response_sha256=? WHERE attempt_id=?",
                (now(), status, digest, attempt["id"]),
            )
            con.execute(
                "UPDATE transcription_chunks SET state='response_persisted',error_category=NULL WHERE id=? AND state!='succeeded'",
                (attempt["chunk_id"],),
            )
        self.fault("response_persisted")

    def normalize(self, chunk, attempt):
        artifact = self.db.one(
            "SELECT * FROM provider_artifacts WHERE attempt_id=?", (attempt["id"],)
        )
        path = safe_path(self.db.cfg.data, artifact["path"])
        try:
            if sha256(path) != artifact["sha256"]:
                raise ValueError("Artifact changed.")
            self.transition(chunk["id"], "normalizing")
            neutral = self.provider.normalize_response(path.read_bytes())
            transcripts.import_chunk(self.db, chunk, neutral)
            with self.db.tx() as con:
                con.execute(
                    "UPDATE provider_attempts SET state='succeeded',provider_transcript_id=? WHERE id=?",
                    (neutral.provider_id, attempt["id"]),
                )
                con.execute(
                    "UPDATE usage_ledger SET outcome='succeeded',provider_transcript_id=? WHERE attempt_id=?",
                    (neutral.provider_id, attempt["id"]),
                )
            self.cleanup(chunk)
            self.fault("succeeded")
        except Exception as error:
            self.fail_local(
                chunk,
                error.category if isinstance(error, AppError) else "normalization",
            )
            return False
        return True

    def cleanup(self, chunk):
        # Only a generated path underneath tmp/chunks can be removed.
        if chunk["prepared_path"]:
            path = safe_path(self.db.cfg.data, chunk["prepared_path"])
            if path.is_relative_to(self.db.cfg.data / "tmp/chunks"):
                path.unlink(missing_ok=True)

    def reconcile(self):
        # Caller owns the worker lock: an API restart must never misclassify a live call.
        for attempt in self.db.all(
            "SELECT * FROM provider_attempts WHERE state IN ('request_started','response_received','response_persisted','normalizing','unknown_outcome') ORDER BY created_at"
        ):
            path = safe_path(
                self.db.cfg.data / "artifacts/provider", f"{attempt['id']}.json"
            )
            if attempt["state"] == "unknown_outcome" and not path.exists():
                continue
            artifact = self.db.one(
                "SELECT * FROM provider_artifacts WHERE attempt_id=?",
                (attempt["id"],),
                required=False,
            )
            if path.exists():
                self.register_response(attempt, path)
                chunk = self.db.one(
                    "SELECT * FROM transcription_chunks WHERE id=?",
                    (attempt["chunk_id"],),
                )
                self.cleanup(chunk)
                if chunk["state"] != "succeeded":
                    self.normalize(chunk, attempt)
            elif artifact:
                self.fail_local(
                    self.db.one(
                        "SELECT * FROM transcription_chunks WHERE id=?",
                        (attempt["chunk_id"],),
                    ),
                    "storage",
                )
            else:
                self.unknown(attempt)
        # Token commit can precede the final attempt/assembly transition.
        for chunk in self.db.all(
            "SELECT * FROM transcription_chunks WHERE state='succeeded'"
        ):
            with self.db.tx() as con:
                con.execute(
                    "UPDATE provider_attempts SET state='succeeded' WHERE chunk_id=? AND state='response_persisted'",
                    (chunk["id"],),
                )
                con.execute(
                    "UPDATE usage_ledger SET outcome='succeeded' WHERE chunk_id=? AND outcome='response_persisted'",
                    (chunk["id"],),
                )
            self.cleanup(chunk)
        with self.db.tx() as con:
            con.execute(
                "UPDATE transcription_chunks SET state='pending' WHERE state IN ('preparing','prepared') AND NOT EXISTS(SELECT 1 FROM provider_attempts a WHERE a.chunk_id=transcription_chunks.id AND a.state IN ('request_started','response_received','unknown_outcome'))"
            )
        with self.db.tx() as con:
            con.execute(
                "UPDATE transcription_jobs SET state='queued',error_category=NULL WHERE state IN ('unknown_outcome','failed_local') AND NOT EXISTS(SELECT 1 FROM transcription_chunks c WHERE c.job_id=transcription_jobs.id AND c.state IN ('unknown_outcome','failed_local','failed_provider','needs_retry_approval'))"
            )
        for job in self.db.all(
            "SELECT * FROM transcription_jobs WHERE state IN ('running','queued')"
        ):
            self.assemble(job["id"])
        referenced = {
            str(safe_path(self.db.cfg.data, c["prepared_path"]))
            for c in self.db.all(
                "SELECT prepared_path FROM transcription_chunks WHERE prepared_path IS NOT NULL"
            )
        }
        for path in (self.db.cfg.data / "tmp/chunks").glob("*"):
            if path.is_file() and str(path.resolve()) not in referenced:
                path.unlink()

    def assemble(self, job_id):
        chunks = self.db.all(
            "SELECT state FROM transcription_chunks WHERE job_id=?", (job_id,)
        )
        if chunks and all(c["state"] == "succeeded" for c in chunks):
            with self.db.tx() as con:
                con.execute(
                    "UPDATE transcription_jobs SET state='succeeded',error_category=NULL WHERE id=?",
                    (job_id,),
                )
                con.execute(
                    "UPDATE lectures SET status='ready' WHERE id=(SELECT lecture_id FROM transcription_jobs WHERE id=?)",
                    (job_id,),
                )
                lecture_id = con.execute(
                    "SELECT lecture_id FROM transcription_jobs WHERE id=?", (job_id,)
                ).fetchone()[0]
                transcripts.index_lecture(con, lecture_id)

    def fail_local(self, chunk, category):
        with self.db.tx() as con:
            con.execute(
                "UPDATE transcription_chunks SET state='failed_local',error_category=? WHERE id=?",
                (category, chunk["id"]),
            )
            con.execute(
                "UPDATE transcription_jobs SET state='failed_local',error_category=? WHERE id=?",
                (category, chunk["job_id"]),
            )

    def prepare(self, chunk, job):
        self.transition(chunk["id"], "preparing")
        asset = media.original(self.db, job["lecture_id"])
        path = safe_path(self.db.cfg.data / "tmp/chunks", f"{chunk['id']}.wav")
        opts = json.loads(job["settings"])
        spans = json.loads(job["source_spans"])
        # Any file left by interrupted rendering is replaced atomically, never sent speculatively.
        media.render(
            safe_path(self.db.cfg.data, asset["path"]),
            path,
            media.intersect_spans(spans, chunk["start_ms"], chunk["end_ms"]),
            opts["preprocessing"],
        )
        digest = sha256(path)
        with self.db.tx() as con:
            con.execute(
                "UPDATE transcription_chunks SET state='prepared',prepared_path=?,prepared_sha256=?,error_category=NULL WHERE id=?",
                (str(path.relative_to(self.db.cfg.data)), digest, chunk["id"]),
            )
        self.fault("prepared")
        return self.db.one(
            "SELECT * FROM transcription_chunks WHERE id=?", (chunk["id"],)
        )

    def start_attempt(self, chunk, job):
        attempt_id = uid()
        settings = json.loads(job["settings"])
        request_hash = hashlib.sha256(
            canonical([settings, chunk["prepared_sha256"]]).encode()
        ).hexdigest()
        rule = (
            self.db.one(
                "SELECT * FROM pricing_rules WHERE id=?",
                (job["pricing_rule_id"],),
                required=False,
            )
            if job["pricing_rule_id"]
            else None
        )
        cost = pricing.estimate_chunk(
            chunk["end_ms"] - chunk["start_ms"], settings, rule
        )
        timestamp = now()
        with self.db.tx() as con:
            live_job = con.execute(
                "SELECT state FROM transcription_jobs WHERE id=?", (job["id"],)
            ).fetchone()
            live_chunk = con.execute(
                "SELECT state FROM transcription_chunks WHERE id=?", (chunk["id"],)
            ).fetchone()
            paused = json.loads(
                con.execute(
                    "SELECT value FROM app_settings WHERE key='queue_paused'"
                ).fetchone()[0]
            )
            if (
                paused
                or live_job["state"] not in ("queued", "running")
                or live_chunk["state"] != "prepared"
            ):
                return None
            prior = con.execute(
                "SELECT * FROM provider_attempts WHERE chunk_id=? ORDER BY attempt_no DESC LIMIT 1",
                (chunk["id"],),
            ).fetchone()
            if prior and (
                prior["state"] not in ("unknown_outcome", "failed_provider")
                or not job["retry_authorized_at"]
                or job["retry_authorized_at"] <= prior["request_started_at"]
            ):
                raise AppError(
                    "unknown_provider_outcome",
                    "A new provider attempt requires explicit retry authorization.",
                    409,
                )
            number = prior["attempt_no"] + 1 if prior else 1
            con.execute(
                "INSERT INTO provider_attempts(id,job_id,chunk_id,attempt_no,state,request_hash,audio_sha256,retry_of_attempt_id,retry_reason,retry_authorized_at,request_started_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    attempt_id,
                    job["id"],
                    chunk["id"],
                    number,
                    "request_started",
                    request_hash,
                    chunk["prepared_sha256"],
                    prior["id"] if prior else None,
                    job["retry_reason"] if prior else None,
                    job["retry_authorized_at"] if prior else None,
                    timestamp,
                    timestamp,
                ),
            )
            con.execute(
                "INSERT INTO usage_ledger(attempt_id,job_id,chunk_id,provider,model,endpoint,request_hash,audio_duration_ms,estimated_billable_ms,keyterm_count,features_json,pricing_rule_id,estimated_cost,currency,charge_status,attempt_no,retry_of_attempt_id,retry_reason,retry_authorized_at,request_started_at,outcome,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    attempt_id,
                    job["id"],
                    chunk["id"],
                    "elevenlabs",
                    "scribe_v2",
                    "/v1/speech-to-text",
                    request_hash,
                    chunk["end_ms"] - chunk["start_ms"],
                    cost["billable_ms"],
                    len(settings["keyterms"]),
                    canonical(cost["features"]),
                    job["pricing_rule_id"],
                    cost["estimated_cost"],
                    cost["currency"],
                    "unknown",
                    number,
                    prior["id"] if prior else None,
                    job["retry_reason"] if prior else None,
                    job["retry_authorized_at"] if prior else None,
                    timestamp,
                    "request_started",
                    timestamp,
                ),
            )
            con.execute(
                "UPDATE transcription_chunks SET state='request_started' WHERE id=?",
                (chunk["id"],),
            )
        self.fault("request_started")
        return self.db.one("SELECT * FROM provider_attempts WHERE id=?", (attempt_id,))

    def send(self, chunk, job):
        settings = json.loads(job["settings"])
        self.provider.validate_settings(settings)
        self.provider.before_request()
        attempt = self.start_attempt(chunk, job)
        if attempt is None:
            return
        try:
            response = self.provider.transcribe(
                safe_path(self.db.cfg.data, chunk["prepared_path"]), settings
            )
        except ProviderRejected as rejection:
            with self.db.tx() as con:
                con.execute(
                    "UPDATE provider_attempts SET state='failed_provider',http_status=?,error_code=?,error_message=?,request_id=? WHERE id=?",
                    (
                        rejection.status,
                        rejection.code,
                        rejection.message,
                        rejection.request_id,
                        attempt["id"],
                    ),
                )
                con.execute(
                    "UPDATE usage_ledger SET outcome='failed_provider',charge_status='rejected_unconfirmed',http_status=? WHERE attempt_id=?",
                    (rejection.status, attempt["id"]),
                )
                con.execute(
                    "UPDATE transcription_chunks SET state='failed_provider',error_category=? WHERE id=?",
                    (
                        "provider_auth"
                        if rejection.status in (401, 403)
                        else "provider_rejected",
                        chunk["id"],
                    ),
                )
                con.execute(
                    "UPDATE transcription_jobs SET state='failed_provider',error_category='provider_rejected' WHERE id=?",
                    (job["id"],),
                )
            return
        except Exception:
            # Any ordinary exception after the financial boundary is conservative.
            self.unknown(attempt)
            return
        with self.db.tx() as con:
            con.execute(
                "UPDATE provider_attempts SET state='response_received',response_received_at=?,http_status=? WHERE id=?",
                (now(), response.status, attempt["id"]),
            )
            con.execute(
                "UPDATE usage_ledger SET outcome='response_received',response_received_at=?,http_status=? WHERE attempt_id=?",
                (now(), response.status, attempt["id"]),
            )
            con.execute(
                "UPDATE transcription_chunks SET state='response_received' WHERE id=?",
                (chunk["id"],),
            )
        self.fault("response_received")
        path = safe_path(
            self.db.cfg.data / "artifacts/provider", f"{attempt['id']}.json"
        )
        # Raw bytes are persisted BEFORE decoding or normalizing.
        immutable_bytes(path, response.body)
        self.fault("artifact_written")
        self.register_response(attempt, path, response.status)
        self.cleanup(chunk)
        self.normalize(chunk, attempt)

    def step(self):
        with lock(self.db.cfg.data / "runtime.lock", exclusive=False):
            if (self.db.cfg.data / "maintenance").exists():
                return False
            paused = json.loads(
                self.db.one("SELECT value FROM app_settings WHERE key='queue_paused'")[
                    "value"
                ]
            )
            if paused or self.stop_requested():
                return False
            job = self.db.one(
                "SELECT * FROM transcription_jobs WHERE state IN ('queued','running') ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,position LIMIT 1",
                required=False,
            )
            if not job:
                return False
            chunk = self.db.one(
                "SELECT * FROM transcription_chunks WHERE job_id=? AND state!='succeeded' ORDER BY ordinal LIMIT 1",
                (job["id"],),
                required=False,
            )
            if not chunk:
                self.assemble(job["id"])
                return True
            with self.db.tx() as con:
                con.execute(
                    "UPDATE transcription_jobs SET state='running' WHERE id=?",
                    (job["id"],),
                )
            try:
                if chunk["state"] in ("response_persisted", "normalizing"):
                    attempt = self.db.one(
                        "SELECT * FROM provider_attempts WHERE chunk_id=? ORDER BY attempt_no DESC LIMIT 1",
                        (chunk["id"],),
                    )
                    self.normalize(chunk, attempt)
                elif chunk["state"] in ("pending", "preparing", "prepared"):
                    chunk = (
                        self.prepare(chunk, job)
                        if chunk["state"] != "prepared"
                        else chunk
                    )
                    # Pause during rendering is also honored before spending money.
                    if self.stop_requested() or json.loads(
                        self.db.one(
                            "SELECT value FROM app_settings WHERE key='queue_paused'"
                        )["value"]
                    ):
                        return True
                    self.send(chunk, job)
                elif chunk["state"] == "needs_retry_approval":
                    with self.db.tx() as con:
                        con.execute(
                            "UPDATE transcription_jobs SET state='needs_retry_approval' WHERE id=?",
                            (job["id"],),
                        )
                        con.execute(
                            "UPDATE app_settings SET value='true' WHERE key='queue_paused'"
                        )
                    return False
                else:
                    # Never reinterpret an unexplained state as permission to send.
                    self.reconcile()
                    return False
                self.assemble(job["id"])
            except (AppError, OSError, ValueError) as error:
                attempt = self.db.one(
                    "SELECT * FROM provider_attempts WHERE chunk_id=? ORDER BY attempt_no DESC LIMIT 1",
                    (chunk["id"],),
                    required=False,
                )
                if attempt and attempt["state"] in (
                    "request_started",
                    "response_received",
                ):
                    self.unknown(attempt)
                else:
                    self.fail_local(
                        chunk,
                        error.category if isinstance(error, AppError) else "storage",
                    )
            return True
