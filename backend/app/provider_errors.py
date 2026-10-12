"""Expose useful rejection details without retaining raw upstream error bodies."""

import os
import re


def safe_text(value, limit=600):
    if not isinstance(value, str):
        return None
    key = os.getenv("ELEVENLABS_API_KEY")
    if key:
        value = value.replace(key, "[redacted]")
    value = re.sub(r"\bsk_[A-Za-z0-9_-]{16,}\b", "[redacted]", value)
    value = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [redacted]", value)
    return re.sub(r"[\x00-\x1f\x7f]+", " ", value).strip()[:limit] or None


def safe_identifier(value):
    value = safe_text(value, 128)
    return value if value and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value) else None


def rejection_help(status, code=None):
    if code == "missing_permissions":
        return "Enable Speech to Text → Access on this key and save the change. User → Access only controls the optional account check."
    if code in {
        "quota_exceeded",
        "credit_limit_exceeded",
        "insufficient_credits",
        "insufficient_credit_balance",
        "usage_limit_exceeded",
    }:
        return "Check the key's credit limit and the workspace's remaining credits. A long recording can exceed a restricted key's allowance even when Speech to Text is enabled."
    if code in {
        "invalid_api_key",
        "expired_api_key",
        "api_key_expired",
        "api_key_disabled",
    }:
        return "Check key expiration and whether the key is enabled. Correct ELEVENLABS_API_KEY in the project .env, then recreate both API and worker containers."
    if code in {"model_not_found", "invalid_model_id", "model_not_supported"}:
        return "The request uses Scribe v2 (scribe_v2). Check whether this workspace has access to that model."
    if status in (401, 403):
        return "Check Speech to Text → Access, key expiration, IP restrictions, and key/workspace credit limits. The optional User permission does not authorize transcription."
    if status == 429:
        return "ElevenLabs rate or concurrency limits were reached. Wait before reviewing a retry; this app does not automatically resend rejected audio."
    if status == 413:
        return "The upload was too large. Use checkpointed chunks with a shorter target duration."
    if status in (400, 422):
        return "Check the reported request field, language, speaker count, and keyterms. Fix the settings before reviewing another request."
    return "Check the provider message before reviewing a retry. Previous attempt and billing evidence remain recorded."


def attempt_diagnostic(attempt):
    if not attempt:
        return None
    return {
        "http_status": attempt.get("http_status"),
        "error_code": attempt.get("error_code"),
        "error_message": attempt.get("error_message"),
        "request_id": attempt.get("request_id"),
        "help": rejection_help(attempt.get("http_status"), attempt.get("error_code")),
    }
