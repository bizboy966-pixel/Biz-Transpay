"""Regression tests for fail-closed admin access and request byte limits."""
import asyncio
import os
import subprocess
from pathlib import Path

import httpx
from fastapi import Request
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from starlette.routing import Route

import server


def test_unclassified_admin_route_is_denied_by_every_non_owner_role():
    request = Request({
        "type": "http",
        "method": "POST",
        "path": "/api/admin/unclassified-operation",
        "headers": [],
        "query_string": b"",
    })

    permission = server._admin_permission_for_request(request)
    assert permission == "admin:unclassified"
    for role in ("SUPPORT", "FINANCE", "COMPLIANCE", "ADMIN"):
        assert permission not in server._permissions_for_role(role)


def test_application_launchers_refuse_to_use_a_missing_session_secret():
    root = Path(__file__).resolve().parents[2]
    environment = os.environ.copy()
    environment.pop("JWT_SECRET", None)
    environment.pop("SESSION_SECRET", None)

    for launcher in (
            root / "scripts" / "start-replit.sh",
            root / "scripts" / "start-production.sh"):
        result = subprocess.run(
            ["bash", str(launcher)],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        assert result.returncode != 0
        assert "JWT_SECRET or SESSION_SECRET must be configured" in result.stderr


def test_chunked_api_bodies_are_limited_without_rejecting_valid_requests(
        monkeypatch):
    monkeypatch.setattr(server, "MAX_REQUEST_BYTES", 8)
    events = []

    async def alert(event_type, *args, **kwargs):
        events.append(event_type)

    async def echo(request):
        return Response(
            await request.body(),
            media_type="application/octet-stream",
        )

    async def pass_through(request, call_next):
        return await call_next(request)

    app = Starlette(routes=[Route("/api/echo", echo, methods=["POST"])])
    app.add_middleware(BaseHTTPMiddleware, dispatch=pass_through)
    app.add_middleware(server._RequestBodySizeLimitMiddleware)
    monkeypatch.setattr(server, "_queue_security_telegram_alert", alert)

    async def run_requests():
        async def oversized_stream():
            yield b"1234"
            yield b"56789"

        async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="https://example.test") as client:
            oversized = await client.post("/api/echo", content=oversized_stream())
            valid = await client.post("/api/echo", content=b"12345678")
            return oversized, valid

    oversized, valid = asyncio.run(run_requests())
    assert oversized.status_code == 413
    assert oversized.json()["detail"]["max_bytes"] == 8
    assert events == ["request_too_large"]
    assert valid.status_code == 200
    assert valid.content == b"12345678"
