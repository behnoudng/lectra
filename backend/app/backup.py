"""Online SQLite snapshots, immutable content objects, verified staged restore."""

import json
import os
import shutil
import sqlite3
from uuid import UUID
from .db import now, migrate_database
from .errors import AppError
from .storage import (
    atomic_bytes,
    canonical,
    uid,
    sha256,
    sync_dir,
    safe_path,
    lock,
    sync_tree,
)


def recover_restore(cfg):
    journal = cfg.data / "restore-journal.json"
    if not journal.exists():
        (cfg.data / "maintenance").unlink(missing_ok=True)
        return
    info = json.loads(journal.read_text())
    staging = safe_path(cfg.data, info["staging"])
    rollback = safe_path(cfg.data, info["rollback"])
    for name in reversed(info["directories"]):
        current = cfg.data / name
        old = rollback / name
        if old.exists():
            if current.exists():
                shutil.rmtree(current)
            os.replace(old, current)
        elif (
            name not in info["old_present"]
            and not (staging / name).exists()
            and current.exists()
        ):
            shutil.rmtree(current)
    shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(rollback, ignore_errors=True)
    journal.unlink()
    (cfg.data / "maintenance").unlink(missing_ok=True)
    sync_dir(cfg.data)


class BackupService:
    def __init__(self, db):
        self.db = db
        self.cfg = db.cfg

    def list(self):
        result = []
        for path in sorted((self.cfg.backups / "snapshots").iterdir(), reverse=True):
            if path.is_dir() and (path / "snapshot.json").exists():
                try:
                    info = json.loads((path / "snapshot.json").read_text())
                    result.append(
                        {
                            k: info[k]
                            for k in ["id", "created_at", "include_audio", "size"]
                        }
                    )
                    result[-1]["status"] = (
                        "verified" if (path / "verified").exists() else "unverified"
                    )
                except (ValueError, KeyError, OSError):
                    result.append({"id": path.name, "status": "invalid", "size": 0})
        return result

    def _object(self, path):
        digest = sha256(path)
        target = self.cfg.backups / "objects" / digest
        if not target.exists():
            tmp = target.with_name(digest + "." + uid() + ".tmp")
            shutil.copyfile(path, tmp)
            with tmp.open("rb") as f:
                os.fsync(f.fileno())
            os.replace(tmp, target)
            target.chmod(0o444)
            sync_dir(target.parent)
        elif sha256(target) != digest:
            raise AppError("backup", "A backup content object has been corrupted.", 409)
        return target, digest

    def create(self, include_audio=False):
        with lock(self.cfg.backups / "backup.lock"):
            backup_id = uid()
            stage = self.cfg.backups / "snapshots" / ("." + backup_id + ".tmp")
            stage.mkdir()
            try:
                snapshot_db = stage / "app.sqlite3"
                with self.db.read() as live:
                    destination = sqlite3.connect(snapshot_db)
                    try:
                        live.backup(destination)
                    finally:
                        destination.close()
                con = sqlite3.connect(snapshot_db)
                con.row_factory = sqlite3.Row
                try:
                    if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise AppError(
                            "backup", "Snapshot database is not consistent.", 409
                        )
                    artifacts = [
                        dict(r) for r in con.execute("SELECT * FROM provider_artifacts")
                    ]
                    assets = [
                        dict(r)
                        for r in con.execute(
                            "SELECT * FROM media_assets WHERE deleted_at IS NULL"
                        )
                    ]
                finally:
                    con.close()
                files = []
                omitted = []
                for asset in artifacts + assets:
                    relative = asset["path"]
                    if asset.get("kind") == "original" and not include_audio:
                        omitted.append(
                            {
                                "path": relative,
                                "sha256": asset["sha256"],
                                "id": asset["id"],
                            }
                        )
                        continue
                    src = safe_path(self.cfg.data, relative)
                    if not src.exists() or sha256(src) != asset["sha256"]:
                        raise AppError(
                            "backup",
                            "A referenced immutable asset is missing or changed. Repair it before backing up.",
                            409,
                        )
                    obj, digest = self._object(src)
                    dest = safe_path(stage, relative)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    os.link(obj, dest)
                    files.append(
                        {"path": relative, "sha256": digest, "size": src.stat().st_size}
                    )
                files.append(
                    {
                        "path": "app.sqlite3",
                        "sha256": sha256(snapshot_db),
                        "size": snapshot_db.stat().st_size,
                    }
                )
                info = {
                    "schema_version": 1,
                    "id": backup_id,
                    "created_at": now(),
                    "include_audio": include_audio,
                    "size": sum(f["size"] for f in files),
                    "files": files,
                    "omitted_originals": omitted,
                }
                atomic_bytes(stage / "snapshot.json", canonical(info).encode())
                checks = "".join(f"{f['sha256']}  {f['path']}\n" for f in files)
                atomic_bytes(stage / "checksums.sha256", checks.encode())
                final = self.cfg.backups / "snapshots" / backup_id
                sync_tree(stage)
                os.replace(stage, final)
                sync_dir(final.parent)
                self.verify(backup_id)
                with self.db.tx() as live:
                    live.execute(
                        "INSERT INTO backup_snapshots VALUES(?,?,?,?,?)",
                        (
                            backup_id,
                            info["created_at"],
                            "verified",
                            info["size"],
                            int(include_audio),
                        ),
                    )
                return {
                    k: info[k] for k in ["id", "created_at", "include_audio", "size"]
                } | {"status": "verified"}
            except BaseException:
                shutil.rmtree(stage, ignore_errors=True)
                raise

    def verify(self, backup_id):
        root = safe_path(self.cfg.backups / "snapshots", backup_id)
        try:
            if root.name != backup_id:
                raise ValueError()
            info = json.loads((root / "snapshot.json").read_text())
            if info["schema_version"] != 1 or info["id"] != backup_id:
                raise ValueError()
            listed = {f["path"]: f for f in info["files"]}
            if len(listed) != len(info["files"]) or "app.sqlite3" not in listed:
                raise ValueError()
            if any(
                not (
                    p == "app.sqlite3"
                    or p.startswith("artifacts/provider/")
                    or p.startswith("media/")
                )
                for p in listed
            ):
                raise ValueError()
            expected = "".join(f"{f['sha256']}  {f['path']}\n" for f in info["files"])
            if (root / "checksums.sha256").read_text() != expected:
                raise ValueError()
            for f in info["files"]:
                path = safe_path(root, f["path"])
                if (
                    path.is_symlink()
                    or not path.is_file()
                    or sha256(path) != f["sha256"]
                    or path.stat().st_size != f["size"]
                ):
                    raise ValueError()
            con = sqlite3.connect(f"file:{root}/app.sqlite3?mode=ro", uri=True)
            try:
                if (
                    con.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                    or con.execute("PRAGMA foreign_key_check").fetchone()
                ):
                    raise ValueError()
                for table in [
                    "lectures",
                    "media_assets",
                    "transcription_chunks",
                    "provider_attempts",
                ]:
                    for (internal_id,) in con.execute("SELECT id FROM " + table):
                        if str(UUID(internal_id)) != internal_id:
                            raise ValueError("Invalid internal filesystem identifier.")
                omitted = {o["path"]: o["sha256"] for o in info["omitted_originals"]}
                for path, digest in con.execute(
                    "SELECT path,sha256 FROM provider_artifacts"
                ):
                    if path not in listed or listed[path]["sha256"] != digest:
                        raise ValueError()
                for path, digest, kind in con.execute(
                    "SELECT path,sha256,kind FROM media_assets WHERE deleted_at IS NULL"
                ):
                    if path in listed:
                        if listed[path]["sha256"] != digest:
                            raise ValueError()
                    elif kind != "original" or omitted.get(path) != digest:
                        raise ValueError()
                con.execute("SELECT count(*) FROM search_fts").fetchone()
            finally:
                con.close()
            atomic_bytes(root / "verified", now().encode())
            return {"id": backup_id, "status": "verified"}
        except (ValueError, KeyError, OSError, sqlite3.Error, AppError):
            (root / "verified").unlink(missing_ok=True)
            raise AppError(
                "backup",
                "Snapshot verification failed. Restore refused; check the manifest, checksums, and referenced assets.",
                409,
            )

    def _merge_evidence(self, stage):
        """Content may roll back; financial history and completed chunks never do."""
        with self.db.read() as live:
            tables = {
                name: [dict(row) for row in live.execute("SELECT * FROM " + name)]
                for name in [
                    "courses",
                    "lectures",
                    "media_assets",
                    "transcription_jobs",
                    "transcription_chunks",
                    "chunk_source_spans",
                    "provider_attempts",
                    "provider_artifacts",
                    "usage_ledger",
                    "transcripts",
                    "transcript_words",
                    "transcript_blocks",
                    "transcript_revisions",
                    "speaker_labels",
                    "pricing_rules",
                ]
            }
        # Older snapshots must gain new columns before newer evidence is merged.
        migrate_database(stage / "db/app.sqlite3")
        con = sqlite3.connect(stage / "db/app.sqlite3")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        job_lectures = {j["lecture_id"] for j in tables["transcription_jobs"]}
        newly_complete = set()
        try:

            def insert(table, row):
                names = list(row)
                con.execute(
                    "INSERT OR IGNORE INTO "
                    + table
                    + "("
                    + ",".join(names)
                    + ") VALUES("
                    + ",".join("?" for _ in names)
                    + ")",
                    tuple(row[n] for n in names),
                )

            for row in tables["courses"]:
                insert("courses", row)
            for row in tables["lectures"]:
                if row["id"] in job_lectures:
                    insert("lectures", row)
            for row in tables["pricing_rules"]:
                insert("pricing_rules", row)
            for row in tables["media_assets"]:
                if row["lecture_id"] not in job_lectures:
                    continue
                insert("media_assets", row)
                asset = con.execute(
                    "SELECT * FROM media_assets WHERE id=?", (row["id"],)
                ).fetchone()
                if asset["deleted_at"] is not None:
                    continue
                destination = safe_path(stage, asset["path"])
                if destination.exists():
                    continue
                source = safe_path(self.cfg.data, asset["path"])
                if source.exists() and sha256(source) == asset["sha256"]:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
                elif asset["kind"] == "original":
                    con.execute(
                        "UPDATE media_assets SET deleted_at=? WHERE id=?",
                        (now(), asset["id"]),
                    )
                else:
                    raise AppError(
                        "restore",
                        "Cannot preserve newer media evidence. Repair missing assets before restoring.",
                        409,
                    )
            for row in tables["transcription_jobs"]:
                insert("transcription_jobs", row)
                con.execute(
                    "UPDATE transcription_jobs SET state=?,error_category=?,retry_reason=?,retry_authorized_at=? WHERE id=?",
                    (
                        row["state"],
                        row["error_category"],
                        row["retry_reason"],
                        row["retry_authorized_at"],
                        row["id"],
                    ),
                )
            for row in tables["transcription_chunks"]:
                prior = con.execute(
                    "SELECT state FROM transcription_chunks WHERE id=?", (row["id"],)
                ).fetchone()
                if row["state"] == "succeeded" and (
                    not prior or prior[0] != "succeeded"
                ):
                    newly_complete.add(row["id"])
                insert("transcription_chunks", row)
                con.execute(
                    "UPDATE transcription_chunks SET state=?,error_category=?,prepared_path=?,prepared_sha256=? WHERE id=?",
                    (
                        row["state"],
                        row["error_category"],
                        row["prepared_path"],
                        row["prepared_sha256"],
                        row["id"],
                    ),
                )
            for name in [
                "chunk_source_spans",
                "provider_attempts",
                "provider_artifacts",
                "usage_ledger",
            ]:
                for row in tables[name]:
                    insert(name, row)
                    if name in ("provider_attempts", "usage_ledger"):
                        keys = [k for k in row if k not in ("id", "attempt_id")]
                        identity = "id" if name == "provider_attempts" else "attempt_id"
                        con.execute(
                            "UPDATE "
                            + name
                            + " SET "
                            + ",".join(k + "=?" for k in keys)
                            + " WHERE "
                            + identity
                            + "=?",
                            tuple(row[k] for k in keys) + (row[identity],),
                        )
                    elif name == "provider_artifacts":
                        destination = safe_path(stage, row["path"])
                        if not destination.exists():
                            source = safe_path(self.cfg.data, row["path"])
                            if not source.exists() or sha256(source) != row["sha256"]:
                                raise AppError(
                                    "restore",
                                    "Cannot discard newer provider evidence. Repair or recover the missing artifact first.",
                                    409,
                                )
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(source, destination)
            existing = {
                r["id"]: r["revision"]
                for r in con.execute("SELECT id,revision FROM transcripts")
            }
            for name in [
                "transcripts",
                "transcript_words",
                "transcript_revisions",
                "speaker_labels",
            ]:
                for row in tables[name]:
                    insert(name, row)
            for row in tables["transcript_blocks"]:
                if (
                    row["transcript_id"] not in existing
                    or row["chunk_id"] in newly_complete
                ):
                    insert("transcript_blocks", row)
            from .transcripts import snapshot, index_lecture

            for row in tables["transcripts"]:
                if row["id"] in existing:
                    maximum = (
                        con.execute(
                            "SELECT max(revision) FROM transcript_revisions WHERE transcript_id=?",
                            (row["id"],),
                        ).fetchone()[0]
                        or 0
                    )
                    revision = max(maximum, row["revision"], existing[row["id"]]) + 1
                    con.execute(
                        "UPDATE transcripts SET revision=?,updated_at=? WHERE id=?",
                        (revision, now(), row["id"]),
                    )
                    snapshot(
                        con,
                        row["id"],
                        revision,
                        "backup restore (financial evidence retained)",
                    )
            # A restored waiting chunk requires explicit authorization, even on a fresh machine
            # where evidence of requests made after the selected snapshot is unavailable.
            con.execute(
                "UPDATE transcription_chunks SET state='needs_retry_approval',prepared_path=NULL WHERE state IN ('pending','preparing','prepared')"
            )
            con.execute(
                "UPDATE transcription_jobs SET state='needs_retry_approval' WHERE state IN ('queued','running') AND EXISTS(SELECT 1 FROM transcription_chunks c WHERE c.job_id=transcription_jobs.id AND c.state='needs_retry_approval')"
            )
            for row in con.execute("SELECT id FROM lectures").fetchall():
                index_lecture(con, row["id"])
            con.commit()
        finally:
            con.close()

    def restore(self, backup_id):
        # Nonblocking lock refuses restore while a live worker holds a financial operation.
        with self.db.tx() as con:
            con.execute("UPDATE app_settings SET value='true' WHERE key='queue_paused'")
        with lock(self.cfg.data / "runtime.lock", blocking=False):
            active = self.db.one(
                "SELECT id FROM provider_attempts WHERE state IN ('request_started','response_received') LIMIT 1",
                required=False,
            )
            if active:
                raise AppError(
                    "restore",
                    "An in-flight provider request must finish or be reconciled before restoration.",
                    409,
                )
            self.verify(backup_id)
            # A response can be durable on disk while its registration failed and
            # the attempt was classified as unknown. Register/import it before
            # collecting evidence, so the directory swap cannot discard it.
            from worker.engine import Worker

            Worker(self.db).reconcile()
            pre_restore_error = None
            try:
                self.create(True)
            except AppError as error:
                pre_restore_error = error.message
            root = safe_path(self.cfg.backups / "snapshots", backup_id)
            info = json.loads((root / "snapshot.json").read_text())
            stage = self.cfg.data / ("restore-stage-" + uid())
            rollback = self.cfg.data / ("restore-rollback-" + uid())
            directories = ["db", "media", "artifacts", "waveform"]
            for name in directories:
                (stage / name).mkdir(parents=True)
            missing = []
            try:
                for f in info["files"]:
                    dst = (
                        stage / "db/app.sqlite3"
                        if f["path"] == "app.sqlite3"
                        else safe_path(stage, f["path"])
                    )
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(safe_path(root, f["path"]), dst)
                for o in info["omitted_originals"]:
                    live = safe_path(self.cfg.data, o["path"])
                    if live.exists() and sha256(live) == o["sha256"]:
                        dst = safe_path(stage, o["path"])
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(live, dst)
                    else:
                        missing.append(o["id"])
                self._merge_evidence(stage)
                con = sqlite3.connect(stage / "db/app.sqlite3")
                try:
                    con.execute("PRAGMA journal_mode=DELETE")
                    con.execute(
                        "UPDATE app_settings SET value='true' WHERE key='queue_paused'"
                    )
                    for media_id in missing:
                        con.execute(
                            "UPDATE media_assets SET deleted_at=? WHERE id=?",
                            (now(), media_id),
                        )
                    con.execute(
                        "UPDATE transcription_jobs SET state='failed_local',error_category='original_unavailable' WHERE state IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.lecture_id=transcription_jobs.lecture_id AND m.kind='original' AND m.deleted_at IS NULL)"
                    )
                    con.commit()
                    if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise AppError(
                            "restore", "Staged database failed integrity check.", 409
                        )
                finally:
                    con.close()
                with sqlite3.connect(stage / "db/app.sqlite3") as staged:
                    for (relative,) in staged.execute(
                        "SELECT path FROM provider_artifacts UNION SELECT path FROM media_assets WHERE kind='original' AND deleted_at IS NULL"
                    ):
                        path = safe_path(stage, relative)
                        if path.exists():
                            path.chmod(0o444)
                sync_tree(stage)
                atomic_bytes(self.cfg.data / "maintenance", b"restore")
                rollback.mkdir()
                journal = {
                    "staging": stage.name,
                    "rollback": rollback.name,
                    "directories": directories,
                    "old_present": [
                        n for n in directories if (self.cfg.data / n).exists()
                    ],
                }
                atomic_bytes(
                    self.cfg.data / "restore-journal.json", canonical(journal).encode()
                )
                for name in directories:
                    final = self.cfg.data / name
                    if final.exists():
                        os.replace(final, rollback / name)
                        sync_dir(rollback)
                        sync_dir(self.cfg.data)
                    os.replace(stage / name, final)
                    sync_dir(stage)
                    sync_dir(self.cfg.data)
                # Removing the journal is the restore commit point. A crash earlier rolls back.
                (self.cfg.data / "restore-journal.json").unlink()
                sync_dir(self.cfg.data)
                (self.cfg.data / "maintenance").unlink(missing_ok=True)
                shutil.rmtree(stage, ignore_errors=True)
                shutil.rmtree(rollback, ignore_errors=True)
                with self.db.read() as con:
                    con.execute("PRAGMA journal_mode=WAL")
                # The worker will also reconcile on its next safe start; no request is made here.
                Worker(self.db).reconcile()
                return {
                    "status": "restored",
                    "missing_originals": len(missing),
                    "queue_paused": True,
                    "pre_restore_warning": pre_restore_error,
                }
            except BaseException:
                recover_restore(self.cfg)
                shutil.rmtree(stage, ignore_errors=True)
                raise
