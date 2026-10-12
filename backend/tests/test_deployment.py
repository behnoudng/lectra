import json
from pathlib import Path
import subprocess


def test_compose_exposes_only_loopback_web():
    root = Path(__file__).parents[2]
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(root / "compose.yaml"),
            "config",
            "--format",
            "json",
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    services = json.loads(result.stdout)["services"]
    assert set(services) == {"web", "api", "worker"}
    assert services["web"]["ports"][0]["host_ip"] == "127.0.0.1"
    assert not services["api"].get("ports") and not services["worker"].get("ports")
    assert "ELEVENLABS_API_KEY" not in services["web"].get("environment", {})


def test_frontend_bundle_excludes_environment_credentials():
    root = Path(__file__).parents[2]
    for file in (root / "frontend/dist").rglob("*"):
        if file.is_file():
            assert b"lectra-e2e-environment-sentinel" not in file.read_bytes()
