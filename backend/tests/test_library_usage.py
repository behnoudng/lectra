import json
import sqlite3

from fastapi.testclient import TestClient

from app.backup import BackupService
from app.contracts import CourseInput, LectureInput
from app.db import Database
from app.library import Library
from app.main import create_app
from app.storage import canonical, sha256


def test_usage_persists_without_overwriting_metadata_or_processing(db, lecture, job):
    library = Library(db)
    before = {
        table: db.all("SELECT * FROM " + table)
        for table in (
            "transcription_jobs",
            "transcription_chunks",
            "usage_ledger",
            "media_assets",
        )
    }
    with TestClient(create_app(db.cfg)) as client:
        endpoint = "/api/v1/lectures/" + lecture["id"] + "/usage"
        assert client.patch(endpoint, json={"is_used": "false"}).status_code == 422
        assert (
            client.patch(endpoint, json={"is_used": True, "title": "bad"}).status_code
            == 422
        )
        assert (
            client.patch(
                "/api/v1/lectures/missing/usage", json={"is_used": True}
            ).status_code
            == 404
        )
        for _ in range(2):
            response = client.patch(endpoint, json={"is_used": True})
            assert response.status_code == 200
            assert response.json()["is_used"] is True
        updated = client.patch(
            "/api/v1/lectures/" + lecture["id"],
            json={"title": "Renamed", "date": lecture["date"], "tags": ["updated"]},
        ).json()
        assert updated["is_used"] is True
        assert updated["title"] == "Renamed"
        assert updated["tags"] == ["updated"]
        assert (
            next(
                row
                for row in client.get("/api/v1/lectures").json()
                if row["id"] == lecture["id"]
            )["is_used"]
            is True
        )
        reopened = Database(db.cfg)
        reopened.initialize()
        assert Library(reopened).lecture(lecture["id"])["is_used"] is True
        assert (
            client.patch(endpoint, json={"is_used": False}).json()["is_used"] is False
        )
    assert library.lecture(lecture["id"])["edl"] == lecture["edl"]
    for table, rows in before.items():
        assert db.all("SELECT * FROM " + table) == rows


def test_usage_marks_restore_and_pre_usage_schema_upgrade(db, lecture):
    library = Library(db)
    backups = BackupService(db)
    library.set_usage(lecture["id"], True)
    snapshot = backups.create(True)
    library.set_usage(lecture["id"], False)
    backups.restore(snapshot["id"])
    assert library.lecture(lecture["id"])["is_used"] is True

    # A genuine pre-feature snapshot has neither the column nor its revision.
    root = db.cfg.backups / "snapshots" / snapshot["id"]
    database = root / "app.sqlite3"
    with sqlite3.connect(database) as con:
        con.execute("ALTER TABLE lectures DROP COLUMN is_used")
        con.execute("UPDATE alembic_version SET version_num='0002'")
    con.close()  # Checkpoint the modified WAL before checksumming the snapshot.
    info = json.loads((root / "snapshot.json").read_text())
    for file in info["files"]:
        if file["path"] == "app.sqlite3":
            file.update(sha256=sha256(database), size=database.stat().st_size)
    (root / "snapshot.json").write_text(canonical(info))
    (root / "checksums.sha256").write_text(
        "".join(f"{file['sha256']}  {file['path']}\n" for file in info["files"])
    )
    backups.restore(snapshot["id"])
    db.initialize()
    restored = library.lecture(lecture["id"])
    assert restored["is_used"] is False
    assert restored["title"] == lecture["title"]
    assert restored["edl"] == lecture["edl"]
    assert db.one("SELECT version_num FROM alembic_version")["version_num"] == "0003"


def test_search_combines_filters_before_the_result_limit(db):
    library = Library(db)
    alpha = library.create_course(CourseInput(name="Alpha"))["id"]
    beta = library.create_course(CourseInput(name="Beta"))["id"]

    def create(title="needle", course_id=None, tags=None):
        return library.create_lecture(
            LectureInput(
                title=title, course_id=course_id, date="2026-10-20", tags=tags or []
            )
        )["id"]

    for _ in range(105):
        create(course_id=alpha, tags=["match"])
    wanted = create("needle requested lecture with a longer title", beta, ["match"])
    used = create(course_id=beta, tags=["match"])
    library.set_usage(used, True)
    create(course_id=beta, tags=["other"])
    unfiled = create("needle without a course")
    with TestClient(create_app(db.cfg)) as client:
        all_results = client.get("/api/v1/search", params={"q": "needle"}).json()
        assert len(all_results) == 100
        assert wanted not in {row["lecture_id"] for row in all_results}
        params = {"q": "needle", "course_id": beta, "tag": "match", "unused_only": True}
        matches = client.get("/api/v1/search", params=params).json()
        assert [row["lecture_id"] for row in matches] == [wanted]
        assert matches[0]["is_used"] is False
        params["unused_only"] = False
        assert {
            row["lecture_id"]
            for row in client.get("/api/v1/search", params=params).json()
        } == {wanted, used}
        params["tag"] = "x' OR 1=1 --"
        assert client.get("/api/v1/search", params=params).json() == []
        assert [
            row["lecture_id"]
            for row in client.get(
                "/api/v1/search", params={"q": "needle", "unfiled": True}
            ).json()
        ] == [unfiled]
        assert (
            client.get(
                "/api/v1/search",
                params={"q": "needle", "unfiled": True, "course_id": beta},
            ).status_code
            == 400
        )
