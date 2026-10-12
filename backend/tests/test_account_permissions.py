import json
import httpx
import pytest
from app.provider import ElevenLabs


@pytest.mark.parametrize("subscription", [False, True])
@pytest.mark.parametrize("status", [401, 403])
def test_account_scope_denial_is_not_invalid_key(monkeypatch, subscription, status):
    sentinel = "restricted-test-key-never-return"
    monkeypatch.setenv("ELEVENLABS_API_KEY", sentinel)
    calls = []

    def respond(request):
        calls.append((request.method, request.url.path))
        assert request.headers["xi-api-key"] == sentinel
        return httpx.Response(
            status,
            json={
                "detail": {
                    "status": "missing_permissions",
                    "message": "Sensitive upstream body " + sentinel,
                }
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(respond))
    result = ElevenLabs(client=client).account(subscription=subscription)
    assert result["status"] == "Restricted"
    assert result["key_configured"] and not result["transcription_verified"]
    assert result["reason"] == "missing_permissions"
    assert "User" in result["message"]
    assert sentinel not in json.dumps(result)
    assert calls == [("GET", "/v1/user/subscription" if subscription else "/v1/user")]


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (401, {"detail": {"status": "invalid_api_key"}}, "Invalid"),
        (403, {"detail": {"status": "invalid_api_key"}}, "Invalid"),
        (401, {}, "Unauthorized"),
        (403, {}, "Access denied"),
        (401, {"detail": "untrusted text"}, "Unauthorized"),
        (401, {"detail": ["untrusted shape"]}, "Unauthorized"),
        (429, {}, "Unavailable"),
    ],
)
def test_account_failure_classification(monkeypatch, status, body, expected):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    )
    result = ElevenLabs(client=client).account()
    assert result["status"] == expected
    assert result["key_configured"] and not result["transcription_verified"]


def test_account_success_does_not_claim_speech_permission(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    calls = []

    def respond(request):
        calls.append(request.method)
        return httpx.Response(200, json={})

    result = ElevenLabs(
        client=httpx.Client(transport=httpx.MockTransport(respond))
    ).account()
    assert result["status"] == "Connected"
    assert result["key_configured"] and not result["transcription_verified"]
    assert "Speech to Text" in result["message"]
    assert calls == ["GET"]
