import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


def _client(monkeypatch):
    async def allowed_identity(_request):
        return "webhook-test"

    async def allow_rate(_profile, _identity):
        return None

    monkeypatch.setattr(server, "_edge_ip_blocked", lambda _request: False)
    monkeypatch.setattr(server, "_global_rate_identity", allowed_identity)
    monkeypatch.setattr(server, "_global_rate_consume", allow_rate)
    return TestClient(server.app)


@pytest.mark.parametrize("path", [
    "/api/webhooks/izipay",
    "/webhooks/izipay",
])
@pytest.mark.parametrize("method", ["get", "head"])
def test_izipay_webhook_health_checks_return_200(monkeypatch, path, method):
    response = getattr(_client(monkeypatch), method)(path)

    assert response.status_code == 200
    if method == "head":
        assert response.content == b""


@pytest.mark.parametrize("path", [
    "/api/webhooks/izipay",
    "/webhooks/izipay",
])
def test_izipay_webhook_post_still_requires_a_valid_signature(
    monkeypatch, path,
):
    async def no_credentials_needed():
        return None

    def reject_signature(_raw, _signature):
        raise ValueError("invalid signature")

    monkeypatch.setattr(server, "_load_izipay_credentials", no_credentials_needed)
    monkeypatch.setattr(server.izipay, "verify_webhook", reject_signature)

    response = _client(monkeypatch).post(
        path,
        content=b'{"event":"payin.detected"}',
        headers={"X-IziPay-Signature": "invalid"},
    )

    assert response.status_code == 400