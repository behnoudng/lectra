import json
import hashlib
from .contracts import JobInput
from .db import now
from .errors import AppError
from . import media, pricing
from .storage import uid, canonical, safe_path

ACTIVE = ("queued", "running", "unknown_outcome", "failed_local", "failed_provider")


class QueueService:
    def __init__(self, db):
        self.db = db

    def review_context(self, con, lecture_id):
        lecture = con.execute(
            "SELECT l.id,l.title,l.date,l.course_id,l.edl,c.name AS course FROM lectures l LEFT JOIN courses c ON c.id=l.course_id WHERE l.id=?",
            (lecture_id,),
        ).fetchone()
        asset = con.execute(
            "SELECT id,sha256,duration_ms FROM media_assets WHERE lecture_id=? AND kind='original' AND deleted_at IS NULL",
            (lecture_id,),
        ).fetchone()
        if not lecture or not asset:
            raise AppError(
                "local_media", "An available original recording is required.", 409
            )
        rule = con.execute(
            "SELECT * FROM pricing_rules WHERE active=1 AND provider='elevenlabs' AND model='scribe_v2' AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1",
            (now(),),
        ).fetchone()
        return {
            "lecture": dict(lecture),
            "original": dict(asset),
            "pricing_rule": dict(rule) if rule else None,
        }

    def estimate(self, data: JobInput):
        with self.db.read() as con:
            context = self.review_context(con, data.lecture_id)
        lecture, asset = context["lecture"], context["original"]
        spans = media.validate_edl(json.loads(lecture["edl"]), asset["duration_ms"])
        opts = data.settings.model_dump()
        duration = media.virtual_duration(spans)
        if opts["mode"] == "whole" and (
            duration > 10 * 3600000 or duration * 32 > 1900000000
        ):
            raise AppError(
                "validation",
                "Whole-file mode exceeds conservative provider limits. Use checkpointed chunks.",
            )
        silence = media.silence_points(self.db, data.lecture_id)
        plan = media.chunk_plan(spans, opts["target_ms"], silence, opts["mode"])
        rule = context["pricing_rule"]
        estimates = [
            pricing.estimate_chunk(end - start, opts, rule) for start, end in plan
        ]
        cost = sum(e["estimated_cost"] for e in estimates) if rule else None
        budget = json.loads(
            self.db.one("SELECT value FROM app_settings WHERE key='budget'")["value"]
        )
        usage = pricing.totals(self.db)
        spent = sum(
            r["estimated_cost"] or 0
            for r in usage
            if rule and r["currency"] == rule["currency"]
        )
        warnings = [
            "Transcription sends this audio to ElevenLabs. Actual charges are determined by your provider account."
        ]
        if rule is None:
            warnings.append(
                "Pricing is not configured. Cost and incremental payment are unknown; usage duration is known."
            )
        if any(r["unknown_estimates"] for r in usage):
            warnings.append("This month includes attempts with unknown cost estimates.")
        if any(r["charge_status"] == "unknown" for r in usage):
            warnings.append("Some previous requests have uncertain billing outcomes.")
        if rule and budget["monthly_micros"] is not None:
            if budget["currency"] != rule["currency"]:
                warnings.append(
                    "Budget currency differs from pricing currency; no conversion is assumed."
                )
            elif spent + cost > budget["monthly_micros"]:
                warnings.append(
                    "This estimate exceeds your remaining monthly advisory budget."
                )
        estimate = {
            "provider": "elevenlabs",
            "model": "scribe_v2",
            "duration_ms": duration,
            "requests": len(plan),
            "plan": [{"start_ms": s, "end_ms": e} for s, e in plan],
            "settings": opts,
            "source_spans": spans,
            "pricing_rule": rule,
            "estimated_cost": cost,
            "currency": rule["currency"] if rule else None,
            "estimated_billable_ms": sum(e["billable_ms"] for e in estimates),
            "feature_adjustment_basis_points": estimates[0]["feature_basis_points"],
            "actual_cost": None,
            "incremental_payment": None,
            "monthly_app_ledger": usage,
            "warnings": warnings,
        }
        estimate["review_context"] = context
        estimate["review_hash"] = hashlib.sha256(
            canonical(
                {
                    "context": context,
                    "settings": opts,
                    "plan": estimate["plan"],
                    "billable_ms": estimate["estimated_billable_ms"],
                    "estimated_cost": cost,
                }
            ).encode()
        ).hexdigest()
        return estimate

    def enqueue(self, data):
        if not data.confirmed:
            raise AppError(
                "validation",
                "Review the settings and explicitly confirm transcription before enqueueing.",
            )
        estimate = self.estimate(data)
        if data.review_hash is not None and data.review_hash != estimate["review_hash"]:
            raise AppError(
                "preflight_changed",
                "The recording, cuts, settings, or pricing changed. Review the fresh estimate before enqueueing.",
                409,
            )
        job_id = uid()
        with self.db.tx() as con:
            if self.review_context(con, data.lecture_id) != estimate["review_context"]:
                raise AppError(
                    "preflight_changed",
                    "The lecture changed while enqueueing. Refresh and review it again.",
                    409,
                )
            if con.execute(
                "SELECT id FROM transcription_jobs WHERE lecture_id=? AND state IN ('queued','running','unknown_outcome','failed_local','failed_provider','needs_retry_approval')",
                (data.lecture_id,),
            ).fetchone():
                raise AppError(
                    "validation",
                    "This lecture has unfinished transcription work. Retry its remaining chunks or cancel that job first.",
                    409,
                )
            if (
                not data.retranscribe_completed
                and con.execute(
                    "SELECT c.id FROM transcription_chunks c JOIN transcription_jobs j ON j.id=c.job_id WHERE j.lecture_id=? AND c.state='succeeded' LIMIT 1",
                    (data.lecture_id,),
                ).fetchone()
            ):
                raise AppError(
                    "validation",
                    "Completed audio requires explicit retranscription approval. A new job may charge for it again.",
                    409,
                )
            position = con.execute(
                "SELECT coalesce(max(position),0)+1 FROM transcription_jobs"
            ).fetchone()[0]
            rule = estimate["pricing_rule"]
            con.execute(
                "INSERT INTO transcription_jobs(id,lecture_id,state,position,settings,vocabulary,source_spans,pricing_rule_id,estimated_cost,currency,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    data.lecture_id,
                    "queued",
                    position,
                    canonical(estimate["settings"]),
                    canonical(data.settings.keyterms),
                    canonical(estimate["source_spans"]),
                    rule["id"] if rule else None,
                    estimate["estimated_cost"],
                    estimate["currency"],
                    estimate["duration_ms"],
                    now(),
                ),
            )
            for i, span in enumerate(estimate["plan"]):
                chunk_id = uid()
                con.execute(
                    "INSERT INTO transcription_chunks(id,job_id,ordinal,start_ms,end_ms) VALUES(?,?,?,?,?)",
                    (chunk_id, job_id, i, span["start_ms"], span["end_ms"]),
                )
                for j, source in enumerate(
                    media.intersect_spans(
                        estimate["source_spans"], span["start_ms"], span["end_ms"]
                    )
                ):
                    con.execute(
                        "INSERT INTO chunk_source_spans VALUES(?,?,?,?)",
                        (chunk_id, j, source["start_ms"], source["end_ms"]),
                    )
            con.execute(
                "UPDATE lectures SET status='queued' WHERE id=?", (data.lecture_id,)
            )
        return self.job(job_id)

    def job(self, job_id):
        job = self.db.one(
            "SELECT j.*,l.title FROM transcription_jobs j JOIN lectures l ON l.id=j.lecture_id WHERE j.id=?",
            (job_id,),
        )
        for field in ["settings", "vocabulary", "source_spans"]:
            job[field] = json.loads(job[field])
        job["chunks"] = self.db.all(
            "SELECT * FROM transcription_chunks WHERE job_id=? ORDER BY ordinal",
            (job_id,),
        )
        job["attempts"] = self.db.all(
            "SELECT a.*,u.estimated_cost,u.currency,u.charge_status,u.raw_response_sha256 FROM provider_attempts a JOIN usage_ledger u ON u.attempt_id=a.id WHERE a.job_id=? ORDER BY a.created_at",
            (job_id,),
        )
        job["transcript_id"] = (
            self.db.one(
                "SELECT id FROM transcripts WHERE job_id=?", (job_id,), required=False
            )
            or {}
        ).get("id")
        return job

    def list(self):
        paused = json.loads(
            self.db.one("SELECT value FROM app_settings WHERE key='queue_paused'")[
                "value"
            ]
        )
        return {
            "paused": paused,
            "jobs": [
                self.job(j["id"])
                for j in self.db.all(
                    "SELECT id FROM transcription_jobs ORDER BY position"
                )
            ],
        }

    def pause(self):
        with self.db.tx() as con:
            con.execute("UPDATE app_settings SET value='true' WHERE key='queue_paused'")

    def resume(self):
        with self.db.tx() as con:
            if con.execute(
                "SELECT id FROM transcription_jobs WHERE state='unknown_outcome'"
            ).fetchone():
                raise AppError(
                    "unknown_provider_outcome",
                    "Resolve or cancel uncertain jobs before resuming. Retrying can incur another charge.",
                    409,
                )
            con.execute(
                "UPDATE app_settings SET value='false' WHERE key='queue_paused'"
            )

    def reorder(self, ids):
        with self.db.tx() as con:
            waiting = [
                r[0]
                for r in con.execute(
                    "SELECT id FROM transcription_jobs WHERE state='queued' ORDER BY position"
                )
            ]
            if len(ids) != len(set(ids)) or set(ids) != set(waiting):
                raise AppError(
                    "validation",
                    "Provide every waiting job exactly once; running jobs cannot be moved.",
                    409,
                )
            positions = [
                r[0]
                for r in con.execute(
                    "SELECT position FROM transcription_jobs WHERE state='queued' ORDER BY position"
                )
            ]
            for job_id, pos in zip(ids, positions):
                con.execute(
                    "UPDATE transcription_jobs SET position=? WHERE id=?", (pos, job_id)
                )

    def retry(self, job_id, data):
        chunk = self.db.one(
            "SELECT * FROM transcription_chunks WHERE id=? AND job_id=?",
            (data.chunk_id, job_id),
        )
        if chunk["state"] not in (
            "unknown_outcome",
            "failed_local",
            "failed_provider",
            "needs_retry_approval",
        ):
            raise AppError(
                "validation", "Only failed or uncertain chunks can be retried.", 409
            )
        prior = self.db.one(
            "SELECT a.*,p.path AS artifact_path FROM provider_attempts a LEFT JOIN provider_artifacts p ON p.attempt_id=a.id WHERE a.chunk_id=? ORDER BY attempt_no DESC LIMIT 1",
            (data.chunk_id,),
            required=False,
        )
        if prior and not prior["artifact_path"]:
            path = safe_path(
                self.db.cfg.data / "artifacts/provider", f"{prior['id']}.json"
            )
            if path.exists():
                # Durable evidence wins over an incomplete DB transition, even on retry.
                from worker.engine import Worker

                Worker(self.db).register_response(prior, path)
                prior["artifact_path"] = str(path.relative_to(self.db.cfg.data))
        local = bool(prior and prior["artifact_path"])
        saved_job = self.db.one(
            "SELECT * FROM transcription_jobs WHERE id=?", (job_id,)
        )
        local_preparation = chunk["state"] == "failed_local" and (
            not prior
            or (
                prior["state"] in ("unknown_outcome", "failed_provider")
                and saved_job["retry_authorized_at"]
                and saved_job["retry_authorized_at"] > prior["request_started_at"]
            )
        )
        if (
            prior
            and not local
            and prior["state"] in ("response_persisted", "succeeded", "normalizing")
        ):
            raise AppError(
                "storage",
                "Recover the missing provider artifact; a local failure must not resubmit completed audio.",
                409,
            )
        if (
            not local
            and not local_preparation
            and chunk["state"]
            in ("unknown_outcome", "failed_provider", "needs_retry_approval")
            and not data.authorize_charge
        ):
            raise AppError(
                "unknown_provider_outcome",
                "Another provider request may incur another charge. Explicitly authorize it to continue.",
                409,
            )
        with self.db.tx() as con:
            con.execute(
                "UPDATE transcription_chunks SET state=?,error_category=NULL WHERE id=?",
                ("response_persisted" if local else "pending", data.chunk_id),
            )
            con.execute(
                "UPDATE transcription_jobs SET state='queued',error_category=NULL,retry_reason=?,retry_authorized_at=? WHERE id=?",
                (
                    saved_job["retry_reason"] if local_preparation else data.reason,
                    saved_job["retry_authorized_at"]
                    if local_preparation
                    else now()
                    if data.authorize_charge
                    else None,
                    job_id,
                ),
            )
        return {
            "retry_type": "local_normalization"
            if local
            else "local_preparation"
            if local_preparation
            else "new_provider_request",
            "job": self.job(job_id),
        }

    def cancel(self, job_id):
        with self.db.tx() as con:
            if con.execute(
                "SELECT id FROM provider_attempts WHERE job_id=? AND state IN ('request_started','response_received')",
                (job_id,),
            ).fetchone():
                raise AppError(
                    "validation",
                    "An in-flight provider request cannot be canceled. Pause applies after it finishes.",
                    409,
                )
            con.execute(
                "UPDATE transcription_jobs SET state='canceled' WHERE id=?", (job_id,)
            )
            con.execute(
                "UPDATE lectures SET status=CASE WHEN EXISTS(SELECT id FROM transcripts WHERE lecture_id=lectures.id) THEN 'partial' ELSE 'imported' END WHERE id=(SELECT lecture_id FROM transcription_jobs WHERE id=?)",
                (job_id,),
            )
