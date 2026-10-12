# Master Prompt: Version 1 of the Local Persian-English Lecture Transcription Workstation

You are Codex working as the primary implementation engineer for this repository.

Your task is to build **Version 1** of a local-first transcription workstation for long university lectures, especially Persian lectures containing frequent English technical terms.

This is not a prototype, landing page, or mockup. Build a usable, durable local application with working backend, frontend, persistence, queueing, audio processing, transcription, editing, export, backup, and failure recovery.

Do not silently reduce scope. Do not replace difficult requirements with placeholders. If something is blocked by a third-party API limitation, implement the safest truthful behavior and document the limitation.

---

# 1. Overall product vision

The long-term product is a personal transcription and study workstation for university lectures.

A user should be able to:

1. Import a long lecture recording.
2. Keep the original recording safe and untouched.
3. Make multiple nondestructive cuts using a smooth waveform editor.
4. Optionally preview conservative audio cleanup before transcription.
5. Select a course and automatically load that course's reusable vocabulary and transcription defaults.
6. Review the exact transcription settings and estimated cost before spending money.
7. Queue one or many lectures.
8. Close the browser, restart the backend, reboot the computer, or recover from local failures without losing completed transcription work.
9. Transcribe through ElevenLabs Scribe v2 using safe chunk checkpoints.
10. Edit mixed Persian-English text naturally.
11. Correct the transcript while listening to synchronized audio.
12. Switch to a clean document-style transcript view.
13. Organize lectures by course and tags.
14. Search transcript text.
15. Export clean Markdown or plain text.
16. Keep local versioned backups and restore them safely.
17. Understand what requests may have cost money, what was definitely completed, and whether retrying could incur another charge.

The long-term architecture must remain open to:

- local semantic and hybrid search,
- additional transcription providers,
- local speech-to-text models,
- improved forced alignment,
- stronger speaker workflows,
- advanced restoration,
- richer transcript productivity tools,
- optional encrypted remote backup,
- and optional authenticated network deployment.

Those advanced features belong to **Version 2**, in a separate implementation prompt. Version 1 must include the architectural seams required to add them later, but **must not ship V2-only dependencies or features merely "for later."**

---

# 2. Product boundary

Version 1 is:

- single-user,
- localhost-only by default,
- Linux-first,
- Docker Compose based,
- Python/FastAPI powered,
- React/TypeScript powered,
- SQLite backed,
- FFmpeg based for media work,
- ElevenLabs Scribe v2 as the only implemented transcription provider.

It is **not**:

- a multi-user SaaS,
- an offline transcription engine,
- a collaboration platform,
- a cloud storage product,
- a remote-first web app,
- or a generic audio editor.

The app may process audio locally, but transcription audio leaves the machine when sent to ElevenLabs. Never present the application as fully offline.

---

# 3. Non-negotiable invariants

These invariants are release blockers.

## 3.1 Preserve originals

- The uploaded original recording is immutable.
- Nondestructive editing must never overwrite it.
- Audio enhancement must never overwrite it.
- The app must not automatically delete an original recording after transcription.
- Original audio is removed only when the user explicitly chooses the original-audio deletion action.
- That action must use a lightweight confirmation, not a ceremonial multi-step flow.
- Normal temporary transcription chunks are ephemeral and should be automatically deleted after the corresponding provider response is durably stored and the chunk no longer needs them.
- Temporary chunk cleanup must not risk deleting the original.

## 3.2 Preserve provider evidence

- Raw successful ElevenLabs responses are immutable artifacts.
- Persist raw provider output before attempting normalization, transcript assembly, indexing, or editor conversion.
- If local normalization fails later, re-run local normalization from the saved provider artifact.
- Never call ElevenLabs again merely because a local parser failed.

## 3.3 No speculative retries

Treat a transcription POST as a **financial side effect**.

The current ElevenLabs create-transcript API does not expose a documented idempotency key for the create request. Therefore:

- after the application durably records that a provider request has started, assume it may have reached ElevenLabs,
- if the outcome becomes uncertain due to timeout, reset, process death, or machine failure, do **not** automatically retry,
- mark the attempt as `unknown_outcome`,
- pause the sequential queue,
- explain the risk,
- require explicit user authorization before making another provider request for the same chunk,
- and create a new attempt record if the user retries.

A retry must never overwrite the previous attempt.

## 3.4 Durable checkpoints

Every chunk should be independently recoverable.

Completed chunks remain completed after:

- browser refresh,
- browser closure,
- API restart,
- worker restart,
- Docker restart,
- machine reboot,
- local parser crash,
- or later job failure.

Never resubmit a completed chunk unless the user deliberately asks for retranscription.

## 3.5 Honest alignment

Provider word timing and user-edited text are different concepts.

- Preserve provider word timing immutably.
- User edits should modify editable transcript blocks, not provider words.
- When a block is changed, preserve its broad audio anchor when useful but stop claiming exact word-level alignment.
- Use alignment states such as:
  - `provider_exact`
  - `edited_anchor`
  - `unaligned`

Do not fabricate word timing after arbitrary editing.

## 3.6 Secret containment

`ELEVENLABS_API_KEY` is environment-only.

It must never appear in:

- frontend code,
- browser localStorage,
- browser IndexedDB,
- API responses,
- SQLite,
- app settings,
- logs,
- backups,
- diagnostic exports,
- transcript exports.

There is no API-key input field in the UI.

---

# 4. Required technology stack

Use this stack unless a concrete repository constraint makes a small substitution necessary.

## Runtime

- Docker Compose
- Linux host
- React + TypeScript frontend
- FastAPI backend
- separate Python worker process
- SQLite
- Alembic migrations
- FFmpeg and ffprobe
- httpx for provider HTTP
- WaveSurfer.js for waveform interaction
- Lexical with React bindings for transcript editing
- IndexedDB for browser crash drafts
- pytest for backend tests
- Playwright for browser and end-to-end tests

## Do not add in V1

Do not add:

- Redis
- RabbitMQ
- Celery
- PostgreSQL
- Elasticsearch
- Qdrant
- Pinecone
- Faiss
- vector databases
- embedding models
- Soniox integration
- Speechmatics integration
- local Whisper integration
- cloud storage SDKs
- AI speech restoration models

The V1 queue should be database-backed and consumed by a dedicated worker.

---

# 5. Runtime topology

Use three production services:

```text
web
api
worker
```

Optional test-only services are allowed.

## `web`

Responsibilities:

- serve the compiled React frontend,
- reverse proxy `/api`,
- reverse proxy/range-stream media routes if useful.

Host exposure:

```text
127.0.0.1:${APP_PORT}:80
```

Do not bind production access to `0.0.0.0` by default.

## `api`

Responsibilities:

- CRUD,
- uploads,
- metadata,
- audio edit decisions,
- settings,
- queue commands,
- transcript reads and edits,
- search,
- export,
- backup orchestration,
- trash/deletion behavior,
- health and status.

The API must not perform long transcription work inside request-scoped `BackgroundTasks`.

## `worker`

Responsibilities:

- single sequential queue consumption,
- FFmpeg rendering,
- smart chunk planning,
- ElevenLabs requests,
- provider artifact persistence,
- transcript normalization,
- job assembly,
- checkpoint recovery.

No host port.

## Persistent mounts

Support at least:

```text
APP_DATA_DIR=./data
BACKUP_DIR=./backups
```

Suggested mount mapping:

```text
${APP_DATA_DIR} -> /data
${BACKUP_DIR}   -> /backups
```

The SQLite database must live on a local filesystem when WAL mode is used.

---

# 6. Suggested persistent directory structure

Use a clear, safe structure similar to:

```text
/data/
  db/
    app.sqlite3

  media/
    original/
    proxy/
    derived/

  artifacts/
    provider/

  waveform/

  tmp/
    upload/
    preprocess/
    chunks/

/backups/
  objects/
  snapshots/
```

Rules:

- user filenames are metadata only, never trusted filesystem paths,
- generate internal IDs,
- hash important immutable assets with SHA-256,
- use atomic rename patterns for completed files,
- use `fsync` where necessary around high-value provider artifacts,
- clean abandoned temporary files conservatively,
- never clean files still referenced by active/queued work.

---

# 7. SQLite durability requirements

Use SQLite because this is a local single-user application, but treat durability seriously.

Required:

- foreign keys enabled,
- migrations through Alembic,
- WAL mode only on a local filesystem,
- `synchronous=FULL`,
- sensible busy timeout,
- short explicit transactions around state transitions,
- startup integrity/readiness checks.

The runtime must verify that its SQLite build contains the fix for the 2026 WAL-reset corruption issue described in the research report. Do not blindly trust the base image's SQLite version.

If the runtime is not a known-fixed release, fail readiness with an actionable error instead of running unsafely.

---

# 8. Provider architecture

V1 implements only ElevenLabs, but do not wire application logic directly to ElevenLabs response shapes.

Create a provider-neutral interface.

Conceptually:

```python
class TranscriptionProvider(Protocol):
    def validate_settings(...): ...
    def estimate_features(...): ...
    def transcribe(...): ...
    def normalize_response(...): ...
```

Use a provider-neutral internal transcript representation.

The rest of the application should not need to know whether a transcript came from ElevenLabs, Soniox, Speechmatics, or a future local model.

V1 provider:

```text
provider = elevenlabs
model = scribe_v2
```

Preserve the complete raw provider response as an artifact.

---

# 9. ElevenLabs requirements

Implement the current Scribe v2 create-transcript flow.

Default behavior:

- model: `scribe_v2`
- language code: omitted / auto-detect
- word timestamps: requested/preserved
- diarization: off
- expected speaker count: unset unless diarization is enabled
- keyterms: loaded from course preset but reviewed before submission
- multichannel: not used
- provider-side transcript edit: not used
- webhook mode: not the default

Why no webhook default:

This is a localhost-only product. Requiring a public callback or tunnel would violate the simple local deployment model.

Before coding against current API details, check the current official ElevenLabs API documentation and isolate mutable request/pricing behavior behind the provider adapter and pricing configuration.

---

# 10. Upload and original media handling

## Upload

The upload flow must:

1. stream/spool the file instead of loading the entire lecture into memory,
2. write to a temporary path,
3. compute SHA-256,
4. validate media with ffprobe,
5. record codec, duration, channels, sample rate, MIME type, and byte size,
6. atomically move the file into immutable original storage,
7. generate a lightweight playback proxy if useful,
8. generate waveform peak data appropriate for long lectures.

The app should comfortably support lectures around 90 to 120 minutes.

## Original immutability

After import:

- never write into the original file,
- never normalize the original in place,
- never trim it in place,
- never delete it after job completion.

---

# 11. Nondestructive waveform editing

The user chose **multiple nondestructive cuts**.

Use a smooth waveform editor, preferably WaveSurfer.js with region tooling.

Model edits as an Edit Decision List of retained source spans.

Example:

```text
source 00:00:00.000 -> 00:18:42.300
source 00:21:10.500 -> 00:57:31.100
source 01:01:02.000 -> 01:24:55.900
```

Requirements:

- multiple cuts,
- undo/redo,
- preview,
- source remains untouched,
- virtual edited duration updates correctly,
- maintain reversible mapping between virtual time and original source time,
- save EDL state durably,
- do not generate destructive rewritten originals.

The edited virtual timeline is the basis for:

- playback,
- chunk planning,
- timestamp mapping,
- cost estimation,
- optional enhancement,
- transcription.

---

# 12. Optional nondestructive audio enhancement

Enhancement is optional and **off by default**.

Support a conservative curated preprocessing chain such as:

- loudness normalization,
- high-pass / low-frequency filtering,
- conservative denoising.

Do not expose an arbitrary FFmpeg graph in the main UI.

Requirements:

- original remains untouched,
- enhancement produces a derived asset,
- allow before/after A/B preview of the exact same logical time range,
- allow the user to choose whether the clean or enhanced derivative is used for transcription,
- store the selected preprocessing settings in the immutable job settings snapshot.

Do not add neural or AI restoration in V1.

---

# 13. Smart chunking

Default job mode is checkpointed chunking.

Use deterministic smart chunk planning.

Recommended product default:

```text
target chunk duration: about 15 minutes
overlap: none by default
```

"Smart" means:

1. operate on the edited virtual timeline,
2. target approximately the configured duration,
3. search around the target boundary for nearby silence,
4. split on a good silence boundary when possible,
5. use a hard split only when necessary,
6. produce stable ordered chunks,
7. cover the edited timeline exactly once by default.

Do not add overlap by default because it duplicates billable audio and creates deduplication complexity.

Provide an advanced whole-file mode for users who explicitly want it and where provider/file constraints allow it.

The chunk plan must be persisted before provider requests begin.

---

# 14. Chunk state machine

Do not implement the worker as one giant function.

Use a durable state machine.

Recommended chunk/attempt states:

```text
pending
preparing
prepared
request_started
response_received
response_persisted
normalizing
succeeded

failed_local
failed_provider
unknown_outcome
needs_retry_approval
```

Do not collapse:

- `request_started`
- `response_received`
- `response_persisted`

Those distinctions are critical.

---

# 15. Provider attempt safety boundary

Before a provider request:

1. render or reuse the prepared chunk,
2. hash the rendered chunk,
3. compute request settings hash,
4. create an attempt UUID,
5. persist the attempt record,
6. durably set `request_started_at`,
7. only then send the provider request.

On success:

1. receive the response,
2. write raw provider JSON to a temporary artifact file,
3. flush and fsync as appropriate,
4. atomically rename to final provider artifact path,
5. record SHA-256 and artifact metadata,
6. commit `response_persisted`,
7. normalize locally,
8. write provider-neutral timed words,
9. mark chunk succeeded,
10. delete the temporary outbound chunk when safe.

If normalization crashes after step 6, retry only the local normalization.

---

# 16. Unknown-outcome behavior

A provider request becomes uncertain if, after `request_started`, the application loses certainty about whether ElevenLabs completed the request.

Examples:

- HTTP timeout,
- connection reset,
- worker process killed,
- Docker killed,
- host power failure,
- network interruption after the request may have been sent.

Required behavior:

```text
state = unknown_outcome
```

Then:

- never automatically send the same chunk again,
- pause the queue globally,
- show a clear attention state,
- explain that the request may already have been processed and billed,
- allow:
  - retry with explicit approval,
  - cancel/leave unresolved and continue,
- if retrying:
  - create a new attempt,
  - preserve the old one,
  - link `retry_of_attempt_id`,
  - show estimated incremental cost before confirmation.

The UI must never imply that a retry is free.

---

# 17. Startup reconciliation

Worker/API startup must reconcile durable evidence.

Required cases:

- pending chunk -> resume local preparation,
- prepared chunk with no started attempt -> safe to send,
- started attempt with no durable response -> unknown outcome,
- raw provider artifact exists but DB transition was interrupted -> register/reconcile artifact and normalize locally,
- response persisted but tokens missing -> re-run normalizer,
- tokens exist but transcript assembly incomplete -> rebuild locally,
- chunk already succeeded -> skip,
- interrupted temp chunks -> clean only when proven unreferenced.

A machine reboot must not trigger invisible duplicate provider requests.

---

# 18. Persistent sequential queue

The queue is durable and sequential.

Requirements:

- multiple lectures can be queued,
- queue persists in SQLite,
- one provider request at a time,
- reorder waiting jobs,
- pause,
- resume,
- browser may close without stopping backend work,
- Docker/backend restart resumes safe local work,
- pause requested during an in-flight provider call takes effect after that operation,
- do not abort an in-flight provider request merely because the user pressed Pause,
- unknown billing outcome pauses the queue for user attention.

Do not use parallel provider requests in V1.

---

# 19. Courses, lectures, tags, and reusable vocabulary

The library should organize lectures around courses.

Required entities:

- courses,
- lectures,
- tags,
- course vocabulary,
- course transcription presets.

A course can store defaults such as:

- auto language / language code,
- diarization preference,
- expected speaker count if relevant,
- keyterms enabled,
- audio-event preference if supported,
- preprocessing defaults.

When creating a lecture:

1. select a course,
2. load its defaults and vocabulary,
3. show a clean review screen,
4. allow one-off changes,
5. optionally save changed defaults back to the course.

Do not automatically spend money merely because a course was selected. The user still reviews the preflight screen.

---

# 20. Transcription review / preflight screen

Before enqueuing, show one focused confirmation screen containing:

- course,
- lecture title/date,
- edited duration,
- provider,
- model,
- language setting,
- diarization,
- expected speaker count when relevant,
- keyterm count,
- keyterm review,
- preprocessing choice,
- chunked vs whole-file mode,
- estimated number of requests/chunks,
- estimated API usage,
- feature adjustment,
- budget warning,
- provider account/subscription status if safely available,
- estimated incremental payment only when calculable.

Do not scatter this across many settings screens.

---

# 21. Cost guardrails and usage ledger

The user chose **smart guardrails**, not hard enforcement.

## Pricing model

Do not hard-code one forever-price.

Create versioned pricing rules:

```text
provider
model
effective_from
currency
base rate
feature rules
source note
active
```

Historical jobs retain the pricing rule used for their estimate.

Store money using integer micro-units or another fixed-point representation, not binary float.

## Keyterms

The research report notes that current ElevenLabs behavior includes a keyterm surcharge and specific keyterm constraints.

Implementation rule:

- validate current constraints against official docs,
- model feature pricing in versioned rules,
- never assume a surcharge is permanent,
- show any surcharge explicitly.

## Ledger

Every provider attempt gets an accounting/usage row, including:

- success,
- rejection,
- retry,
- uncertain outcome.

Track at least:

```text
attempt_id
job_id
chunk_id
provider
model
endpoint
request_hash
audio_duration_ms
estimated_billable_ms
keyterm_count
features_json
pricing_rule_id
estimated_cost
currency
actual_cost nullable
actual_cost_source nullable
charge_status
attempt_no
retry_of_attempt_id
retry_reason
retry_authorized_at
request_started_at
response_received_at
response_persisted_at
http_status
outcome
provider_transcript_id nullable
raw_response_sha256 nullable
created_at
```

Never fabricate actual vendor billing.

Distinguish:

- app-side estimate,
- app ledger this billing period,
- provider-reported subscription usage,
- actual confirmed charge if available,
- unknown charge status.

Warnings should be smart and informative, not a rigid blocker.

---

# 22. Transcript data model

Keep provider evidence separate from editable transcript state.

## Immutable provider words

Store provider-derived timed words separately.

Suggested fields:

```text
id
transcript_id
chunk_id
ordinal
start_ms
end_ms
text
token_type
provider_speaker_id
logprob nullable
```

## Editable transcript blocks

User editing occurs in blocks.

Suggested fields:

```text
id
transcript_id
ordinal
start_ms nullable
end_ms nullable
text
marks_json
speaker_key nullable
direction_override nullable
alignment_status
updated_at
```

Rules:

- provider words are immutable,
- editable blocks are canonical user-facing content,
- one transcript document feeds both editor views,
- editing a block does not rewrite provider words.

---

# 23. Two transcript views

The user chose **two views backed by one canonical transcript**.

## View A: audio-synced correction

Provide:

- sticky playback controls,
- current position,
- duration,
- playback speed,
- configurable skip backward,
- configurable skip forward,
- passage loop,
- optional 2-second rewind on resume,
- waveform or compact timeline,
- timestamped blocks,
- click timestamp/block to seek,
- current block highlighting,
- transcript auto-follow,
- optional speaker labels,
- keyboard shortcut help,
- visible alignment state where exact timing is no longer valid.

## View B: clean document

Provide a full-width readable transcript with minimal editing chrome.

Support:

- paragraphs,
- headings,
- bold,
- italic,
- inline code / technical spans.

Do not turn V1 into a publishing suite.

Both views edit the same canonical transcript.

---

# 24. Persian-English bidirectional text correctness

This is a core feature, not polish.

Requirements:

- store text in logical Unicode order,
- never reverse Persian/English substrings manually,
- never save visual-order strings,
- default editable block direction to `dir="auto"`,
- allow explicit RTL or LTR override per block,
- use `<bdi>` or equivalent isolation for dynamic opposite-direction inline labels when needed,
- render code/math spans LTR where appropriate,
- use CSS logical properties,
- keep TXT and Markdown exports in logical order,
- do not inject invisible bidi control characters as a routine rendering strategy.

Example mixed content that must behave naturally:

```text
خب، اینجا می‌خوایم مفهوم logical equivalence رو بررسی کنیم.
اگر P → Q داشته باشیم، می‌تونیم اون رو با ¬P ∨ Q مقایسه کنیم.
```

Test punctuation, English acronyms, paths, numbers, code, math, parentheses, and Persian punctuation.

---

# 25. Autosave and revisions

Use two autosave layers.

## Browser crash draft

Use IndexedDB for a recent local draft.

Purpose:

- browser/tab crash recovery,
- short gap protection between keystrokes and server save.

Do not store secrets there.

## Server canonical save

Use debounced API saves with optimistic concurrency.

Every save includes a base revision/version.

If another tab has already advanced the revision:

- do not silently overwrite,
- return a conflict,
- show a recovery/merge choice.

## Revisions

Create immutable transcript revision snapshots for meaningful milestones such as:

- initial import,
- explicit checkpoint,
- before large replace,
- restore operation.

Restoring a revision creates a new current revision. It does not erase history.

---

# 26. Speaker behavior

Most lectures are expected to be one professor with occasional student questions.

Default:

```text
diarization = off
```

Allow per-job opt-in.

Do not assume speaker labels are stable across chunks.

For example, `speaker_0` in chunk 1 is not automatically the same human as `speaker_0` in chunk 2.

V1 speaker tools may allow:

- rename,
- explicit merge,
- display label edits.

Cross-chunk identity decisions must be user-controlled.

Advanced speaker reconciliation belongs to V2.

---

# 27. Full-text search

V1 includes local full-text search, but **not semantic search**.

Use SQLite FTS5.

Search across at least:

- transcript text,
- lecture title,
- course,
- tags where useful.

Persian search must use a derived normalized shadow string.

Support normalization/equivalence such as:

- Arabic Yeh vs Persian Yeh,
- Arabic Kaf vs Persian Kaf,
- Unicode normalization,
- sensible ZWNJ normalization for search.

Do not silently rewrite the user's displayed transcript.

Search results should include:

- lecture,
- course,
- matched snippet,
- timestamp/audio anchor when available,
- click-to-open behavior.

---

# 28. Exports

Support:

- plain text,
- Markdown.

Options may include:

- timestamps on/off,
- speaker labels on/off.

Requirements:

- logical Unicode order,
- no accidental visual-order corruption,
- no secret/provider metadata leakage,
- clean readable output.

DOCX and PDF publishing are out of V1 scope.

---

# 29. Backups

Implement automatic versioned local backups to a configurable host directory.

The API key and `.env` must never be backed up.

## Backup contents

At minimum:

```text
snapshot.json
app.sqlite3
artifacts/
checksums.sha256
```

Optionally include media according to user policy.

Original-audio inclusion must be configurable because lecture archives can become large.

## Live database backup

Do not copy the active SQLite DB file naively.

Use SQLite's safe online backup mechanism or an equivalent consistent snapshot procedure.

## Verification

Every new backup should be verifiable.

Verification includes:

- manifest validation,
- checksums,
- opening/integrity-checking the backup DB,
- ensuring referenced included artifacts are present.

A backup is not "verified" merely because a directory exists.

## Restore

Restore flow must:

1. pause queue,
2. refuse restore during an in-flight provider call,
3. verify selected snapshot,
4. create a pre-restore snapshot when possible,
5. enter maintenance/read-only mode,
6. restore into temporary locations,
7. validate,
8. atomically swap,
9. restart/reopen,
10. run startup reconciliation.

---

# 30. Deletion and storage behavior

The user's storage rule is simple:

- temporary transcription chunks are disposable,
- original recordings are not.

## Temporary chunks

After a successful provider response is durably persisted and the chunk is no longer needed for local recovery:

- delete the rendered temporary chunk automatically.

No user confirmation is required for routine ephemeral chunk cleanup.

## Original audio

Never auto-delete it.

Expose a lecture-level action:

```text
Delete original audio
```

Use a lightweight confirmation.

Example:

```text
Delete the original recording?
The transcript and any retained playback proxy will remain.
```

If the product retains a recoverable trash layer for live assets, make the behavior explicit and keep the confirmation light. Permanent purge may use one stronger confirmation.

If original audio is needed by an active or queued transcription job, block deletion until that work is canceled or completed.

Also make clear that removing live data does not retroactively erase copies inside older backup snapshots.

---

# 31. Focused workspace UI

Use the selected **focused workspace** design.

Primary navigation:

```text
Library
Audio Preparation
Transcript Editor
```

Secondary surfaces:

```text
Queue
Backups
Settings
```

The interface should feel clean and technically serious, not like a generic admin dashboard.

Avoid:

- excessive cards,
- giant KPI dashboards,
- dozens of persistent panels,
- decorative complexity,
- hiding core actions in nested menus.

Include:

- dark mode,
- light mode,
- good keyboard navigation,
- visible focus states,
- responsive behavior,
- status not encoded by color alone.

---

# 32. Required screens

Implement at least:

## Library

Show:

- courses,
- lecture list,
- tags,
- status,
- search,
- transcript readiness,
- upload/create actions.

## New lecture / upload

Fields:

- course,
- title,
- date,
- tags,
- file drop/upload,
- upload progress.

## Audio Preparation

Show:

- waveform,
- cuts/retained ranges,
- undo/redo,
- duration,
- processing toggle,
- A/B preview.

## Transcription Review

Show:

- course preset,
- vocabulary,
- language,
- diarization,
- mode,
- chunk estimate,
- cost card,
- warnings,
- enqueue action.

## Queue

Show:

- ordered jobs,
- current lecture,
- chunk progress,
- waiting jobs,
- reorder,
- pause/resume,
- attention-required unknown attempts.

## Synced Editor

As specified above.

## Document Editor

As specified above.

## Backups

Show:

- snapshot history,
- status,
- size,
- verification,
- include-audio policy,
- backup now,
- restore.

## Settings

Show only nonsecret settings.

For ElevenLabs:

```text
Status: Connected | Invalid | Not configured | Unavailable
Credential source: ELEVENLABS_API_KEY environment variable
[Test connection]
```

No key field.

---

# 33. Suggested backend API surface

Concrete route naming may evolve, but support equivalent capabilities.

```text
GET    /api/v1/health
GET    /api/v1/system/status

GET    /api/v1/provider/status
POST   /api/v1/provider/test
GET    /api/v1/provider/subscription

GET    /api/v1/settings
PATCH  /api/v1/settings

GET    /api/v1/budget
PATCH  /api/v1/budget

GET    /api/v1/courses
POST   /api/v1/courses
GET    /api/v1/courses/{id}
PATCH  /api/v1/courses/{id}
DELETE /api/v1/courses/{id}

GET    /api/v1/courses/{id}/vocabulary
PUT    /api/v1/courses/{id}/vocabulary

GET    /api/v1/tags
POST   /api/v1/tags

GET    /api/v1/lectures
POST   /api/v1/lectures
GET    /api/v1/lectures/{id}
PATCH  /api/v1/lectures/{id}

POST   /api/v1/lectures/{id}/audio
DELETE /api/v1/lectures/{id}/original-audio

GET    /api/v1/media/{id}
GET    /api/v1/media/{id}/peaks

PUT    /api/v1/lectures/{id}/edl

POST   /api/v1/lectures/{id}/preprocess-preview
PUT    /api/v1/lectures/{id}/preprocess

POST   /api/v1/jobs/estimate
POST   /api/v1/jobs
GET    /api/v1/jobs/{id}
POST   /api/v1/jobs/{id}/retry

GET    /api/v1/queue
PATCH  /api/v1/queue/order
POST   /api/v1/queue/pause
POST   /api/v1/queue/resume

GET    /api/v1/transcripts/{id}
PATCH  /api/v1/transcripts/{id}

GET    /api/v1/transcripts/{id}/revisions
POST   /api/v1/transcripts/{id}/revisions/{revision}/restore

GET    /api/v1/search

GET    /api/v1/lectures/{id}/export

GET    /api/v1/backups
POST   /api/v1/backups
POST   /api/v1/backups/{id}/verify
POST   /api/v1/backups/{id}/restore
```

If using a trash model:

```text
GET    /api/v1/trash
POST   /api/v1/trash/{id}/restore
DELETE /api/v1/trash/{id}
```

Use range-capable media streaming for long audio playback.

---

# 34. Suggested database model

Use UUID/ULID-style application identifiers and UTC persistence timestamps.

Implement equivalent tables to:

```text
courses
course_vocabulary
course_presets

tags
lecture_tags
lectures

media_assets
audio_edit_segments

pricing_rules

transcription_jobs
transcription_chunks
chunk_source_spans

provider_attempts
provider_artifacts
usage_ledger

transcripts
transcript_words
transcript_blocks
speaker_labels
transcript_revisions

backup_snapshots

app_settings
```

## Important schema rules

- `app_settings` cannot contain secrets.
- provider artifacts reference immutable files.
- job settings are captured as immutable snapshots.
- job vocabulary is captured as an immutable snapshot.
- completed provider attempts remain auditable.
- deleting a lecture/transcript should not silently erase accounting history that is still required to explain provider attempts.
- media assets distinguish:
  - original,
  - proxy,
  - enhanced/derived,
  - temporary chunk.

Consider explicit `ephemeral` and lifecycle fields for media assets.

---

# 35. Logging and privacy

No app analytics or telemetry.

Logs may include:

- internal IDs,
- durations,
- status transitions,
- timing,
- error class,
- redacted provider error metadata.

Logs must not include:

- API key,
- full transcript bodies by default,
- raw audio,
- secrets.

Do not claim provider zero-retention unless the user's provider account/API mode actually guarantees it.

---

# 36. Error handling

Errors must be classified.

Examples:

```text
validation
local_media
storage
database
provider_rejected
provider_auth
provider_unavailable
unknown_provider_outcome
normalization
backup
restore
editor_conflict
```

UI messages should explain what happened and what the safe next action is.

Especially for transcription attempts, distinguish:

- safe local retry,
- provider explicitly rejected,
- provider outcome unknown,
- local post-processing failure after successful response.

Do not put them all behind a generic "Retry" button.

---

# 37. Testing philosophy

The test suite should be failure-oriented.

A happy-path transcript is insufficient.

The app is not ready until it behaves correctly under interruption.

Use:

- pytest,
- mocked provider adapter,
- controllable fake ElevenLabs server,
- test-only fault proxy where useful,
- Playwright.

Every provider/network failure test must assert the number of observed transcription POSTs.

"The job eventually succeeded" is not enough if the audio was secretly submitted twice.

---

# 38. Required acceptance tests

Implement automated coverage for at least the following.

## Deployment and secrets

1. Production Compose exposes only the web service to loopback.
2. Missing API key leaves the local app usable but transcription disabled.
3. Invalid and valid provider credentials produce safe status results.
4. API key is absent from:
   - frontend bundle,
   - browser storage,
   - API payloads,
   - SQLite,
   - logs,
   - backups.

## Upload and media

5. Upload a fixture and record original hash.
6. Make cuts and preprocessing previews.
7. Original SHA-256 never changes.
8. Multiple cuts create correct virtual duration.
9. Source-time mapping remains reversible.

## Chunking

10. Long edited lecture produces stable ordered chunks.
11. No unintentional overlap.
12. Entire virtual timeline covered exactly once.

## Queue

13. Queue five lectures.
14. At most one provider transcription request is active.
15. Reordering survives restart.
16. Pause during in-flight request does not cancel the request.
17. Resume skips completed chunks.

## Failure recovery

18. Kill worker during local FFmpeg preparation.
19. Restart safely without provider duplication.
20. Kill worker after `request_started`.
21. Chunk becomes `unknown_outcome`.
22. Zero automatic retranscription POSTs occur.
23. Simulate server accepting request then dropping connection.
24. Same unknown-outcome behavior.
25. Persist successful raw response, kill process before normalization.
26. Restart reparses locally without a new provider POST.
27. Explicit retry creates a new attempt and ledger row.

## Cost

28. Estimate screen reflects selected features using versioned rules.
29. If pricing configuration is unavailable, show partial/unknown cost instead of inventing a number.
30. Retry warning shows incremental estimated cost risk.

## Transcript provenance

31. Complete a transcription.
32. Heavily edit it.
33. Raw provider JSON unchanged.
34. Provider words unchanged.
35. Editable blocks changed.

## Editor

36. Edit in synced view.
37. Switch to document view.
38. Same canonical content appears.
39. Rewrite a timed block.
40. Block stays seekable by broad anchor but becomes `edited_anchor`.

## Persian/English bidi

41. Test Persian with English technical terms.
42. Test math, punctuation, paths, numbers, parentheses, code.
43. Stored logical order remains unchanged.
44. Rendering is readable.
45. Explicit RTL/LTR override changes presentation only.

## Autosave

46. Type then terminate browser.
47. Recover recent draft or latest server revision.
48. Two-tab stale save returns conflict instead of overwriting.

## Search

49. Search Persian terms.
50. Search Arabic/Persian Yeh and Kaf variants.
51. Return matching timestamped passages.

## Export

52. TXT export preserves logical order.
53. Markdown export respects timestamp/speaker options.

## Backup

54. Back up while browsing/editing.
55. Snapshot is consistent and verifiable.
56. Corrupt a checksum.
57. Restore is refused.
58. Restore valid fixture.
59. Data returns consistently.
60. Restore attempt during an in-flight provider call is blocked.

## Original deletion

61. Complete a transcript.
62. Trigger original-audio deletion.
63. Lightweight confirmation appears.
64. After confirmed deletion, transcript remains.
65. If playback proxy remains, playback still works.
66. If original is still required by queued/active work, deletion is blocked.

## Temporary chunks

67. Complete a chunk.
68. Raw provider response is durably stored.
69. Temporary outbound chunk is automatically removed.
70. Original is still present.

## SQLite runtime

71. Start test image with a deliberately unacceptable SQLite runtime.
72. Readiness fails with actionable explanation.

---

# 39. Implementation order

Build in risk order, not visual order.

## P0: data and financial safety

1. repository structure,
2. Docker Compose topology,
3. health checks,
4. fixed runtime dependencies,
5. SQLite bootstrap and migrations,
6. local filesystem model,
7. immutable media/original storage,
8. provider abstraction,
9. mocked provider,
10. provider attempt state machine,
11. raw artifact persistence,
12. startup reconciliation,
13. duplicate-billing protection,
14. usage/cost ledger,
15. persistent sequential worker/queue,
16. upload and ffprobe validation.

Do not proceed to polishing the UI before these have automated tests.

## P1: complete V1 workflow

17. waveform proxy and peaks,
18. nondestructive cuts,
19. smart chunk planner,
20. ElevenLabs Scribe v2 adapter,
21. course/tag/vocabulary model,
22. transcription review screen,
23. cost guardrails,
24. canonical transcript importer,
25. synced editor,
26. document editor,
27. autosave and revisions,
28. FTS5 Persian search,
29. optional FFmpeg enhancement,
30. TXT/Markdown export,
31. original-audio deletion UI,
32. automatic temporary chunk cleanup,
33. backups and restore,
34. failure-injection tests.

## P2: refinement

35. dark/light mode,
36. responsive layout,
37. keyboard accessibility,
38. shortcut configuration,
39. operational documentation,
40. performance cleanup.

---

# 40. Repository and code-quality expectations

Use a clear monorepo structure.

For example:

```text
/
  compose.yaml
  .env.example
  README.md

  frontend/
  backend/
    app/
    worker/
    tests/
    migrations/

  test/
    fixtures/
    fault_proxy/
```

Keep business logic out of route handlers.

Use service/repository layers where they make state transitions clearer, especially around:

- provider attempts,
- artifact persistence,
- queue transitions,
- backup restore,
- transcript revisions.

Prefer explicit boring code over clever abstractions in financial/durability paths.

Type the frontend strictly.

Use Pydantic models for API contracts.

Use migration-tested schema changes.

---

# 41. Operational documentation

Provide a useful README covering:

- prerequisites,
- Docker Compose startup,
- `.env` configuration,
- `ELEVENLABS_API_KEY`,
- `APP_DATA_DIR`,
- `BACKUP_DIR`,
- first run,
- provider test,
- backup behavior,
- restore behavior,
- update procedure,
- failure states,
- unknown-outcome semantics,
- cost estimate limitations,
- original-audio deletion behavior,
- where data lives.

Include `.env.example` without secrets.

---

# 42. V2 boundary

Version 1 must stop here.

Do not implement these in V1:

- vector embeddings,
- semantic search,
- hybrid dense retrieval,
- Soniox,
- Speechmatics,
- local Whisper or other local ASR,
- automatic provider comparison,
- forced-alignment repair,
- automatic cross-chunk speaker identity reconciliation,
- neural audio restoration,
- advanced revision diff UI,
- study/flashcard generation,
- encrypted cloud/NAS sync,
- authenticated LAN/public deployment.

However, V1 architecture must not make these unnecessarily difficult later.

In particular:

- provider adapter is required,
- provider-neutral transcript schema is required,
- canonical editable transcript is separate from provider words,
- search code should have a clean seam for future hybrid search,
- media derivatives should have explicit types,
- backup snapshots should be versioned,
- API routes should be versioned.

---

# 43. Definition of done

Version 1 is done only when all of the following are true:

1. A 90 to 120 minute lecture can be uploaded, edited nondestructively, reviewed, queued, transcribed, corrected, searched, exported, backed up, and restored.
2. Original audio is preserved unless the user explicitly deletes it.
3. Temporary transcription chunks are cleaned up automatically after they are safely disposable.
4. The app can survive browser closure and process restarts.
5. A completed chunk is never invisibly retranscribed.
6. Unknown provider outcomes never trigger automatic retries.
7. Every provider attempt is auditable.
8. Raw provider results are preserved.
9. Persian-English mixed text edits correctly.
10. Both transcript views share one canonical document.
11. Full-text search works locally.
12. Backup verification and restore work.
13. The API key remains secret and environment-only.
14. All P0 and P1 acceptance tests pass.
15. There are no unresolved data-loss, duplicate-request, or secret-leakage defects.

The central release criterion is this:

> After any simulated failure at any point in a multi-hour lecture, the application must be able to explain exactly what audio was submitted, which chunks are definitely complete, which provider attempts may have cost money, what data is safely stored, and whether pressing Retry could create another charge.

Build toward that criterion first. Everything else sits on top of it.
