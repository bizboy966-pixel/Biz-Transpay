import sys
from pathlib import Path
from types import SimpleNamespace

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


@pytest.mark.parametrize("path", [
    "/api/webhooks/izipay",
    "/webhooks/izipay",
])
def test_valid_izipay_event_is_acknowledged_on_both_paths(
    monkeypatch, path,
):
    class WebhookEvents:
        def __init__(self):
            self.event = None

        async def insert_one(self, event):
            self.event = dict(event)

        async def update_one(self, _query, update):
            self.event.update(update.get("$set") or {})

    events = WebhookEvents()
    event = {
        "id": "evt-payin-detected",
        "event": "payin.detected",
        "data": {"intentId": "intent-1"},
    }

    async def no_credentials_needed():
        return None

    monkeypatch.setattr(server, "_load_izipay_credentials", no_credentials_needed)
    monkeypatch.setattr(server.izipay, "verify_webhook", lambda _raw, _sig: event)
    monkeypatch.setattr(server.izipay, "event_id", lambda _event: event["id"])
    monkeypatch.setattr(server, "db", SimpleNamespace(webhook_events=events))

    response = _client(monkeypatch).post(
        path,
        content=b'{"event":"payin.detected"}',
        headers={"X-IziPay-Signature": "valid-test-signature"},
    )

    assert response.status_code == 200
    assert response.json() == {"received": True}
    assert events.event["processed"] is True