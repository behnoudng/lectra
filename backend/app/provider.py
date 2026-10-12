"""Mutable vendor contract lives here; the rest of the app consumes neutral words."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
import json
import math
import os
import httpx
from .contracts import TranscriptionSettings
from .errors import AppError


@dataclass(frozen=True)
class TimedWord:
    text: str
    start_ms: int | None
    end_ms: int | None
    token_type: str
    speaker: str | None
    logprob: float | None = None


@dataclass(frozen=True)
class NeutralTranscript:
    text: str
    words: list[TimedWord]
    provider_id: str | None


@dataclass(frozen=True)
class ProviderResponse:
    body: bytes
    status: int


class ProviderRejected(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__("Provider explicitly rejected the request.")


class UnknownOutcome(Exception):
    pass


class TranscriptionProvider(Protocol):
    def validate_settings(self, settings: dict) -> TranscriptionSettings: ...
    def estimate_features(self, settings: dict) -> dict: ...
    def before_request(self) -> None: ...
    def transcribe(self, path: Path, settings: dict) -> ProviderResponse: ...
    def normalize_response(self, raw: bytes) -> NeutralTranscript: ...


class ElevenLabs:
    def __init__(
        self, base_url="https://api.elevenlabs.io", client: httpx.Client | None = None
    ):
        self.base_url = base_url
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(1800, connect=30), follow_redirects=False
        )

    def validate_settings(self, settings):
        return TranscriptionSettings.model_validate(settings)

    def estimate_features(self, settings):
        return {
            "keyterms": bool(settings.get("keyterms")),
            "keyterm_count": len(settings.get("keyterms", [])),
            "diarization": settings.get("diarize", False),
            "audio_events": settings.get("tag_audio_events", False),
        }

    def before_request(self):
        if not os.getenv("ELEVENLABS_API_KEY"):
            raise AppError(
                "provider_auth",
                "Set ELEVENLABS_API_KEY in the backend environment before resuming.",
                409,
            )

    def transcribe(self, path, settings):
        opts = self.validate_settings(settings)
        key = os.getenv("ELEVENLABS_API_KEY")
        if not key:
            raise AppError(
                "provider_auth",
                "Set ELEVENLABS_API_KEY in the backend environment.",
                409,
            )
        data = {
            "model_id": "scribe_v2",
            "timestamps_granularity": "word",
            "diarize": str(opts.diarize).lower(),
            "tag_audio_events": str(opts.tag_audio_events).lower(),
            "webhook": "false",
            "use_multi_channel": "false",
        }
        if opts.language_code:
            data["language_code"] = opts.language_code
        if opts.diarize and opts.num_speakers:
            data["num_speakers"] = str(opts.num_speakers)
        # Repeated multipart fields, matching the official generated SDK.
        if opts.keyterms:
            data["keyterms"] = opts.keyterms
        try:
            with path.open("rb") as file:
                response = self.client.post(
                    self.base_url + "/v1/speech-to-text",
                    headers={"xi-api-key": key},
                    data=data,
                    files={"file": ("chunk.wav", file, "audio/wav")},
                )
        except httpx.HTTPError:
            raise UnknownOutcome(
                "Request may have been processed and billed."
            ) from None
        if 400 <= response.status_code < 500:
            raise ProviderRejected(response.status_code)
        if response.status_code != 200:
            raise UnknownOutcome(
                "Unexpected provider response; billing outcome is uncertain."
            )
        if key.encode() in response.content:
            # Do not persist a vendor response that unexpectedly echoes a credential.
            raise UnknownOutcome(
                "Provider response violated secret containment; outcome requires review."
            )
        return ProviderResponse(response.content, response.status_code)

    def normalize_response(self, raw):
        obj = json.loads(raw)
        if not isinstance(obj, dict) or not isinstance(obj.get("text"), str):
            raise ValueError("Expected a synchronous transcript response.")
        words = []
        for w in obj.get("words", []):
            start = w.get("start")
            end = w.get("end")
            if start is not None and (
                not isinstance(start, (int, float))
                or not math.isfinite(start)
                or start < 0
            ):
                raise ValueError("Invalid word timing.")
            if end is not None and (
                not isinstance(end, (int, float))
                or not math.isfinite(end)
                or end < 0
                or (start is not None and end < start)
            ):
                raise ValueError("Invalid word timing.")
            if not isinstance(w.get("text"), str):
                raise ValueError("Invalid token.")
            words.append(
                TimedWord(
                    w["text"],
                    round(start * 1000) if start is not None else None,
                    round(end * 1000) if end is not None else None,
                    w.get("type", "word"),
                    w.get("speaker_id"),
                    w.get("logprob"),
                )
            )
        return NeutralTranscript(obj["text"], words, obj.get("transcription_id"))

    def account(self, subscription=False):
        key = os.getenv("ELEVENLABS_API_KEY")
        result = {
            "credential_source": "ELEVENLABS_API_KEY environment variable",
            "key_configured": bool(key),
            "transcription_verified": False,
            "check_scope": "subscription" if subscription else "account",
        }
        if not key:
            return result | {
                "status": "Not configured",
                "message": "No key is loaded. Set ELEVENLABS_API_KEY in the project .env next to compose.yaml and recreate API and worker containers.",
            }
        try:
            r = self.client.get(
                self.base_url
                + ("/v1/user/subscription" if subscription else "/v1/user"),
                headers={"xi-api-key": key},
                timeout=20,
            )
            result["http_status"] = r.status_code
            if r.status_code != 200:
                # A restricted key can get HTTP 401 with missing_permissions.
                # Inspect only a known status code, never expose the remote body.
                try:
                    body = r.json()
                    detail = body.get("detail", {}) if isinstance(body, dict) else {}
                    code = detail.get("status") if isinstance(detail, dict) else None
                except ValueError:
                    code = None
                if r.status_code in (401, 403) and code == "missing_permissions":
                    return result | {
                        "status": "Restricted",
                        "reason": "missing_permissions",
                        "message": "A key is loaded, but this optional account check requires User → Access. A Speech-to-Text-only key may still transcribe with Speech to Text → Access. This check does not test transcription permission.",
                    }
                if r.status_code in (401, 403) and code == "invalid_api_key":
                    return result | {
                        "status": "Invalid",
                        "reason": "invalid_api_key",
                        "message": "ElevenLabs reports an invalid API key. Check the project .env and recreate API and worker containers after correcting it.",
                    }
                if r.status_code in (401, 403):
                    return result | {
                        "status": "Unauthorized"
                        if r.status_code == 401
                        else "Access denied",
                        "message": "The account check was denied. Check User → Access, key restrictions and expiration. This response does not establish whether Speech to Text is authorized.",
                    }
                return result | {
                    "status": "Unavailable",
                    "message": "The read-only account check is unavailable. No transcription request was sent.",
                }
            result.update(
                status="Connected",
                message="Account access is connected. Speech to Text → Access is required separately; this read-only check has not verified transcription permission.",
            )
            if subscription:
                data = r.json()
                # Explicit allowlist. Never return the raw account response.
                safe = {}
                tier = data.get("tier") if isinstance(data, dict) else None
                if isinstance(tier, str) and len(tier) <= 64 and key not in tier:
                    safe["tier"] = tier
                for name in [
                    "character_count",
                    "character_limit",
                    "next_character_count_reset_unix",
                ]:
                    value = data.get(name) if isinstance(data, dict) else None
                    if type(value) is int and value >= 0 and key not in str(value):
                        safe[name] = value
                result["subscription"] = safe
            return result
        except (httpx.HTTPError, ValueError):
            return result | {
                "status": "Unavailable",
                "message": "The read-only account check could not complete. Check connectivity; no transcription request was sent.",
            }
