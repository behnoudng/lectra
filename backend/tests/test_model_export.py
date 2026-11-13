from fastapi.testclient import TestClient

from app import media, pricing
from app.contracts import JobInput, PriceInput, TranscriptionSettings
from app.library import Library
from app.main import create_app
from app.queue import QueueService
from app.storage import sha256


def test_model_prices_and_paid_review_are_isolated(db, lecture):
    queue = QueueService(db)
    pricing.save_rule(
        db,
        PriceInput(
            effective_from="2026-01-01",
            currency="USD",
            base_micros_per_hour=1000000,
            source_note="Test V2 rate",
        ),
    )
    v2 = JobInput(lecture_id=lecture["id"], settings=TranscriptionSettings())
    v3 = v2.model_copy(update={"settings": TranscriptionSettings(model_id="scribe_v3")})
    first, second = queue.estimate(v2), queue.estimate(v3)
    assert first["estimated_cost"] is not None
    assert second["estimated_cost"] is None
    assert second["model"] == "scribe_v3"
    assert first["review_hash"] != second["review_hash"]
    with TestClient(create_app(db.cfg)) as client:
        stale = v3.model_dump() | {
            "confirmed": True,
            "review_hash": first["review_hash"],
        }
        assert client.post("/api/v1/jobs", json=stale).status_code == 409
        assert not db.all("SELECT * FROM provider_attempts")
        assert (
            client.post(
                "/api/v1/jobs/estimate",
                json={"lecture_id": lecture["id"], "settings": {"model_id": "wrong"}},
            ).status_code
            == 422
        )
    rule = pricing.save_rule(
        db,
        PriceInput(
            model_id="scribe_v3",
            effective_from="2026-01-01",
            currency="USD",
            base_micros_per_hour=2000000,
            source_note="Test V3 rate",
        ),
    )
    assert queue.estimate(v3)["pricing_rule"]["id"] == rule
    assert queue.estimate(v2)["pricing_rule"]["model"] == "scribe_v2"


def test_mp3_export_uses_current_ranges_and_effects_without_changing_lecture(
    db, lecture, monkeypatch
):
    source = media.original(db, lecture["id"])
    digest = sha256(db.cfg.data / source["path"])
    prior = Library(db).lecture(lecture["id"])
    calls = []
    real_render = media.render

    def render(*args, **kwargs):
        calls.append((args[2], args[3], kwargs))
        return real_render(*args, **kwargs)

    monkeypatch.setattr(media, "render", render)
    data = {
        "spans": [{"start_ms": 200, "end_ms": 700}, {"start_ms": 2200, "end_ms": 2700}],
        "preprocessing": {
            "enabled": True,
            "highpass": True,
            "denoise": True,
            "loudness": True,
        },
    }
    with TestClient(create_app(db.cfg)) as client:
        response = client.post(
            f"/api/v1/lectures/{lecture['id']}/audio-export", json=data
        )
        assert response.status_code == 200
        result = response.json()
        download = client.get(result["download_url"])
        assert download.status_code == 200
        assert download.headers["content-type"].startswith("audio/mpeg")
        assert "attachment;" in download.headers["content-disposition"]
        assert ".mp3" in download.headers["content-disposition"]
        asset = db.one("SELECT * FROM media_assets WHERE id=?", (result["id"],))
        path = db.cfg.data / asset["path"]
        assert download.content == path.read_bytes()
        assert abs(media.probe(path)["duration_ms"] - 1000) < 200
        assert calls == [(data["spans"], data["preprocessing"], {"playback": True})]
        assert (
            client.post(
                f"/api/v1/lectures/{lecture['id']}/audio-export", json=data
            ).json()["id"]
            == result["id"]
        )
        assert len(calls) == 1
        for spans in [
            [],
            [{"start_ms": 0, "end_ms": 99999}],
            [{"start_ms": 700, "end_ms": 200}],
        ]:
            invalid = client.post(
                f"/api/v1/lectures/{lecture['id']}/audio-export",
                json=data | {"spans": spans},
            )
            assert invalid.status_code in (400, 422)
    assert sha256(db.cfg.data / source["path"]) == digest
    assert Library(db).lecture(lecture["id"])["edl"] == prior["edl"]
    assert Library(db).lecture(lecture["id"])["preprocessing"] == prior["preprocessing"]
    assert not db.all("SELECT * FROM provider_attempts")
