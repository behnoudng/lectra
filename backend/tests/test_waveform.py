import json

from app import media
from app.storage import sha256


def test_old_waveform_cache_is_upgraded_without_changing_audio(db, lecture):
    proxy = next(a for a in lecture["media"] if a["kind"] == "proxy")
    original = next(a for a in lecture["media"] if a["kind"] == "original")
    original_path = db.cfg.data / original["path"]
    proxy_path = db.cfg.data / proxy["path"]
    original_hash, proxy_hash = sha256(original_path), sha256(proxy_path)
    output = db.cfg.data / "waveform" / f"{proxy['id']}.json"
    output.write_text(json.dumps({"peaks": [0.1], "duration_ms": proxy["duration_ms"]}))

    detailed = media.peaks(db, proxy)
    assert detailed["version"] == 2
    assert 5000 < len(detailed["peaks"]) <= 50000
    assert detailed["duration_ms"] == proxy["duration_ms"]
    assert all(0 <= peak <= 1 for peak in detailed["peaks"])
    assert media.peaks(db, proxy) == detailed
    assert sha256(original_path) == original_hash
    assert sha256(proxy_path) == proxy_hash
