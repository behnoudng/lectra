import json
from .db import now
from .errors import AppError
from .storage import canonical, uid, safe_path
from . import media, transcripts
from .contracts import TranscriptionSettings


class Library:
    def __init__(self, db):
        self.db = db

    def courses(self):
        return [
            self.course(c["id"])
            for c in self.db.all("SELECT id FROM courses ORDER BY name")
        ]

    def course(self, course_id):
        c = self.db.one("SELECT * FROM courses WHERE id=?", (course_id,))
        c["preset"] = json.loads(c["preset"])
        c["vocabulary"] = [
            r["term"]
            for r in self.db.all(
                "SELECT term FROM course_vocabulary WHERE course_id=? ORDER BY ordinal",
                (course_id,),
            )
        ]
        return c

    def create_course(self, data):
        course_id = uid()
        with self.db.tx() as con:
            con.execute(
                "INSERT INTO courses VALUES(?,?,?,?)",
                (course_id, data.name, canonical(data.preset.model_dump()), now()),
            )
        return self.course(course_id)

    def update_course(self, course_id, data):
        self.course(course_id)
        with self.db.tx() as con:
            con.execute(
                "UPDATE courses SET name=?,preset=? WHERE id=?",
                (data.name, canonical(data.preset.model_dump()), course_id),
            )
            for row in con.execute(
                "SELECT id FROM lectures WHERE course_id=?", (course_id,)
            ).fetchall():
                transcripts.index_lecture(con, row["id"])
        return self.course(course_id)

    def vocabulary(self, course_id, terms):
        self.course(course_id)
        TranscriptionSettings(keyterms=terms)
        with self.db.tx() as con:
            con.execute("DELETE FROM course_vocabulary WHERE course_id=?", (course_id,))
            con.executemany(
                "INSERT INTO course_vocabulary VALUES(?,?,?)",
                [(course_id, i, term) for i, term in enumerate(terms)],
            )
        return self.course(course_id)

    def lecture(self, lecture_id):
        lecture = self.db.one(
            "SELECT l.*,c.name AS course FROM lectures l LEFT JOIN courses c ON c.id=l.course_id WHERE l.id=?",
            (lecture_id,),
        )
        lecture["edl"] = json.loads(lecture["edl"])
        lecture["preprocessing"] = json.loads(lecture["preprocessing"])
        lecture["tags"] = [
            r["name"]
            for r in self.db.all(
                "SELECT t.name FROM tags t JOIN lecture_tags lt ON t.id=lt.tag_id WHERE lt.lecture_id=?",
                (lecture_id,),
            )
        ]
        lecture["media"] = self.db.all(
            "SELECT * FROM media_assets WHERE lecture_id=? AND deleted_at IS NULL ORDER BY created_at",
            (lecture_id,),
        )
        lecture["duration_ms"] = media.virtual_duration(lecture["edl"])
        lecture["transcript_id"] = (
            self.db.one(
                "SELECT id FROM transcripts WHERE lecture_id=? ORDER BY created_at DESC LIMIT 1",
                (lecture_id,),
                required=False,
            )
            or {}
        ).get("id")
        return lecture

    def lectures(self):
        return [
            self.lecture(lecture["id"])
            for lecture in self.db.all(
                "SELECT id FROM lectures ORDER BY created_at DESC"
            )
        ]

    def _tags(self, con, lecture_id, tags):
        con.execute("DELETE FROM lecture_tags WHERE lecture_id=?", (lecture_id,))
        for name in dict.fromkeys(t.strip() for t in tags if t.strip()):
            if len(name) > 80:
                raise AppError(
                    "validation", "Tag names may contain at most 80 characters."
                )
            existing = con.execute(
                "SELECT id FROM tags WHERE name=?", (name,)
            ).fetchone()
            tag_id = existing["id"] if existing else uid()
            if not existing:
                con.execute("INSERT INTO tags VALUES(?,?)", (tag_id, name))
            con.execute("INSERT INTO lecture_tags VALUES(?,?)", (lecture_id, tag_id))

    def create_lecture(self, data):
        preprocessing = {}
        if data.course_id:
            preprocessing = self.course(data.course_id)["preset"].get(
                "preprocessing", {}
            )
        lecture_id = uid()
        with self.db.tx() as con:
            con.execute(
                "INSERT INTO lectures(id,course_id,title,date,preprocessing,created_at) VALUES(?,?,?,?,?,?)",
                (
                    lecture_id,
                    data.course_id,
                    data.title,
                    data.date,
                    canonical(preprocessing),
                    now(),
                ),
            )
            self._tags(con, lecture_id, data.tags)
            transcripts.index_lecture(con, lecture_id)
        return self.lecture(lecture_id)

    def update_lecture(self, lecture_id, data):
        self.lecture(lecture_id)
        if data.course_id:
            self.course(data.course_id)
        with self.db.tx() as con:
            con.execute(
                "UPDATE lectures SET title=?,course_id=?,date=? WHERE id=?",
                (data.title, data.course_id, data.date, lecture_id),
            )
            self._tags(con, lecture_id, data.tags)
            transcripts.index_lecture(con, lecture_id)
        return self.lecture(lecture_id)

    def save_edl(self, lecture_id, spans):
        source = media.original(self.db, lecture_id)
        media.validate_edl(spans, source["duration_ms"])
        with self.db.tx() as con:
            con.execute(
                "UPDATE lectures SET edl=? WHERE id=?", (canonical(spans), lecture_id)
            )
        return self.lecture(lecture_id)

    def delete_original(self, lecture_id):
        with self.db.tx() as con:
            if con.execute(
                "SELECT id FROM transcription_jobs WHERE lecture_id=? AND state IN ('queued','running','unknown_outcome','failed_local','failed_provider','needs_retry_approval')",
                (lecture_id,),
            ).fetchone():
                raise AppError(
                    "validation",
                    "Original audio is required by unfinished work. Cancel or complete that work first.",
                    409,
                )
            asset = con.execute(
                "SELECT * FROM media_assets WHERE lecture_id=? AND kind='original' AND deleted_at IS NULL",
                (lecture_id,),
            ).fetchone()
            if not asset:
                raise AppError("validation", "Original audio not found.", 404)
            if not con.execute(
                "SELECT id FROM media_assets WHERE lecture_id=? AND kind='proxy' AND deleted_at IS NULL",
                (lecture_id,),
            ).fetchone():
                raise AppError(
                    "local_media",
                    "Generate a playback proxy before deleting the original.",
                    409,
                )
            path = safe_path(self.db.cfg.data, asset["path"])
            # Tombstone precedes unlink; restart can finish an interrupted explicit deletion.
            con.execute(
                "UPDATE media_assets SET deleted_at=? WHERE id=?", (now(), asset["id"])
            )
        path.unlink(missing_ok=True)
        return {
            "deleted": True,
            "message": "Transcript and playback proxies remain. Older backups may still contain the original.",
        }
