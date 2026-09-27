import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paydunya
import server


class SettingsStore:
    def __init__(self):
        self.document = None

    async def find_one(self, query, projection=None):
        if self.document is None:
            return None
        return dict(self.document)

    async def update_one(self, query, update, upsert=False):
        if self.document is None:
            self.document = {"id": query["id"]}
        self.document.update(update.get("$set") or {})
        for key in (update.get("$unset") or {}):
            self.document.pop(key, None)


def test_izipay_admin_save_encrypts_both_credentials(monkeypatch):
    settings = SettingsStore()
    audit_entries = []
    configured = []

    async def audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "db", SimpleNamespace(settings=settings))
    monkeypatch.setattr(server, "audit", audit)
    monkeypatch.setattr(server.izipay, "configure",
                        lambda **kwargs: configured.append(kwargs))
    monkeypatch.setenv("SESSION_SECRET", "test-session-secret")

    response = server.admin_update_izipay(
        server.IziPayProviderUpdate(
            api_key="api-test-value",
            webhook_secret="web-secret-test-value",
        ),
        admin={"id": "admin-1", "username": "admin"},
    )
    import asyncio
    result = asyncio.run(response)

    assert settings.document["api_key_encrypted"] != "api-test-value"
    assert settings.document["webhook_secret_encrypted"] != "web-secret-test-value"
    assert paydunya.decrypt_secret(
        settings.document["api_key_encrypted"], "test-session-secret"
    ) == "api-test-value"
    assert paydunya.decrypt_secret(
        settings.document["webhook_secret_encrypted"], "test-session-secret"
    ) == "web-secret-test-value"
    assert result == {
        "configured": True,
        "api_key_configured": True,
        "webhook_secret_configured": True,
    }
    assert len(configured) == 1
    assert configured[0]["api_key"] == "api-test-value"
    assert configured[0]["webhook_secret"] == "web-secret-test-value"
    assert len(audit_entries) == 1


def test_izipay_public_config_reports_presence_without_returning_values(monkeypatch):
    monkeypatch.delenv("IZIPAY_API_KEY", raising=False)
    monkeypatch.delenv("IZIPAY_WEBHOOK_SECRET", raising=False)
    cfg = {
        "api_key_encrypted": "encrypted-api-value",
        "webhook_secret_encrypted": "encrypted-web-secret",
    }

    response = server._izipay_public_config(cfg, admin=True)

    assert response == {
        "configured": True,
        "api_key_configured": True,
        "webhook_secret_configured": True,
    }
    assert "encrypted-api-value" not in str(response)
    assert "encrypted-web-secret" not in str(response)


def test_blank_izipay_secret_fields_leave_existing_credentials_untouched(monkeypatch):
    settings = SettingsStore()
    session_secret = "test-session-secret"
    settings.document = {
        "id": "payment_provider_izipay",
        "api_key_encrypted": paydunya.encrypt_secret("existing-api", session_secret),
        "webhook_secret_encrypted": paydunya.encrypt_secret("existing-web", session_secret),
    }
    monkeypatch.setattr(server, "db", SimpleNamespace(settings=settings))
    monkeypatch.setattr(server, "audit", _noop_audit)
    monkeypatch.setattr(server.izipay, "configure", lambda **kwargs: None)
    monkeypatch.setenv("SESSION_SECRET", session_secret)

    import asyncio
    result = asyncio.run(server.admin_update_izipay(
        server.IziPayProviderUpdate(api_key=" ", webhook_secret=""),
        admin={"id": "admin-1", "username": "admin"},
    ))

    assert paydunya.decrypt_secret(
        settings.document["api_key_encrypted"], session_secret
    ) == "existing-api"
    assert paydunya.decrypt_secret(
        settings.document["webhook_secret_encrypted"], session_secret
    ) == "existing-web"
    assert result["configured"] is True


async def _noop_audit(*args, **kwargs):
    return None