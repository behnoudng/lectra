#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export APP_DATA_DIR="${APP_DATA_DIR:-$PWD/data}"
export BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
export PYTHONPATH="$PWD/backend${PYTHONPATH:+:$PYTHONPATH}"
.venv/bin/python -c 'from app.db import verify_sqlite; verify_sqlite()'
pids=()
stop_services() {
  local code=$?
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  exit "$code"
}
trap stop_services EXIT INT TERM
setsid .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log &
pids+=("$!")
setsid .venv/bin/python -m worker.main &
pids+=("$!")
setsid npm --prefix frontend run dev &
pids+=("$!")
wait -n "${pids[@]}"
