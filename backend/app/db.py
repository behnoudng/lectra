from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from alembic import command
from alembic.config import Config as AlembicConfig
from .config import Config
from .errors import AppError
from .storage import lock


def now():
    return datetime.now(timezone.utc).isoformat()


def verify_sqlite(version=None):
    v = tuple(int(x) for x in (version or sqlite3.sqlite_version).split("."))
    # 3.52.0 preceded the WAL-reset fix. Backported fixed release: 3.51.3.
    if not (
        v >= (3, 53, 0) or (3, 52, 1) <= v < (3, 53, 0) or (3, 51, 3) <= v < (3, 52, 0)
    ):
        raise AppError(
            "database",
            "Unsafe SQLite runtime "
            + ".".join(map(str, v))
            + ". Install SQLite 3.51.3, 3.52.1, or 3.53+ (WAL-reset fix).",
            503,
        )


def verify_local_filesystem(path: Path):
    mounts = []
    for line in Path("/proc/mounts").read_text().splitlines():
        parts = line.split()
        if len(parts) >= 3:
            mount = Path(parts[1].replace("\\040", " "))
            if path.resolve().is_relative_to(mount):
                mounts.append((len(str(mount)), parts[2]))
    if mounts and max(mounts)[1] in {
        "nfs",
        "nfs4",
        "cifs",
        "smbfs",
        "9p",
        "fuse.sshfs",
        "ceph",
        "glusterfs",
    }:
        raise AppError(
            "database", "SQLite WAL requires APP_DATA_DIR on a local filesystem.", 503
        )


def migrate_database(path):
    config = AlembicConfig(str(Path(__file__).parents[1] / "alembic.ini"))
    config.attributes["db_path"] = str(path)
    command.upgrade(config, "head")


class Database:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def connect(self):
        connection = sqlite3.connect(self.cfg.db_path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=15000")
        return connection

    @contextmanager
    def tx(self):
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @contextmanager
    def read(self):
        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()

    def all(self, sql, args=()):
        with self.read() as con:
            return [dict(row) for row in con.execute(sql, args)]

    def one(self, sql, args=(), required=True):
        rows = self.all(sql, args)
        if not rows and required:
            raise AppError("validation", "Record not found.", 404)
        return rows[0] if rows else None

    def initialize(self):
        verify_sqlite()
        self.cfg.prepare()
        verify_local_filesystem(self.cfg.data)
        from .backup import recover_restore

        with lock(
            self.cfg.data / "runtime.lock",
            exclusive=(self.cfg.data / "restore-journal.json").exists(),
        ):
            recover_restore(self.cfg)
            with lock(self.cfg.data / "bootstrap.lock"):
                migrate_database(self.cfg.db_path)
                with self.read() as con:
                    con.execute("PRAGMA journal_mode=WAL")
                    if (
                        con.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                        or con.execute("PRAGMA foreign_key_check").fetchone()
                    ):
                        raise AppError(
                            "database",
                            "Database integrity check failed. Restore a verified backup.",
                            503,
                        )
                    con.execute("SELECT count(*) FROM search_fts").fetchone()
