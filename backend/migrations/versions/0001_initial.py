"""Version one durable schema."""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = """
CREATE TABLE courses(id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE course_vocabulary(course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, term TEXT NOT NULL, PRIMARY KEY(course_id,ordinal));
CREATE TABLE tags(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE lectures(id TEXT PRIMARY KEY, course_id TEXT REFERENCES courses(id) ON DELETE SET NULL, title TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'imported', edl TEXT NOT NULL DEFAULT '[]', preprocessing TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE lecture_tags(lecture_id TEXT NOT NULL REFERENCES lectures(id), tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY(lecture_id,tag_id));
CREATE TABLE media_assets(id TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id), kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, duration_ms INTEGER NOT NULL, codec TEXT NOT NULL, channels INTEGER NOT NULL, sample_rate INTEGER NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, ephemeral INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE pricing_rules(id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, effective_from TEXT NOT NULL, currency TEXT NOT NULL, base_micros_per_hour INTEGER NOT NULL CHECK(base_micros_per_hour>=0), feature_rules TEXT NOT NULL, source_note TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id), state TEXT NOT NULL, position INTEGER NOT NULL, settings TEXT NOT NULL, vocabulary TEXT NOT NULL, source_spans TEXT NOT NULL, pricing_rule_id TEXT REFERENCES pricing_rules(id), estimated_cost INTEGER, currency TEXT, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL, error_category TEXT, retry_reason TEXT, retry_authorized_at TEXT);
CREATE TABLE transcription_chunks(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES transcription_jobs(id), ordinal INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', prepared_path TEXT, prepared_sha256 TEXT, error_category TEXT, UNIQUE(job_id,ordinal));
CREATE TABLE chunk_source_spans(chunk_id TEXT NOT NULL REFERENCES transcription_chunks(id), ordinal INTEGER NOT NULL, source_start_ms INTEGER NOT NULL, source_end_ms INTEGER NOT NULL, PRIMARY KEY(chunk_id,ordinal));
CREATE TABLE provider_attempts(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES transcription_jobs(id), chunk_id TEXT NOT NULL REFERENCES transcription_chunks(id), attempt_no INTEGER NOT NULL, state TEXT NOT NULL, request_hash TEXT NOT NULL, audio_sha256 TEXT NOT NULL, retry_of_attempt_id TEXT REFERENCES provider_attempts(id), retry_reason TEXT, retry_authorized_at TEXT, request_started_at TEXT NOT NULL, response_received_at TEXT, response_persisted_at TEXT, http_status INTEGER, provider_transcript_id TEXT, created_at TEXT NOT NULL, UNIQUE(chunk_id,attempt_no));
CREATE TABLE provider_artifacts(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES provider_attempts(id), path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE usage_ledger(attempt_id TEXT PRIMARY KEY REFERENCES provider_attempts(id), job_id TEXT NOT NULL REFERENCES transcription_jobs(id), chunk_id TEXT NOT NULL REFERENCES transcription_chunks(id), provider TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL, request_hash TEXT NOT NULL, audio_duration_ms INTEGER NOT NULL, estimated_billable_ms INTEGER NOT NULL, keyterm_count INTEGER NOT NULL, features_json TEXT NOT NULL, pricing_rule_id TEXT REFERENCES pricing_rules(id), estimated_cost INTEGER, currency TEXT, actual_cost INTEGER, actual_cost_source TEXT, charge_status TEXT NOT NULL, attempt_no INTEGER NOT NULL, retry_of_attempt_id TEXT, retry_reason TEXT, retry_authorized_at TEXT, request_started_at TEXT NOT NULL, response_received_at TEXT, response_persisted_at TEXT, http_status INTEGER, outcome TEXT NOT NULL, provider_transcript_id TEXT, raw_response_sha256 TEXT, created_at TEXT NOT NULL);
CREATE TABLE transcripts(id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES transcription_jobs(id), lecture_id TEXT NOT NULL REFERENCES lectures(id), revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE transcript_words(id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL REFERENCES transcripts(id), chunk_id TEXT NOT NULL REFERENCES transcription_chunks(id), ordinal INTEGER NOT NULL, start_ms INTEGER, end_ms INTEGER, text TEXT NOT NULL, token_type TEXT NOT NULL, provider_speaker_id TEXT, logprob REAL, UNIQUE(chunk_id,ordinal));
CREATE TABLE transcript_blocks(id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL REFERENCES transcripts(id), chunk_id TEXT REFERENCES transcription_chunks(id), ordinal INTEGER NOT NULL, start_ms INTEGER, end_ms INTEGER, text TEXT NOT NULL, marks_json TEXT NOT NULL DEFAULT '{}', speaker_key TEXT, direction_override TEXT, alignment_status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE speaker_labels(transcript_id TEXT NOT NULL REFERENCES transcripts(id), speaker_key TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(transcript_id,speaker_key));
CREATE TABLE transcript_revisions(transcript_id TEXT NOT NULL REFERENCES transcripts(id), revision INTEGER NOT NULL, reason TEXT NOT NULL, blocks TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(transcript_id,revision));
CREATE TABLE backup_snapshots(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, size INTEGER NOT NULL, include_audio INTEGER NOT NULL);
CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE search_fts USING fts5(lecture_id UNINDEXED, block_id UNINDEXED, start_ms UNINDEXED, shadow, tokenize='unicode61');
CREATE UNIQUE INDEX one_original ON media_assets(lecture_id) WHERE kind='original';
CREATE INDEX queue_order ON transcription_jobs(state,position);
CREATE INDEX block_order ON transcript_blocks(transcript_id,ordinal);
CREATE TRIGGER immutable_words_update BEFORE UPDATE ON transcript_words BEGIN SELECT RAISE(ABORT,'Provider words are immutable'); END;
CREATE TRIGGER immutable_words_delete BEFORE DELETE ON transcript_words BEGIN SELECT RAISE(ABORT,'Provider words are immutable'); END;
CREATE TRIGGER immutable_artifacts_update BEFORE UPDATE ON provider_artifacts BEGIN SELECT RAISE(ABORT,'Provider artifacts are immutable'); END;
CREATE TRIGGER immutable_artifacts_delete BEFORE DELETE ON provider_artifacts BEGIN SELECT RAISE(ABORT,'Provider artifacts are immutable'); END;
CREATE TRIGGER immutable_job_snapshot BEFORE UPDATE OF settings,vocabulary,source_spans,pricing_rule_id,duration_ms ON transcription_jobs BEGIN SELECT RAISE(ABORT,'Job snapshots are immutable'); END;
CREATE TRIGGER immutable_revisions_update BEFORE UPDATE ON transcript_revisions BEGIN SELECT RAISE(ABORT,'Revisions are immutable'); END;
CREATE TRIGGER immutable_revisions_delete BEFORE DELETE ON transcript_revisions BEGIN SELECT RAISE(ABORT,'Revisions are immutable'); END;
INSERT INTO app_settings VALUES('queue_paused','false');
INSERT INTO app_settings VALUES('budget','{"monthly_micros":null,"currency":"USD"}');
INSERT INTO app_settings VALUES('preferences','{"backup_interval_hours":24,"include_audio":false,"skip_seconds":5,"rewind_on_resume":false}');
"""


def upgrade():
    for statement in SCHEMA.strip().split("\n"):
        op.get_bind().exec_driver_sql(statement)


def downgrade():
    raise RuntimeError(
        "Downgrade would destroy audit evidence. Restore a backup instead."
    )
