import contextlib
import fcntl
import hashlib
import json
import os
import uuid
from pathlib import Path
from .errors import AppError


def uid() -> str:
    return str(uuid.uuid4())


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for piece in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(piece)
    return digest.hexdigest()


def sync_dir(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uid() + ".tmp")
    try:
        with tmp.open("xb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


def immutable_bytes(path: Path, data: bytes):
    if path.exists():
        if path.read_bytes() != data:
            raise AppError(
                "storage",
                "Immutable artifact already exists with different content.",
                409,
            )
        return
    atomic_bytes(path, data)
    path.chmod(0o444)


def safe_path(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()) or target == root.resolve():
        raise AppError("storage", "Invalid storage path.")
    return target


@contextlib.contextmanager
def lock(path: Path, *, exclusive=True, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        flags = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        if not blocking:
            flags |= fcntl.LOCK_NB
        try:
            fcntl.flock(handle, flags)
        except BlockingIOError:
            raise AppError(
                "restore",
                "Worker or another operation is active. Wait for it to finish.",
                409,
            )
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def sync_tree(root: Path):
    directories = [root]
    for path in root.rglob("*"):
        if path.is_dir():
            directories.append(path)
        elif path.is_file():
            with path.open("rb") as file:
                os.fsync(file.fileno())
    for path in sorted(directories, key=lambda p: len(p.parts), reverse=True):
        sync_dir(path)
