from pathlib import Path
import array
import hashlib
import json
import math
import os
import re
import subprocess
from .db import now
from .errors import AppError
from .storage import atomic_bytes, canonical, sha256, sync_dir, uid, safe_path, lock


def run(command: list[str], *, timeout=7200) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            command, capture_output=True, timeout=timeout, check=True
        )
        return result
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        raise AppError(
            "local_media",
            "FFmpeg could not process this media. Check format, disk space, and FFmpeg availability.",
            422,
        )


def probe(path: Path):
    try:
        info = json.loads(
            run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_format",
                    "-show_streams",
                    "-of",
                    "json",
                    str(path),
                ],
                timeout=60,
            ).stdout
        )
        stream = next(s for s in info["streams"] if s["codec_type"] == "audio")
        duration = float(info["format"].get("duration") or stream["duration"])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError()
        formats = info["format"].get("format_name", "").split(",")
        mime = next(
            (
                mime
                for fmt, mime in [
                    ("wav", "audio/wav"),
                    ("mp3", "audio/mpeg"),
                    ("flac", "audio/flac"),
                    ("ogg", "audio/ogg"),
                    ("mp4", "audio/mp4"),
                    ("matroska", "video/x-matroska"),
                ]
                if fmt in formats
            ),
            "application/octet-stream",
        )
        return dict(
            mime=mime,
            duration_ms=round(duration * 1000),
            codec=stream["codec_name"],
            channels=int(stream["channels"]),
            sample_rate=int(stream["sample_rate"]),
        )
    except (ValueError, KeyError, StopIteration):
        raise AppError(
            "local_media", "The file does not contain a supported audio stream.", 422
        )


def validate_edl(spans: list[dict], duration: int):
    prior = 0
    for span in spans:
        if not (prior <= span["start_ms"] < span["end_ms"] <= duration):
            raise AppError(
                "validation",
                "Retained ranges must be ordered, nonoverlapping, and inside the original recording.",
            )
        prior = span["end_ms"]
    if not spans:
        raise AppError("validation", "Keep at least one range.")
    return spans


def virtual_duration(spans):
    return sum(s["end_ms"] - s["start_ms"] for s in spans)


def virtual_to_source(spans, time_ms):
    offset = 0
    for i, s in enumerate(spans):
        size = s["end_ms"] - s["start_ms"]
        if offset <= time_ms < offset + size or (
            i == len(spans) - 1 and time_ms == offset + size
        ):
            return s["start_ms"] + time_ms - offset
        offset += size
    raise AppError("validation", "Time is outside the edited timeline.")


def source_to_virtual(spans, time_ms):
    offset = 0
    for s in spans:
        if s["start_ms"] <= time_ms < s["end_ms"]:
            return offset + time_ms - s["start_ms"]
        offset += s["end_ms"] - s["start_ms"]
    if spans and time_ms == spans[-1]["end_ms"]:
        return offset
    return None


def intersect_spans(spans, start_ms, end_ms):
    output = []
    offset = 0
    for s in spans:
        size = s["end_ms"] - s["start_ms"]
        left = max(start_ms, offset)
        right = min(end_ms, offset + size)
        if left < right:
            output.append(
                {
                    "start_ms": s["start_ms"] + left - offset,
                    "end_ms": s["start_ms"] + right - offset,
                }
            )
        offset += size
    return output


def chunk_plan(spans, target_ms, silences=(), mode="chunked"):
    duration = virtual_duration(spans)
    if mode == "whole":
        return [(0, duration)]
    candidates = sorted(
        v for t in silences if (v := source_to_virtual(spans, t)) is not None
    )
    out = []
    start = 0
    window = min(30000, target_ms // 5)
    while start < duration:
        boundary = min(start + target_ms, duration)
        if boundary < duration:
            nearby = [
                v
                for v in candidates
                if abs(v - boundary) <= window
                and v > start + target_ms // 2
                and v < duration
            ]
            if nearby:
                boundary = min(nearby, key=lambda v: (abs(v - boundary), v))
        out.append((start, boundary))
        start = boundary
    return out


def render(source: Path, output: Path, spans, preprocessing: dict, *, playback=False):
    # No filename or user input is interpolated into a shell or arbitrary filter.
    filters = []
    for i, s in enumerate(spans):
        filters.append(
            f"[0:a]atrim=start={s['start_ms'] / 1000:.3f}:end={s['end_ms'] / 1000:.3f},asetpts=PTS-STARTPTS[a{i}]"
        )
    filters.append(
        "".join(f"[a{i}]" for i in range(len(spans)))
        + f"concat=n={len(spans)}:v=0:a=1[cut]"
    )
    chain = []
    if preprocessing.get("enabled"):
        if preprocessing.get("highpass", True):
            chain.append("highpass=f=70")
        if preprocessing.get("denoise", True):
            chain.append("afftdn=nf=-25")
        if preprocessing.get("loudness", True):
            chain.append("loudnorm=I=-18:TP=-2:LRA=11")
    filters.append("[cut]" + (",".join(chain) if chain else "anull") + "[out]")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(
        output.stem + "." + uid() + "." + ("mp3" if playback else "wav")
    )
    try:
        run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[out]",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "libmp3lame" if playback else "pcm_s16le",
                *(["-b:a", "64k"] if playback else []),
                str(temporary),
            ]
        )
        with temporary.open("rb") as f:
            os.fsync(f.fileno())
        os.replace(temporary, output)
        sync_dir(output.parent)
    finally:
        temporary.unlink(missing_ok=True)


def register_asset(db, lecture_id, kind, path, metadata, mime):
    asset_id = uid()
    with db.tx() as con:
        con.execute(
            "INSERT INTO media_assets(id,lecture_id,kind,path,sha256,duration_ms,codec,channels,sample_rate,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id,
                lecture_id,
                kind,
                str(path.relative_to(db.cfg.data)),
                sha256(path),
                metadata["duration_ms"],
                metadata["codec"],
                metadata["channels"],
                metadata["sample_rate"],
                mime,
                path.stat().st_size,
                now(),
            ),
        )
    return asset_id


def original(db, lecture_id):
    return db.one(
        "SELECT * FROM media_assets WHERE lecture_id=? AND kind='original' AND deleted_at IS NULL",
        (lecture_id,),
    )


def peaks(db, asset):
    output = db.cfg.data / "waveform" / f"{asset['id']}.json"
    if output.exists():
        return json.loads(output.read_text())
    path = safe_path(db.cfg.data, asset["path"])
    samples_per_peak = max(1, math.ceil(asset["duration_ms"] / 1000 * 8000 / 5000))
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    values = []
    try:
        while data := proc.stdout.read(samples_per_peak * 2):
            pcm = array.array("h")
            pcm.frombytes(data)
            values.append(round(max((abs(x) for x in pcm), default=0) / 32768, 4))
        if proc.wait() != 0:
            raise AppError("local_media", "Waveform generation failed.", 422)
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    payload = {"peaks": values, "duration_ms": asset["duration_ms"]}
    atomic_bytes(output, canonical(payload).encode())
    return payload


def silence_points(db, lecture_id):
    path = db.cfg.data / "waveform" / f"{lecture_id}.silences.json"
    if path.exists():
        return json.loads(path.read_text())
    asset = db.one(
        "SELECT * FROM media_assets WHERE lecture_id=? AND kind='proxy' AND deleted_at IS NULL",
        (lecture_id,),
    )
    result = run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "info",
            "-i",
            str(safe_path(db.cfg.data, asset["path"])),
            "-af",
            "silencedetect=n=-35dB:d=0.5",
            "-f",
            "null",
            "-",
        ]
    )
    starts = []
    points = []
    for line in result.stderr.decode(errors="replace").splitlines():
        match = re.search(r"silence_start: ([\d.]+)", line)
        if match:
            starts.append(float(match.group(1)))
        match = re.search(r"silence_end: ([\d.]+)", line)
        if match and starts:
            points.append(round((starts.pop() + float(match.group(1))) * 500))
    atomic_bytes(path, canonical(points).encode())
    return points


def finish_upload(db, lecture_id, temporary: Path, filename: str):
    db.one("SELECT id FROM lectures WHERE id=?", (lecture_id,))
    if db.one(
        "SELECT id FROM media_assets WHERE lecture_id=? AND kind='original'",
        (lecture_id,),
        required=False,
    ):
        raise AppError(
            "validation",
            "This lecture already has an original. Create a new lecture for another recording.",
            409,
        )
    meta = probe(temporary)
    asset_id = uid()
    path = db.cfg.data / "media/original" / asset_id
    digest = sha256(temporary)
    with db.tx() as con:
        if con.execute(
            "SELECT id FROM media_assets WHERE lecture_id=? AND kind='original'",
            (lecture_id,),
        ).fetchone():
            raise AppError(
                "validation",
                "Another import already saved this lecture's original.",
                409,
            )
        os.replace(temporary, path)
        sync_dir(path.parent)
        path.chmod(0o444)
        con.execute(
            "INSERT INTO media_assets(id,lecture_id,kind,path,sha256,duration_ms,codec,channels,sample_rate,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id,
                lecture_id,
                "original",
                str(path.relative_to(db.cfg.data)),
                digest,
                meta["duration_ms"],
                meta["codec"],
                meta["channels"],
                meta["sample_rate"],
                meta["mime"],
                path.stat().st_size,
                now(),
            ),
        )
        con.execute(
            "UPDATE lectures SET edl=? WHERE id=?",
            (canonical([{"start_ms": 0, "end_ms": meta["duration_ms"]}]), lecture_id),
        )
    generate_proxy(db, lecture_id)
    return {"original_id": asset_id, "sha256": digest, **meta}


def generate_proxy(db, lecture_id):
    key = hashlib.sha256(lecture_id.encode()).hexdigest()
    with lock(db.cfg.data / "asset-locks" / ("proxy-" + key + ".lock")):
        return _generate_proxy(db, lecture_id)


def _generate_proxy(db, lecture_id):
    existing = db.one(
        "SELECT * FROM media_assets WHERE lecture_id=? AND kind='proxy' AND deleted_at IS NULL",
        (lecture_id,),
        required=False,
    )
    if existing:
        return existing["id"]
    asset = original(db, lecture_id)
    path = db.cfg.data / "media/proxy" / f"{uid()}.mp3"
    render(
        safe_path(db.cfg.data, asset["path"]),
        path,
        [{"start_ms": 0, "end_ms": asset["duration_ms"]}],
        {},
        playback=True,
    )
    proxy_id = register_asset(db, lecture_id, "proxy", path, probe(path), "audio/mpeg")
    peaks(db, db.one("SELECT * FROM media_assets WHERE id=?", (proxy_id,)))
    silence_points(db, lecture_id)
    return proxy_id


def preview(db, lecture_id, spans, preprocessing):
    fingerprint = hashlib.sha256(
        canonical([lecture_id, spans, preprocessing]).encode()
    ).hexdigest()
    with lock(db.cfg.data / "asset-locks" / (fingerprint + ".lock")):
        return _preview(db, lecture_id, spans, preprocessing, fingerprint)


def _preview(db, lecture_id, spans, preprocessing, fingerprint):
    relative = f"media/derived/{fingerprint}.mp3"
    asset = db.one(
        "SELECT id FROM media_assets WHERE path=? AND deleted_at IS NULL",
        (relative,),
        required=False,
    )
    if asset:
        return asset["id"]
    src = db.one(
        "SELECT * FROM media_assets WHERE lecture_id=? AND kind IN ('original','proxy') AND deleted_at IS NULL ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END LIMIT 1",
        (lecture_id,),
    )
    path = db.cfg.data / relative
    render(
        safe_path(db.cfg.data, src["path"]), path, spans, preprocessing, playback=True
    )
    return register_asset(
        db,
        lecture_id,
        "enhanced" if preprocessing.get("enabled") else "edited_proxy",
        path,
        probe(path),
        "audio/mpeg",
    )
