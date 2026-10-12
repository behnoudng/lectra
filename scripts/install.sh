#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
python3 -m venv .venv
.venv/bin/pip install --cache-dir /tmp/lectra-pip-cache -r backend/requirements.lock -r backend/requirements-dev.txt
npm --prefix frontend ci --cache /tmp/lectra-npm-cache
npm --prefix frontend run build
PYTHONPATH=backend .venv/bin/python -c 'from app.db import verify_sqlite; verify_sqlite()'
