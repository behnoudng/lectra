# Lectra

A local multi-language lecture transcription workstation. Import long recordings, make nondestructive cuts, review paid transcription settings, and correct a canonical transcript in audio-synced or document view. Preparation, editing, search, export, and backups run locally. Transcription sends audio to **ElevenLabs Scribe v2**.

## Run on Linux

Install Docker Engine and the Docker Compose plugin, then:

```bash
cp .env.example .env
# Edit .env if you want transcription; leave the key blank for local-only work.
docker compose up --build -d
```

Open the app on **localhost port 8787**. Only `web` is published, bound to `127.0.0.1`. API and the independent sequential worker have no host ports. Check `docker compose ps` for readiness. The first build compiles the pinned, checksum-verified SQLite 3.53.1 release and installs FFmpeg; later builds reuse layers.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_PORT` | `8787` | Loopback web port |
| `APP_DATA_DIR` | `./data` | Local database, original media, derivatives, evidence |
| `BACKUP_DIR` | `./backups` | Versioned snapshots and content-addressed objects |
| `ELEVENLABS_API_KEY` | unset | API/worker environment only; never sent to the browser |

Use a **local Linux filesystem** for `APP_DATA_DIR`, not NFS/SMB/network mounts. The SQLite runtime refuses known unsafe versions, including 3.52.0, with a WAL-reset fix explanation. Foreign keys, WAL, `synchronous=FULL`, a busy timeout, migrations, integrity checks, and FTS5 are enabled.

There is no API-key field in the UI. After changing the backend credential, run `docker compose up -d --force-recreate api worker`. In Settings, use **Check account access**; this performs a read-only account check. Credential presence, server reachability, optional account access, and the last transcription result are shown separately. An absent key leaves local features usable and paid transcription disabled. Account usage is returned through an explicit safe field allowlist.

### ElevenLabs key permissions

| Key editor setting | Lectra needs it for |
| --- | --- |
| **Speech to Text → Access** | Required for Scribe transcription |
| **User → Access** | Optional read-only connection and subscription/usage checks |
| All other shown endpoint permissions | Leave at **No Access** |

The account checks call `GET /v1/user` and `GET /v1/user/subscription`.
ElevenLabs can return HTTP 401 with `missing_permissions` for a valid restricted
key; Lectra displays **Restricted**, rather than declaring that key invalid.
A successful account check does not verify Speech-to-Text permission. Testing
connection never submits audio. Keep **Restrict Key** and **Auto-disable if leaked**
enabled. The key's usage limit is in **credits**, not dollars: a cap of 3 credits
can be insufficient for a lecture. Set a suitable credit cap using your account's
current pricing and allowance.

An HTTP **401** from `POST /v1/speech-to-text` can indicate a permission,
credential, or credit-limit rejection. Queue errors show the saved HTTP status,
bounded and redacted provider message/code, request ID, and guidance before a
retry. Older attempts retain their HTTP status but their discarded response
body cannot be recovered. A successful account check still does not verify
speech access, and the app never sends paid audio as a connection test. The
request contract was checked against ElevenLabs' current official
[SDK API reference](https://github.com/elevenlabs/elevenlabs-python/blob/main/reference.md#speech-to-text)
and [multipart adapter](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/speech_to_text/raw_client.py).

Place `.env` beside `compose.yaml`, not in `backend/`. Compose reads this file
without exporting it into your terminal, so an empty shell
`echo $ELEVENLABS_API_KEY` does not establish that the containers lack the key.
Check presence without printing it:

```bash
docker compose exec -T api python -c 'import os; print("API key loaded:", bool(os.getenv("ELEVENLABS_API_KEY")))'
docker compose exec -T worker python -c 'import os; print("Worker key loaded:", bool(os.getenv("ELEVENLABS_API_KEY")))'
```

If either is false, correct the project `.env` and recreate both services.
An exported shell variable takes precedence over `.env`; unset an empty shell
`ELEVENLABS_API_KEY` when you intend to use the file. The backend image is built
locally; the worker reuses it and does not need a Docker Hub login.

## First lecture

1. Create a course and enter reusable vocabulary/defaults, if useful.
2. Import an audio or video recording with title, date, and tags. Uploads spool/stream, are hashed and probed, and produce a playback proxy and bounded waveform peaks.
3. In Audio Preparation, drag across the waveform and adjust its handles, or enter exact start/end times in seconds (`743.5`), `mm:ss.mmm`, or `hh:mm:ss.mmm`. The live recording clock, timeline ruler, hover timestamp, overview navigator, and **Zoom to selection** help locate short sections in long lectures. Use **Preview selection**, then **Cut selection**. Removed audio is masked with solid red cut bands; tiny cuts remain visible as markers at low zoom. The **×** on a selection dismisses it. Removed sections can be listened to or restored individually; undo/redo and **Restore all audio** are also available. **Play** skips cuts. **Set start here / Set end here** (I/O), Space, arrow keys (Shift for 0.1 seconds), and Delete support keyboard editing outside input fields. Optional cleanup is off by default. Checking an effect prepares a local preview, shows progress, and applies it to the main player and transcription settings. Play once the effects are ready; failures offer a retry or can be cleared by switching effects off. The optional clean/enhanced A/B comparison shares the same edited time range. Save preparation before leaving. The original remains unchanged.
4. Review the course, language (auto by default), speaker settings, keyterms, preprocessing, chunk count, usage, and cost warnings. **Confirm and enqueue** authorizes paid transcription. Changed cuts, settings, or pricing require a fresh review. Retry/cancel unfinished jobs first; resubmitting completed audio requires explicit retranscription approval.
5. The worker sends one request at a time. Default chunks target 15 minutes, choose nearby silence, and cover the virtual timeline once without overlap. Whole-file mode has conservative local caps of ten hours and 1.9 GB of rendered PCM.
6. Edit in audio-synced or document view. Both use the same blocks and rich text. Direction defaults to auto; per-block RTL/LTR changes presentation. Code spans isolate LTR content. Logical Unicode order is preserved.
7. Search across title, course, tags, and text. Search normalization handles Yeh/Kaf and ZWNJ variants without rewriting canonical text or displayed snippets. Export TXT or Markdown with optional timestamps and speakers.

Playback supports speed, separately configurable forward/backward skips, passage looping, two-second rewind on resume, seekable timestamps, current-block highlighting, and auto-follow. Defaults are Space outside text input, Ctrl+Space while editing, Alt+arrows to skip, and `?` for help; Settings offers alternative shortcuts. Edited timed blocks retain a broad seek anchor and are labeled **edited**, without invented word timing.

## Financial safety and recovery

Each attempt records the audio hash, settings hash, chunk/source spans, timestamps, outcome, retry authorization, and cost estimate. Job settings, vocabulary, and pricing references are immutable snapshots. The usage ledger distinguishes estimates from actual billing; **actual vendor charges remain unconfirmed**.

- **Pending/preparing/prepared:** local preparation may safely restart.
- **Started request without a durable result:** `unknown_outcome`. The whole queue pauses. There are no automatic transcription retries.
- **Successful response:** exact raw bytes are atomically written and fsynced before parsing, then registered with a SHA-256. Temporary outbound audio is removed once evidence is durable.
- **Parser/storage/normalization failure:** use **Reprocess saved response** when an artifact exists. This performs local work and sends no audio.
- **Uncertain or explicitly rejected request:** **Review paid retry** shows incremental estimate/risk. Explicit approval creates another attempt and ledger row, linking the previous attempt; it never erases the old one.
- **Cancel / leave unresolved:** preserves evidence. You may then resume other work.
- **Pause:** waits for an in-flight request to finish. It does not abort the request.

The worker owns an OS file lock for its lifetime, preventing concurrent workers. API restarts do not mark a live worker’s request as unknown. Startup reconciliation discovers artifacts left between file persistence and the database transition, repairs local imports/assembly, skips completed chunks, and conservatively classifies started requests. Graceful shutdown finishes an in-flight operation; stopping during preparation does not start another request. A heartbeat runs independently of long provider calls.

## Editing and revisions

IndexedDB captures independent drafts for each editor session; debounced server saves use a base revision. Stale-tab saves return a conflict rather than overwriting. Recovery lets you choose retained drafts and compare local/server versions. When IndexedDB is unavailable, server autosave continues and a warning explains the missing crash protection. Exports wait for pending saves and refuse unresolved conflicts or failed saves. Revision snapshots are immutable, and restoration creates a newer revision. Checkpoints, chunk imports, rich formatting, and recovery saves are recorded. Provider words and artifacts remain immutable. Speaker IDs are scoped to chunks; renaming does not imply cross-chunk identity. Speaker edits use optimistic revisions; the API also supports explicit user-directed merges.

## Costs and budgets

No base price is invented. In Settings, create a versioned pricing rule using your account’s current audio-hour rate, currency, source note, and keyterm adjustment. Amounts use integer micro-units. The official contract inspected for this implementation specifies up to 1,000 keyterms, fewer than 50 characters and at most five words each, a 20% keyterm adjustment, and a 20-second minimum when more than 100 terms are sent. These mutable rules belong in pricing versions; recheck your plan before updating them.

Without a pricing rule, the review shows known duration/request counts and **unknown cost**, rather than claiming transcription is free. Monthly budgets produce advisory warnings. Account allowances and uncertain attempts mean incremental payment is not reliably calculable; the app does not manufacture a vendor invoice or actual charge.

## Backups and restore

The worker makes an automatic verified snapshot on first use and at the configured interval (24 hours by default). Settings control automatic original-audio inclusion; **Back up now** has its own inclusion option. Backups use SQLite’s online backup API, immutable content-addressed media/artifact objects, `snapshot.json`, `app.sqlite3`, `artifacts/`, and `checksums.sha256`. Neither `.env` nor credentials are included. Proxies and provider artifacts are retained; originals are optional.

Verification checks the manifest, checksums, database integrity/foreign keys/FTS, and all included references. Restore refuses a corrupt snapshot or an in-flight worker operation. It pauses the queue, attempts a pre-restore snapshot including originals, stages and fsyncs data, journals directory swaps, and reconciles checkpoints. A process death before the commit point rolls back on startup; a committed swap survives restart.

**Restoring content never rewinds billing evidence.** Newer attempts, ledger rows, successful chunks, and provider evidence remain auditable; newer lectures required by that evidence remain visible. Transcript history is retained and restored content becomes a new revision. Waiting chunks restored from a snapshot require explicit retry review before another request, because a snapshot alone cannot prove that a later request never occurred. The queue stays paused after restore.

If originals were omitted, restore retains a matching existing original when available. Otherwise it reports unavailable originals and blocks work requiring them; it does not claim the missing recording was restored. Keep an independent copy of your backup directory. No backup garbage collection or remote/encrypted backup is implemented in V1.

## Deletion and storage

Original audio is never automatically deleted. **Delete original audio** uses one lightweight confirmation, is blocked while unfinished jobs require it, and preserves transcripts/playback proxies. Older backup snapshots can still contain the deleted original. Temporary rendered chunks are disposable once raw evidence is safely stored. Files use internal UUID/hash paths; uploaded filenames never become filesystem paths.

Data locations:

```text
data/db/app.sqlite3          SQLite and WAL files
data/media/original/        Immutable uploaded recordings
data/media/proxy/           Playback proxies
data/media/derived/         Edited/enhanced playback assets
data/artifacts/provider/    Immutable raw provider bytes
data/waveform/              Peak data and silence boundaries
data/tmp/                   Upload/render scratch space
backups/objects/            Immutable content-addressed assets
backups/snapshots/<id>/     Manifests, consistent DB, linked assets
```

SQLite must be opened through the application’s configured connection settings. Never copy an active WAL database as a backup, edit provider artifacts, delete originals from the filesystem, or reset attempt states manually to “pending.”

## Development and tests

Python 3.12+, Node 24, FFmpeg/ffprobe, and a fixed SQLite runtime are required. Docker supplies the fixed runtime; the host development path checks its SQLite build explicitly.

For the complete locked installation, run `./scripts/install.sh`. After installation,
`./scripts/dev.sh` starts API, worker, and Vite together; stop its terminal with
Ctrl+C to shut down the three process groups. The explicit commands below are
useful when debugging one service at a time.

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.lock
npm --prefix frontend ci
npm --prefix frontend run build
PYTHONPATH=backend .venv/bin/python -c 'from app.db import verify_sqlite; verify_sqlite()'
PYTHONPATH=backend .venv/bin/pytest backend/tests
```

Run API and worker separately, using the same data paths, then Vite in a third terminal:

```bash
export APP_DATA_DIR="$PWD/data" BACKUP_DIR="$PWD/backups" PYTHONPATH="$PWD/backend"
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
.venv/bin/python -m worker.main
npm --prefix frontend run dev
```

Vite binds to loopback and proxies `/api`. Each cloud task is already isolated: use its existing checkout; do not create a worktree for normal development. This repository deliberately has no V2 transcription engines, vector/search services, brokers, cloud SDKs, or restoration models.

Browser tests run a real API/worker/FFmpeg against a test-only fake ElevenLabs server. They do not spend money:

```bash
cd frontend
# Uses /usr/bin/chromium by default. Set the variable to your installed browser,
# or install Playwright Chromium and pass its executable path.
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm test
```

The browser runner uses ports 8000, 8121, and 5173, and a dedicated `/tmp/lectra-e2e` directory; stop development processes on those ports first. Optional real two-hour media validation:

```bash
LECTRA_LONG_TEST=1 PYTHONPATH=backend .venv/bin/pytest backend/tests/test_long_lecture.py
```

The test matrix and observed validation are in [docs/acceptance.md](docs/acceptance.md). The second specification review and prioritized repairs are in [docs/v1-audit.md](docs/v1-audit.md). API details and upstream references are in [docs/provider-contract.md](docs/provider-contract.md). No live paid transcription has been run as part of implementation; authentic vendor audio quality/account billing must be validated with your own explicitly approved request.

## Updating

Create and verify a backup first. Pause the queue and wait for any in-flight call to finish, then `docker compose down` (do not delete your data directories). Update the code, run `docker compose up --build -d`, and check readiness. Alembic upgrades run on startup; destructive downgrades are refused. Keep old snapshots until the update is verified. Never terminate/restart a started request on the assumption that retrying will be free.

## Localhost boundary

This is single-user and localhost-only. It has no authentication or public/LAN deployment support. The API rejects foreign Origin writes and unexpected Host names; the web sets CSP and related response headers. Do not broaden the loopback bind or deploy behind a public tunnel. No application analytics or telemetry is configured. No zero-retention promise is made for ElevenLabs.
