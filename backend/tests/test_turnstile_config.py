"""Regression tests for the public Cloudflare Turnstile configuration."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def test_turnstile_config_returns_site_key_without_exposing_secret(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_TURNSTILE_SECRET_KEY", "test-secret")
    monkeypatch.setenv("CLOUDFLARE_TURNSTILE_SITE_KEY", "test-site-key")

    config = asyncio.run(server.turnstile_config())

    assert config == {"enabled": True, "site_key": "test-site-key"}