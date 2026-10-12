# V1 acceptance evidence

Validated in the implementation workspace on 2026-10-11. The specification is
[v1-specification.md](v1-specification.md). Tests exercise the actual SQLite,
FFmpeg, API, worker, and browser paths. Transcription uses either a counted fake
adapter or a controllable local HTTP vendor server; no live paid request was made.

## Executed checks

- Backend: `LECTRA_LONG_TEST=1 PYTHONPATH=backend .venv/bin/pytest backend/tests --maxfail=2` — **75 passed**, no skipped tests. One upstream Starlette test-client deprecation warning.
- Browser: `npm --prefix frontend test` — **14 passed** against Chromium, the real API/worker, and FFmpeg.
- Frontend: strict TypeScript compilation and Vite production build passed.
- Backend: Ruff lint and formatting checks passed.
- Dependencies: locked Python/npm installation and repeated `scripts/install.sh` succeeded; npm audit reported no vulnerabilities.
- Both production Docker images built successfully. Compose was started with isolated validation data; API/worker readiness, shortcut defaults, upload, FFmpeg proxy creation, HTTP range playback, saved cuts, concurrent genuine clean/enhanced previews, reviewed estimate hashes, the missing-key spending gate, and verified backup/restore all passed. The restored original hash matched. Only web is published, on loopback. Validation containers were stopped after the checks.
- Native `scripts/dev.sh` was exercised with isolated data: API and Vite-proxied readiness, independent worker heartbeat, initial verified automatic backup, and coordinated shutdown.
- A production backend container deliberately selecting system SQLite 3.40.1 failed readiness with HTTP 503 and an actionable WAL-reset explanation. The pinned image uses SQLite 3.53.1 and passed readiness.

The 2026-10-12 restricted-key fix was checked separately with **22 targeted
backend tests**, the complete **15-test browser suite**, strict TypeScript/Vite
build, and Ruff. The browser case proves that account/subscription checks can
return restricted while a separately approved transcription succeeds; no
transcription POST occurs during either account check. A Compose startup with
an absent backend image tag built it locally, started healthy services without
a Docker Hub pull denial, and passed production health/credential-presence
checks. Validation containers were stopped afterward. No live paid provider
request was made.

The 2026-10-12 audio preparation update passed the full **88-test backend
suite**, including the real two-hour FFmpeg pipeline, and the full **20-test
Chromium browser suite**. Five new browser cases cover graphical selection and
handle resizing, synchronized millisecond fields, playhead markers, preview
endpoints after seeking, playback skipping cuts, auditioning different removed
sections, undo/redo and restoration, durable source-time spans, invalid cuts,
keyboard controls, mobile layout, and a real one-hour recording with a cut near
the hour mark. Original hashes remain unchanged. Legacy waveform caches are
upgraded to finer, bounded peak data and reused. Dark/light/mobile screenshots
were inspected. Ruff, formatting checks, and the production TypeScript/Vite
build passed. Both production Docker images were rebuilt; Chromium against the
running Nginx/API/worker stack verified upload, precise clock, selection
preview, visible cuts, undo/redo, and durable save with an unchanged original
hash. Validation containers were stopped afterward. No live paid provider
request was made.

The subsequent 2026-10-12 diagnostics and UI refinement passed **99 backend
tests** (including the real two-hour media run) and **23 browser tests**. The
new evidence covers HTTP 401 permission/quota/credential reasons, safe redaction
and bounded malformed-error fallback, recorded request IDs, no automatic
resubmission, and an older-schema backup restored without losing newer error
or billing evidence. The account check and last transcription outcome are
displayed independently. Browser media-play instrumentation confirmed that
checked effects use the processed file in the main transport, preserve source
time, and have loading, failure, and retry states. Graphical selection dismissal,
opaque red cut bands, numeric bounds/decimal stepping and persistence, optional
speaker fields, both themes, and mobile dialog layout passed. Original audio
hashes remain unchanged. Production builds and Ruff/format checks passed.
Chromium against the production Nginx/API/worker stack verified migration of
existing data, selection dismissal, effects in the main player, precise preview,
red cuts, undo/redo, durable save, credential/transcription status separation,
and numeric stepping. Validation services were stopped afterward.

The Scribe v2 endpoint, fields, language/speaker limits, and repeated keyterms
were checked against the current official generated Python SDK documentation
and multipart adapter. The documentation website was unavailable from this
workspace; the official SDK reference and source were fetched from GitHub.
HTTP 401 alone does not identify the user's original rejection reason, and the
old app discarded its response body. New attempts retain safe diagnostics.
No live paid provider request was made.

## Specification coverage

The numbers below refer to the 72 acceptance requirements in section 38.

| Requirements | Automated evidence |
| --- | --- |
| 1–4: topology, credential status and containment | `backend/tests/test_deployment.py`, `test_app.py`, `test_provider.py`; browser credential-storage test |
| 5–9: original hash, cuts, previews, reversible timeline | `test_durability.py`, `test_long_lecture.py`, `test_waveform.py`; `audio-preparation.spec.ts` and complete browser workflow |
| 10–12: stable chunks, no overlap, full timeline | `test_durability.py`, `test_long_lecture.py` |
| 13–17: five-job queue, single request, restart/order, pause/resume | `test_durability.py`, `test_processes.py`; counted browser vendor |
| 18–27: FFmpeg/request/artifact interruption, no automatic POST, explicit retry | `test_processes.py` real SIGKILL cases; `test_durability.py` checkpoint cases; `test_provider.py` accepted-then-dropped connection/timeout/5xx/4xx cases; browser unknown-outcome test |
| 28–30: pricing snapshots, unknown cost, incremental retry warning | `test_app.py`; browser preflight and unknown-outcome tests |
| 31–35: edits preserve raw bytes and provider words | `test_durability.py`, `test_app.py`; browser workflow |
| 36–40: shared canonical views, rich edits and honest anchors | `test_app.py`; browser workflow and rich-formatting test |
| 41–45: Persian/English, punctuation, math, paths, logical order, direction overrides | `test_app.py`; mixed-script browser workflow with explicit RTL override and canonical text assertions |
| 46–48: abrupt tab loss, draft recovery, stale-tab conflict | IndexedDB closure and two-tab Playwright tests; server revision-conflict tests |
| 49–51: Persian normalization and timestamped results | `test_app.py`; browser search-to-passage workflow |
| 52–53: TXT/Markdown, logical order and export options | `test_app.py`; rich Markdown browser test |
| 54–60: online snapshots, verification, corruption refusal, restore/in-flight guard | `test_app.py`; browser backup/restore tests; real restore process-death rollback test |
| 61–66: confirmed original deletion, transcript/proxy retention, unfinished-job guard | `test_app.py`; complete browser workflow |
| 67–70: durable raw evidence, temporary cleanup, original retention | `test_durability.py`, `test_provider.py`, `test_long_lecture.py` |
| 71–72: unacceptable SQLite image/readiness | `test_app.py` runtime version and HTTP readiness tests, plus actual container check described above |

Additional safety tests cover missing credentials before the request boundary,
local preparation retry, raw artifacts surviving an incorrect unknown-outcome
classification, immutable attempt settings, restoring without rewinding billing
evidence, restoring pending work with explicit reauthorization, revision history,
omitted originals, maintenance-marker recovery, foreign-origin writes, and
range-capable proxy playback.

The second audit added 12 backend cases and six browser workflows covering
unregistered evidence during restore, completed untimed responses, stale/missing
preflight approval, deliberate retranscription, concurrent media generation,
speaker revision conflicts, shortcut preferences, genuine A/B output,
credential-safe account fields, prompt maintenance responses, unavailable
IndexedDB, independent tab drafts, paragraph autosave, immediate export,
formatting-only restore, and changed-price confirmation. Browser completion
assertions identify the specific lecture rather than whichever job was last
visible. The full feature checklist and prioritized repairs are in
[v1-audit.md](v1-audit.md).

## Long recording and interruption checks

The opt-in test generates a real two-hour compressed audio fixture, uploads it,
makes two cuts, and verifies a 7,140,000 ms edited timeline. Eight ordered chunks
are rendered and submitted to the counted fake provider. Editing, search,
exports, verified backup, and restore complete with the original SHA-256
unchanged and no remaining outbound chunk files.

Process tests kill actual worker subprocesses during local preparation, running
FFmpeg, the durable request-start boundary, artifact persistence, and response
registration. Recovery preserves request counts and never repeats a completed
request. A separate restore subprocess dies between directory swaps; startup
uses the journal to recover the prior coherent data. These are process-crash
checks; this validation does not simulate physical disk failure or a host power
cut.

## External limits

The implemented ElevenLabs multipart contract, account checks, keyterms, and
word normalization are tested against controlled HTTP responses. Real vendor
audio quality, account entitlement, language accuracy, and actual billing remain
external acceptance checks. The UI labels uncertain cost and billing honestly;
it never treats estimated ledger amounts as a confirmed invoice. See
[provider-contract.md](provider-contract.md) for the upstream contract and
revalidation guidance.

Mixed-script text is tested for unchanged logical Unicode order and rendered in
Chromium with auto/explicit direction controls. Font-dependent typography and
real lecture transcription quality still benefit from a human review on the
user's display and account.

Cloud installation and startup instructions were saved as an environment
configuration draft. Saving a draft does not publish an environment or prove
fresh-task restoration; review/save and publication are separate user actions.
