"""Focused regression tests for platform-owner and first-account bootstrap auth."""

import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402
from models import RegisterRequest  # noqa: E402


def run_async(fn):
    return asyncio.run(fn())


class FakeCollection:
    def __init__(self, *, duplicate_bootstrap=False, count=0):
        self.docs = []
        self.duplicate_bootstrap = duplicate_bootstrap
        self.count = count

    async def count_documents(self, _query):
        # Keep this at zero to model two concurrent requests reading before
        # either user insert becomes visible.
        return self.count

    async def find_one(self, _query, _projection=None):
        return None

    async def insert_one(self, doc):
        if self.duplicate_bootstrap and doc.get("_id") == "first_super_admin":
            raise DuplicateKeyError("first bootstrap claim already exists")
        self.docs.append(dict(doc))

    async def delete_one(self, _query):
        return None

    async def update_one(self, _query, _update, **_kwargs):
        return SimpleNamespace(matched_count=1, modified_count=1)


class FakeDatabase:
    def __init__(self, *, duplicate_bootstrap=False, users_count=0):
        self.users = FakeCollection(count=users_count)
        self.platform_bootstrap = FakeCollection(
            duplicate_bootstrap=duplicate_bootstrap
        )
        self.api_keys = FakeCollection()
        self.sessions = FakeCollection()


class FakeRequest:
    headers = {}
    client = None
    url = SimpleNamespace(path="/api/auth/register")


def owner_user(**overrides):
    user = {
        "id": "owner-id",
        "email": "Owner@Example.com",
        "role": "user",
        "admin_role": "support",
        "kyc_status": "not_started",
        "is_blocked": True,
        "is_banned": True,
        "withdrawals_blocked": True,
    }
    user.update(overrides)
    return user


def test_existing_owner_before_recovery_cutoff_is_restored_and_unblocked(monkeypatch):
    async def check():
        database = FakeDatabase()
        monkeypatch.setattr(server, "db", database)
        monkeypatch.setattr(server, "PLATFORM_OWNER_EMAIL", "owner@example.com")
        monkeypatch.setattr(
            server,
            "PLATFORM_OWNER_CLAIM_BEFORE",
            "2024-01-02T00:00:00+00:00",
        )

        restored = await server._ensure_platform_owner_role(
            owner_user(created_at="2024-01-01T00:00:00+00:00")
        )

        assert restored["role"] == "super_admin"
        assert restored["kyc_status"] == "verified"
        assert restored["is_blocked"] is False
        assert restored["is_banned"] is False
        assert restored["withdrawals_blocked"] is False
        assert "admin_role" not in restored

    run_async(check)


def test_owner_public_payload_exposes_all_super_admin_permissions(monkeypatch):
    monkeypatch.setattr(server, "PLATFORM_OWNER_EMAIL", "owner@example.com")
    payload = server.user_to_public({
        **owner_user(role="super_admin", kyc_status="verified"),
        "full_name": "Owner",
        "username": "owner123",
        "account_type": "merchant",
        "country": "TG",
        "phone": "+22800000000",
        "balance_xof": 0,
        "balance_xaf": 0,
        "created_at": "2024-01-01T00:00:00+00:00",
    })

    assert payload.role == "super_admin"
    assert payload.effective_role == "SUPER_ADMIN"
    assert payload.permissions == ["*"]


def test_non_owner_is_not_changed(monkeypatch):
    async def check():
        database = FakeDatabase()
        monkeypatch.setattr(server, "db", database)
        monkeypatch.setattr(server, "PLATFORM_OWNER_EMAIL", "owner@example.com")
        user = owner_user(email="different@example.com")

        assert await server._ensure_platform_owner_role(user) == user
        assert database.users.docs == []

    run_async(check)


def test_matching_email_created_after_cutoff_is_not_promoted(monkeypatch):
    async def check():
        database = FakeDatabase()
        monkeypatch.setattr(server, "db", database)
        monkeypatch.setattr(server, "PLATFORM_OWNER_EMAIL", "owner@example.com")
        monkeypatch.setattr(
            server,
            "PLATFORM_OWNER_CLAIM_BEFORE",
            "2024-01-01T00:00:00+00:00",
        )
        user = owner_user(created_at="2024-01-02T00:00:00+00:00")

        assert await server._ensure_platform_owner_role(user) == user
        assert database.users.docs == []

    run_async(check)


async def register_for_bootstrap(monkeypatch, database):
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "_require_turnstile", lambda *args: asyncio.sleep(0))
    monkeypatch.setattr(server.auth_security, "admin_password_policy_errors", lambda _: [])
    monkeypatch.setattr(server.auth_security, "password_policy_errors", lambda _: [])
    monkeypatch.setattr(server, "hash_password", lambda _: "test-hash")
    monkeypatch.setattr(
        server,
        "_begin_mfa_enrollment",
        lambda _user: asyncio.sleep(0, result={"setup_token": "test"}),
    )
    request = RegisterRequest(
        full_name="Bootstrap User",
        username="bootstrap123",
        account_type="merchant",
        country="TG",
        phone="+22800000000",
        email="bootstrap@example.com",
        password="Password123!",
    )
    return await server.register(request, FakeRequest(), Response())


def test_concurrent_first_account_claim_allows_only_one_super_admin(monkeypatch):
    first = run_async(
        lambda: register_for_bootstrap(monkeypatch, FakeDatabase())
    )
    assert first["user"].role == "super_admin"

    with pytest.raises(HTTPException) as duplicate:
        run_async(
            lambda: register_for_bootstrap(
                monkeypatch, FakeDatabase(duplicate_bootstrap=True)
            )
        )
    assert getattr(duplicate.value, "status_code", None) == 409


def test_future_matching_email_is_not_a_new_owner_claim(monkeypatch):
    """A configured owner identity must not make a later new account admin."""
    async def check():
        database = FakeDatabase(users_count=1)
        monkeypatch.setattr(server, "db", database)
        monkeypatch.setattr(server, "PLATFORM_OWNER_EMAIL", "owner@example.com")
        monkeypatch.setattr(server, "_require_turnstile", lambda *args: asyncio.sleep(0))
        monkeypatch.setattr(server.auth_security, "admin_password_policy_errors", lambda _: [])
        monkeypatch.setattr(server.auth_security, "password_policy_errors", lambda _: [])
        monkeypatch.setattr(server, "hash_password", lambda _: "test-hash")
        monkeypatch.setattr(server, "_issue_session", lambda *args: asyncio.sleep(0))
        request = RegisterRequest(
            full_name="Future Owner",
            username="futureowner",
            account_type="merchant",
            country="TG",
            phone="+22800000000",
            email="OWNER@example.com",
            password="Password123!",
        )

        result = await server.register(request, FakeRequest(), Response())
        assert result["user"].role == "user"

    run_async(check)