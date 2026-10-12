# Provider and runtime contracts

Checked 2026-10-11 against the official ElevenLabs generated Python API reference:

- [Official conversion client and parameter documentation](https://github.com/elevenlabs/elevenlabs-python/blob/fbe5daf0108133f2554fa6b0bb5edc943cefb941/src/elevenlabs/speech_to_text/client.py)
- [Official raw client / multipart request shape](https://github.com/elevenlabs/elevenlabs-python/blob/fbe5daf0108133f2554fa6b0bb5edc943cefb941/src/elevenlabs/speech_to_text/raw_client.py)
- [Public API documentation](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

The public documentation site was blocked by this environment’s network proxy; the official generated reference was retrieved successfully from the upstream repository. The adapter uses synchronous `POST /v1/speech-to-text`, `model_id=scribe_v2`, word timestamps, `diarize=false` by default, optional ISO language, optional audio-event tags, and repeated multipart keyterm fields. Speaker count is only sent with diarization, within 1–32. Webhooks, multi-channel, provider-side editing, remote URL import, and automatic POST retries are disabled.

Keyterms: maximum 1,000; each fewer than 50 characters and at most five normalized words; `<> {} [] \\` forbidden. Documented feature adjustment is 20%, with a minimum 20-second request duration over 100 keyterms. Settings validate these constraints; versioned pricing rules retain their own adjustment/minimum. No default monetary base rate is assumed.

The provider-neutral protocol returns raw bytes before normalization. Only the adapter knows the vendor response shape. All exceptions after the durable started boundary are conservative unless the provider explicitly returns a 4xx rejection. 5xx, timeouts, connection reset/drop, redirects, and process death require outcome review. Rejections still have a ledger row; no zero-charge assertion is made. Missing credentials are detected before the boundary.

Read-only connection and subscription checks use `/v1/user` and `/v1/user/subscription`. The API returns an explicit allowlist, never the complete account response or credentials. Test-only adapters and servers can be injected through Python constructors; production settings expose no alternative provider URL.

### Restricted-key account checks

Checked 2026-10-12 against the official SDK's
[permission names](https://github.com/elevenlabs/elevenlabs-python/blob/fbe5daf0108133f2554fa6b0bb5edc943cefb941/src/elevenlabs/types/permission_type.py),
[user endpoint](https://github.com/elevenlabs/elevenlabs-python/blob/fbe5daf0108133f2554fa6b0bb5edc943cefb941/src/elevenlabs/user/raw_client.py),
and [subscription endpoint](https://github.com/elevenlabs/elevenlabs-python/blob/fbe5daf0108133f2554fa6b0bb5edc943cefb941/src/elevenlabs/user/subscription/raw_client.py).
The public documentation/API hosts remain blocked by this runner's proxy;
official GitHub references were retrieved successfully.

`speech_to_text` (Speech to Text → Access) authorizes transcription.
`user_read` (User → Access in the key editor) is needed for optional account
reads. No other endpoint scopes are used by Lectra. An account check can return
HTTP 401 or 403 with `detail.status=missing_permissions`; this is classified as
Restricted. An explicit `invalid_api_key` is Invalid. Unspecified 401/403 errors
remain Unauthorized/Access denied rather than assuming their cause.

Responses expose only fixed explanatory messages, a known reason when present,
credential presence, and `transcription_verified=false`; they never echo the
remote error message/body or credential. Account success establishes account
access only. No paid transcription is sent as a connectivity probe.

## SQLite

The production image builds [official SQLite 3.53.1](https://github.com/sqlite/sqlite/tree/version-3.53.1), after the March 2026 WAL-reset correction. It verifies the source archive SHA-256:

`71e13e0fa5b925b28a7c5b5515079e8ec21c739b1ddc9cbb87e6524626317c15`

Readiness checks the actual Python-linked SQLite runtime, not just the installed CLI. Releases before the fixed backport 3.51.3 and the preceding 3.52.0 release are refused. The image asserts exactly 3.53.1. The test image’s original system SQLite 3.40.1 was selected via its dynamic library path and correctly returned HTTP 503 with an actionable WAL-reset explanation.

Builds preserve TLS, package signatures, and source checksums. Optional `cloud_ca` BuildKit secrets support this cloud runner’s existing trusted CA bundle without disabling verification. The cloud runner additionally requires its existing proxy hostname mapping and proxy build arguments; these are runner-specific build options, not production network bindings.
