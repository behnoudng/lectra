import json
import unicodedata
from .db import now
from .errors import AppError
from .storage import canonical, uid


def shadow(text):
    normalized = (
        unicodedata.normalize("NFKC", text)
        .replace("ي", "ی")
        .replace("ى", "ی")
        .replace("ك", "ک")
    )
    return normalized.replace("\u200c", " ").casefold()


def index_lecture(con, lecture_id):
    con.execute("DELETE FROM search_fts WHERE lecture_id=?", (lecture_id,))
    lecture = con.execute(
        "SELECT l.title,c.name FROM lectures l LEFT JOIN courses c ON c.id=l.course_id WHERE l.id=?",
        (lecture_id,),
    ).fetchone()
    tags = " ".join(
        r[0]
        for r in con.execute(
            "SELECT t.name FROM tags t JOIN lecture_tags lt ON lt.tag_id=t.id WHERE lt.lecture_id=?",
            (lecture_id,),
        )
    )
    prefix = " ".join([lecture["title"], lecture["name"] or "", tags])
    blocks = con.execute(
        "SELECT b.* FROM transcript_blocks b JOIN transcripts t ON t.id=b.transcript_id WHERE t.lecture_id=? AND t.id=(SELECT id FROM transcripts WHERE lecture_id=? ORDER BY created_at DESC,id DESC LIMIT 1) ORDER BY b.ordinal",
        (lecture_id, lecture_id),
    ).fetchall()
    if not blocks:
        con.execute(
            "INSERT INTO search_fts VALUES(?,?,?,?)",
            (lecture_id, None, None, shadow(prefix)),
        )
    for b in blocks:
        con.execute(
            "INSERT INTO search_fts VALUES(?,?,?,?)",
            (lecture_id, b["id"], b["start_ms"], shadow(prefix + " " + b["text"])),
        )


def get_transcript(db, transcript_id):
    t = db.one("SELECT * FROM transcripts WHERE id=?", (transcript_id,))
    t["blocks"] = []
    for block in db.all(
        "SELECT * FROM transcript_blocks WHERE transcript_id=? ORDER BY ordinal",
        (transcript_id,),
    ):
        block["marks_json"] = json.loads(block["marks_json"])
        t["blocks"].append(block)
    t["speakers"] = {
        s["speaker_key"]: s["label"]
        for s in db.all(
            "SELECT * FROM speaker_labels WHERE transcript_id=?", (transcript_id,)
        )
    }
    return t


def snapshot(con, transcript_id, revision, reason):
    blocks = [
        dict(b)
        for b in con.execute(
            "SELECT * FROM transcript_blocks WHERE transcript_id=? ORDER BY ordinal",
            (transcript_id,),
        )
    ]
    con.execute(
        "INSERT INTO transcript_revisions VALUES(?,?,?,?,?)",
        (transcript_id, revision, reason, canonical(blocks), now()),
    )


def import_chunk(db, chunk, neutral):
    job = db.one("SELECT * FROM transcription_jobs WHERE id=?", (chunk["job_id"],))
    with db.tx() as con:
        t = con.execute(
            "SELECT * FROM transcripts WHERE job_id=?", (job["id"],)
        ).fetchone()
        if not t:
            transcript_id = uid()
            con.execute(
                "INSERT INTO transcripts VALUES(?,?,?,?,?,?)",
                (transcript_id, job["id"], job["lecture_id"], 1, now(), now()),
            )
        else:
            transcript_id = t["id"]
        # Atomic token/block/chunk commit prevents partial import and protects edited blocks.
        if (
            con.execute(
                "SELECT state FROM transcription_chunks WHERE id=?", (chunk["id"],)
            ).fetchone()[0]
            == "succeeded"
        ):
            return transcript_id
        if con.execute(
            "SELECT count(*) FROM transcript_words WHERE chunk_id=?", (chunk["id"],)
        ).fetchone()[0]:
            con.execute(
                "UPDATE transcription_chunks SET state='succeeded',error_category=NULL WHERE id=?",
                (chunk["id"],),
            )
            return transcript_id
        groups = []
        current = []
        for i, w in enumerate(neutral.words):
            speaker = f"{chunk['id']}:{w.speaker}" if w.speaker else None
            start = w.start_ms + chunk["start_ms"] if w.start_ms is not None else None
            end = w.end_ms + chunk["start_ms"] if w.end_ms is not None else None
            if end is not None and end > chunk["end_ms"] + 1000:
                raise ValueError("Word time exceeds chunk duration.")
            con.execute(
                "INSERT INTO transcript_words VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    uid(),
                    transcript_id,
                    chunk["id"],
                    i,
                    start,
                    end,
                    w.text,
                    w.token_type,
                    w.speaker,
                    w.logprob,
                ),
            )
            if current and (
                (speaker != current[-1]["speaker"])
                or (
                    start is not None
                    and current[0]["start"] is not None
                    and start - current[0]["start"] > 20000
                )
            ):
                groups.append(current)
                current = []
            current.append(
                {"text": w.text, "start": start, "end": end, "speaker": speaker}
            )
        if current:
            groups.append(current)
        if not groups:
            groups = [
                [
                    {
                        "text": neutral.text,
                        "start": chunk["start_ms"],
                        "end": chunk["end_ms"],
                        "speaker": None,
                    }
                ]
            ]
        for i, g in enumerate(groups):
            # Large spacing avoids ordinal collisions across chunk boundaries.
            start = next((w["start"] for w in g if w["start"] is not None), None)
            end = next((w["end"] for w in reversed(g) if w["end"] is not None), None)
            exact = bool(neutral.words) and all(
                w["start"] is not None and w["end"] is not None for w in g
            )
            con.execute(
                "INSERT INTO transcript_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    uid(),
                    transcript_id,
                    chunk["id"],
                    chunk["ordinal"] * 100000 + i,
                    start,
                    end,
                    "".join(w["text"] for w in g),
                    "{}",
                    g[0]["speaker"],
                    None,
                    "provider_exact" if exact else "edited_anchor",
                    now(),
                ),
            )
        con.execute(
            "UPDATE transcription_chunks SET state='succeeded',error_category=NULL WHERE id=?",
            (chunk["id"],),
        )
        if t:
            con.execute(
                "UPDATE transcripts SET revision=revision+1,updated_at=? WHERE id=?",
                (now(), transcript_id),
            )
        revision = con.execute(
            "SELECT revision FROM transcripts WHERE id=?", (transcript_id,)
        ).fetchone()[0]
        snapshot(con, transcript_id, revision, "chunk import")
        index_lecture(con, job["lecture_id"])
    return transcript_id


def save(db, transcript_id, data):
    with db.tx() as con:
        t = con.execute(
            "SELECT * FROM transcripts WHERE id=?", (transcript_id,)
        ).fetchone()
        if not t:
            raise AppError("validation", "Transcript not found.", 404)
        if t["revision"] != data.base_revision:
            raise AppError(
                "editor_conflict",
                "A newer revision exists. Keep your local draft and compare it with the server version.",
                409,
            )
        old = {
            b["id"]: dict(b)
            for b in con.execute(
                "SELECT * FROM transcript_blocks WHERE transcript_id=?",
                (transcript_id,),
            )
        }
        ids = [b.id for b in data.blocks]
        if len(ids) != len(set(ids)):
            raise AppError("validation", "Block IDs must be unique.")
        # UI cannot move provider anchors or claim exact alignment for new/edited content.
        new = []
        for i, b in enumerate(data.blocks):
            if "lexical" in b.marks_json:
                from .richtext import logical_text

                tree = b.marks_json["lexical"]
                if (
                    not isinstance(tree, dict)
                    or "root" not in tree
                    or logical_text(tree["root"]) != b.text
                ):
                    raise AppError(
                        "validation",
                        "Rich formatting must match the canonical text in logical order.",
                    )
            prior = old.get(b.id)
            alignment = "unaligned"
            start = None
            end = None
            chunk = None
            speaker = b.speaker_key
            if prior:
                start, end, chunk = (
                    prior["start_ms"],
                    prior["end_ms"],
                    prior["chunk_id"],
                )
                alignment = (
                    prior["alignment_status"]
                    if b.text == prior["text"]
                    else ("edited_anchor" if start is not None else "unaligned")
                )
            new.append(
                (
                    b.id,
                    transcript_id,
                    chunk,
                    i,
                    start,
                    end,
                    b.text,
                    canonical(b.marks_json),
                    speaker,
                    b.direction_override,
                    alignment,
                    now(),
                )
            )
        # The table has 12 columns; immutable provider words remain untouched.
        con.execute(
            "DELETE FROM transcript_blocks WHERE transcript_id=?", (transcript_id,)
        )
        con.executemany(
            "INSERT INTO transcript_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", new
        )
        revision = t["revision"] + 1
        con.execute(
            "UPDATE transcripts SET revision=?,updated_at=? WHERE id=?",
            (revision, now(), transcript_id),
        )
        snapshot(con, transcript_id, revision, data.reason)
        index_lecture(con, t["lecture_id"])
    return get_transcript(db, transcript_id)


def restore_revision(db, transcript_id, revision, base_revision):

    saved = db.one(
        "SELECT * FROM transcript_revisions WHERE transcript_id=? AND revision=?",
        (transcript_id, revision),
    )
    raw = json.loads(saved["blocks"])
    # Restore anchors only from immutable history, with optimistic concurrency.
    with db.tx() as con:
        t = con.execute(
            "SELECT * FROM transcripts WHERE id=?", (transcript_id,)
        ).fetchone()
        if t["revision"] != base_revision:
            raise AppError(
                "editor_conflict", "Transcript changed before restoration.", 409
            )
        con.execute(
            "DELETE FROM transcript_blocks WHERE transcript_id=?", (transcript_id,)
        )
        for b in raw:
            con.execute(
                "INSERT INTO transcript_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                tuple(
                    b[k]
                    for k in [
                        "id",
                        "transcript_id",
                        "chunk_id",
                        "ordinal",
                        "start_ms",
                        "end_ms",
                        "text",
                        "marks_json",
                        "speaker_key",
                        "direction_override",
                        "alignment_status",
                        "updated_at",
                    ]
                ),
            )
        con.execute(
            "UPDATE transcripts SET revision=revision+1,updated_at=? WHERE id=?",
            (now(), transcript_id),
        )
        snapshot(
            con, transcript_id, base_revision + 1, "restore revision " + str(revision)
        )
        index_lecture(con, t["lecture_id"])
    return get_transcript(db, transcript_id)


def search(db, query, *, course_id=None, unfiled=False, tag=None, unused_only=False):
    terms = shadow(query).split()
    if not terms:
        return []
    expression = " AND ".join('"' + term.replace('"', '""') + '"' for term in terms)
    conditions = ["search_fts MATCH ?"]
    args = [expression]
    if course_id:
        conditions.append("l.course_id=?")
        args.append(course_id)
    if unfiled:
        conditions.append("l.course_id IS NULL")
    if tag:
        conditions.append(
            "EXISTS(SELECT 1 FROM lecture_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.lecture_id=l.id AND t.name=?)"
        )
        args.append(tag)
    if unused_only:
        conditions.append("l.is_used=0")
    matches = db.all(
        "SELECT f.lecture_id,f.block_id,f.start_ms,coalesce(b.text,l.title) AS canonical_text,l.title,l.is_used,c.name AS course FROM search_fts f JOIN lectures l ON l.id=f.lecture_id LEFT JOIN courses c ON c.id=l.course_id LEFT JOIN transcript_blocks b ON b.id=f.block_id WHERE "
        + " AND ".join(conditions)
        + " ORDER BY rank LIMIT 100",
        args,
    )
    for match in matches:
        match["is_used"] = bool(match["is_used"])
        text = match.pop("canonical_text")
        normalized = shadow(text)
        offsets = [normalized.find(term) for term in terms if term in normalized]
        start = max(0, min(offsets) - 60) if offsets else 0
        match["snippet"] = (
            ("…" if start else "")
            + text[start : start + 240]
            + ("…" if start + 240 < len(text) else "")
        )
    return matches


def export(db, lecture_id, markdown, timestamps, speakers):
    lecture = db.one("SELECT * FROM lectures WHERE id=?", (lecture_id,))
    t = db.one(
        "SELECT * FROM transcripts WHERE lecture_id=? ORDER BY created_at DESC LIMIT 1",
        (lecture_id,),
    )
    document = get_transcript(db, t["id"])
    lines = [("# " + lecture["title"] + "\n") if markdown else lecture["title"] + "\n"]
    for b in document["blocks"]:
        prefix = ""
        if timestamps and b["start_ms"] is not None:
            seconds = b["start_ms"] // 1000
            prefix += (
                f"[{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}] "
            )
        if speakers and b["speaker_key"]:
            prefix += (
                document["speakers"].get(
                    b["speaker_key"], b["speaker_key"].split(":")[-1]
                )
                + " — "
            )
        text = b["text"]
        marks = b["marks_json"]
        if markdown and "lexical" in marks:
            from .richtext import markdown as rich_markdown

            text = rich_markdown(marks["lexical"]["root"])
        elif markdown:
            if marks.get("type") in ("h1", "h2", "h3"):
                prefix = "#" * int(marks["type"][1]) + " " + prefix
            # Canonical Lexical serialized state is kept; export text in logical order.
            if marks.get("bold"):
                text = "**" + text + "**"
            if marks.get("italic"):
                text = "*" + text + "*"
            if marks.get("code"):
                text = "`" + text + "`"
        lines.append(prefix + text)
    return "\n\n".join(lines) + "\n"
