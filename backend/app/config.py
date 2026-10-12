from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Config:
    data: Path
    backups: Path
    provider_url: str

    @property
    def db_path(self) -> Path:
        return self.data / "db/app.sqlite3"

    def prepare(self):
        for sub in [
            "db",
            "media/original",
            "media/proxy",
            "media/derived",
            "artifacts/provider",
            "waveform",
            "tmp/upload",
            "tmp/preprocess",
            "tmp/chunks",
        ]:
            (self.data / sub).mkdir(parents=True, exist_ok=True)
        for sub in ["objects", "snapshots"]:
            (self.backups / sub).mkdir(parents=True, exist_ok=True)


def settings() -> Config:
    return Config(
        Path(os.getenv("APP_DATA_DIR", "./data")).resolve(),
        Path(os.getenv("BACKUP_DIR", "./backups")).resolve(),
        "https://api.elevenlabs.io",
    )
