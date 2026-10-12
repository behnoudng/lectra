"""SIGKILL-equivalent restore crash harness, never loaded by the app."""

import os
from pathlib import Path
import sys
from app.config import Config
from app.db import Database
from app.backup import BackupService

data, backups, snapshot = sys.argv[1:]
replace = os.replace


def crash_after_database_swap(source, destination):
    source = Path(source)
    if source.name == "media" and source.parent.name.startswith("restore-stage-"):
        os._exit(81)
    return replace(source, destination)


os.replace = crash_after_database_swap
BackupService(
    Database(Config(Path(data), Path(backups), "https://api.elevenlabs.io"))
).restore(snapshot)
