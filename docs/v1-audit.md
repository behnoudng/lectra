# Second V1 audit

The master prompt was reread in full, including all 72 acceptance items and the
definition of done. The audit inspected the API, worker, storage, migrations,
media processing, editor, browser drafts, deployment, and existing tests. Six
backend failures were reproduced before patching them. The main V1 workflows
are implemented; the omissions and defects below were repaired in place.

## Prioritized findings and repairs

| Priority | Confirmed problem | Repair and regression evidence |
| --- | --- | --- |
| P0 | Restore could discard a raw response whose database registration failed. Reconciliation could duplicate a completed untimed passage after correction. | Restore reconciles durable files before collecting evidence; artifact registration preserves succeeded chunks. The restore and untimed-response regressions assert retained edits/artifacts and observed POST counts. Both sides of restore directory swaps are fsynced. |
| P0 | Enqueue was not bound to the cuts, settings, and price shown at preflight. New jobs could bypass failed work and charge again for completed chunks. | Reviewed hashes and an enqueue transaction context check reject stale reviews. Unfinished jobs must be retried/canceled; completed audio requires explicit retranscription approval. Backend regressions and the changed-price browser test assert no unapproved request. |
| P0 | Browser storage failure prevented transcript loading. Tabs overwrote/deleted each other's shared draft. | Server loading survives unavailable IndexedDB. Sessions own independent drafts; recovery can select among retained drafts. Serialized draft mutations and conditional cleanup preserve other tabs. Browser tests deny storage and recover two independent unsaved tabs. |
| P1 | Empty paragraphs did not autosave, export could omit pending edits, and formatting-only restore left old formatting visible. | Structural edits use the normal draft/debounce path. Export waits for saves and refuses unresolved conflicts or failed saves. Lexical synchronization compares formatting as well as text. Three browser regressions cover these paths. |
| P1 | Concurrent requests could render/register the same preview twice, replacing a referenced file or causing a uniqueness error. | Per-asset OS locks serialize creation and reuse completed assets; proxy creation uses the same approach. A threaded regression verifies one render/asset and an unchanged original. |
| P1 | Successful parser recovery left a job stuck in `failed_local` with no failed chunk to retry. | Locally recovered jobs return to the queue only if no chunk still needs attention. Remaining originally authorized chunks resume; completed chunks are skipped. The regression asserts total POST counts. |
| P2 | Shortcut configuration was missing and skip directions shared one distance. | Settings now offer supported alternative shortcuts and independent skip distances. Existing settings receive defaults without a schema-breaking migration. API/browser tests cover validation, persistence and playback. |

Additional repairs:

- A/B preview applies cleanup on the enhanced side even when enhanced
  transcription remains unselected.
- Speaker edits use optimistic revisions and wait for pending text saves.
- Account fields have type checks and reject nested or echoed credentials.
- Restore staging returns prompt HTTP 503 maintenance responses instead of
  blocking the API event loop; the UI reports a failed pre-restore backup.
- Startup readiness checks foreign keys as well as database integrity.
- Search indexes the latest canonical transcript; metadata-only results open
  the lecture rather than an empty editor.

## Main-feature checklist

| Master sections | Implemented capability and primary source |
| --- | --- |
| 1–6 | Local Linux Compose app; loopback web; independent API/worker; persistent local data/backup mounts. Compose, Dockerfiles, config/storage services. |
| 3, 7 | Immutable originals/provider words/artifacts; explicit deletion; fixed SQLite readiness, WAL/FULL/foreign keys, atomic migrations and writes. DB, migrations, media/library/storage services. |
| 8–9 | Provider-neutral interface; only Scribe v2 implemented; auto language, word timestamps, optional diarization/keyterms/events. Provider adapter/contracts. |
| 10–13 | Spooled uploads, metadata/hash/proxy/peaks; multiple cuts, undo/redo, reversible timelines; real A/B cleanup; stable silence-aware chunks and capped whole-file mode. Media service/audio preparation. |
| 14–18 | Durable checkpoints, sequential worker, artifact-first recovery, globally paused unknown outcomes, explicit counted retries, persistent ordering and graceful pause. Queue/worker services and queue UI. |
| 19–21 | Courses/tags/vocabulary/presets, one-off review and save defaults, exact preflight, versioned fixed-point pricing, advisory budgets and attempt ledger. Library/pricing/queue services; dialogs/review/settings. |
| 22–26 | Immutable words and editable canonical blocks; synced/document views, rich text, playback controls, edited anchors, bidi isolation/direction, drafts/conflicts/revisions, chunk-scoped speakers. Transcript/Lexical components. |
| 27–28 | FTS5 Persian shadows, canonical snippets/audio anchors, metadata search, TXT/Markdown and save-before-export. Transcript/richtext services and library/editor UI. |
| 29–30 | Scheduled/manual online backups, optional originals, checksums/reference validation, pre-restore attempt, journaled swaps, retained billing evidence, explicit original deletion and disposable chunks. Backup/library/worker services and backup UI. |
| 31–32 | All required screens; dark/light mode, responsive navigation, keyboard focus and textual statuses. React components/styles. |
| 33–36 | Equivalent versioned API/schema, environment-only credentials, safe errors/account responses, localhost boundary and no app telemetry. API/contracts/migrations/deployment. |
| 37–40 | Failure tests, counted POSTs, actual process kills, actual long media, strict TS and service layers. Backend/Playwright tests and fake vendor. |
| 41 | Prerequisites, startup/update/configuration, first lecture, recovery, backups, cost/deletion/storage documentation. README, provider/acceptance docs and setup scripts. |
| 42 | V2 engines, brokers, search models, cloud storage, neural restoration and public authentication dependencies remain excluded. Provider-neutral seam is retained. |
| 43 | Two-hour fixture covers the full local workflow using a counted fake provider; worker/restore crash tests preserve checkpoints/evidence. External limits below remain explicit. |

## Verification and limits

See [acceptance.md](acceptance.md) for executed validation and the mapping of all
72 acceptance items. Audit regressions live in `backend/tests/test_audit.py`
and `frontend/tests/workflow.spec.ts`.

The fake vendor validates serialization, outcomes, parsing and request counts.
Real lecture accuracy, account entitlement and actual billing remain external
checks. No paid request was sent. Process-kill tests cover crash boundaries;
they do not simulate physical disk failure. V2 exclusions remain deliberate.
