"""Isolated admin PIN regressions: no real accounts, database, or provider calls."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request, Response
from pydantic import ValidationError

import admin_pin
import server
from test_provider_flow_regressions import MemoryCollection, run_async


class Collection(MemoryCollection):
    @classmethod
    def _matches(cls, doc, query):
        if "$or" in query and not any(cls._matches(doc, q) for q in query["$or"]):
            return False
        rest = {k: v for k, v in query.items() if k != "$or"}
        for key, value in rest.items():
            if isinstance(value, dict) and "$lt" in value:
                actual = cls._value(doc, key)
                if actual is None or actual >= value["$lt"]:
                    return False
        return super()._matches(doc, rest)

    async def update_many(self, query, update):
        ids = [doc["id"] for doc in self.docs if self._matches(doc, query)]
        for uid in ids:
            await self.update_one({"id": uid}, update)
        return SimpleNamespace(modified_count=len(ids))


def request():
    req = Request({"type": "http", "method": "POST", "path": "/api/auth/login",
                   "headers": [], "query_string": b"", "client": ("127.0.0.1", 1234)})
    req.state.session_id = "current"
    req.state.session = {"admin_auth_method": "pin", "last_auth_at": datetime.now(timezone.utc)}
    return req


@pytest.fixture(scope="module")
def hashes():
    return server.hash_password("Admin-password-42!"), admin_pin.hash_pin("admin1", "049271")


@pytest.fixture
def state(monkeypatch, hashes):
    user = {
        "id": "admin1", "email": "admin@example.test", "username": "testadmin",
        "full_name": "Test Admin", "account_type": "personal", "country": "TG",
        "phone": "90000000", "role": "admin", "two_fa_enabled": True,
        "password_hash": hashes[0], "admin_pin_hash": hashes[1],
        "admin_pin_version": "v1", "admin_pin_failures": 0,
    }
    db = SimpleNamespace(users=Collection([user]), sessions=Collection([
        {"id": "current", "user_id": "admin1"},
        {"id": "other", "user_id": "admin1"},
        {"id": "unrelated", "user_id": "someone-else"},
    ]), admin_logs=Collection())
    sessions, failures = [], []

    async def noop(*args, **kwargs):
        pass

    async def identity(value):
        return value

    async def get_user(uid):
        return await db.users.find_one({"id": uid})

    async def totp(u, code):
        return code == "246810"

    async def issue(uid, req, response, admin_auth_method="password"):
        sessions.append(admin_auth_method)

    async def failure(*args):
        failures.append(True)

    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "get_user", get_user)
    monkeypatch.setattr(server, "_ensure_platform_owner_role", identity)
    for name in ("_require_turnstile", "_check_login_security",
                 "_clear_login_account_failures", "_complete_login"):
        monkeypatch.setattr(server, name, noop)
    monkeypatch.setattr(server, "_verify_user_totp", totp)
    monkeypatch.setattr(server, "_record_login_failure", failure)
    monkeypatch.setattr(server, "_issue_session", issue)
    return SimpleNamespace(db=db, user=user, sessions=sessions, failures=failures)


def payload(**kwargs):
    return server.LoginRequest(email="admin@example.test", password="Admin-password-42!", **kwargs)


def token(**kwargs):
    return server.auth_security.create_mfa_token("admin1", "login_mfa", pin_version="v1", **kwargs)


@run_async
async def test_password_stage_discovers_methods_without_creating_session(state):
    data = await server.login(payload(), request(), Response())
    assert data["security_methods"] == ["totp", "pin"]
    assert data["mfa_token"]
    assert not state.sessions
    assert "admin_pin_hash" not in str(data)


@pytest.mark.parametrize("method", ["pin", "totp"])
@run_async
async def test_both_methods_open_admin_session(state, method):
    data = await server.login(payload(
        security_method=method, pin="049271", otp="246810", mfa_token=token()), request(), Response())
    assert data["user"].admin_pin_enabled
    assert state.sessions == [method]
    assert "admin_pin_hash" not in data["user"].model_dump()


@run_async
async def test_wrong_password_cannot_be_replaced_by_pin(state):
    req = payload(security_method="pin", pin="049271", mfa_token=token())
    req.password = "wrong"
    with pytest.raises(HTTPException) as error:
        await server.login(req, request(), Response())
    assert error.value.status_code == 401
    assert not state.sessions


@run_async
async def test_unconfigured_pin_not_offered_or_accepted(state):
    state.user.pop("admin_pin_hash")
    data = await server.login(payload(), request(), Response())
    assert data["security_methods"] == ["totp"]
    with pytest.raises(HTTPException):
        await server.login(payload(security_method="pin", pin="049271", mfa_token=token()), request(), Response())
    assert not state.sessions


@pytest.mark.parametrize("kind", ["subject", "version", "expired", "tampered"])
@run_async
async def test_pin_challenge_is_account_version_and_expiry_bound(state, kind):
    challenge = token()
    if kind == "subject":
        challenge = server.auth_security.create_mfa_token("another", "login_mfa", pin_version="v1")
    elif kind == "version":
        state.user["admin_pin_version"] = "v2"
    elif kind == "expired":
        challenge = token(exp=datetime.now(timezone.utc) - timedelta(minutes=1))
    else:
        challenge = "invalid-token"
    with pytest.raises(HTTPException) as error:
        await server.login(payload(security_method="pin", pin="049271", mfa_token=challenge), request(), Response())
    assert error.value.status_code == 401
    assert not state.sessions


@run_async
async def test_five_wrong_pins_lock_across_identifiers_but_totp_still_works(state):
    for _ in range(5):
        with pytest.raises(HTTPException) as error:
            await server.login(payload(security_method="pin", pin="777777", mfa_token=token()), request(), Response())
        assert error.value.status_code == 401
    req = payload(security_method="pin", pin="049271", mfa_token=token())
    req.email = "testadmin"
    with pytest.raises(HTTPException) as error:
        await server.login(req, request(), Response())
    assert error.value.status_code == 429
    assert error.value.detail["code"] == "ADMIN_PIN_LOCKED"
    await server.login(payload(otp="246810", mfa_token=token()), request(), Response())
    assert state.sessions == ["totp"]


@run_async
async def test_pin_lock_expires_and_hash_is_account_bound(state):
    state.user["admin_pin_locked_until"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    state.user["admin_pin_failures"] = 5
    assert await admin_pin.verify_pin(state.db, dict(state.user), "049271")
    assert state.user["admin_pin_failures"] == 0
    assert "admin_pin_locked_until" not in state.user
    assert not await admin_pin.verify_pin(state.db, {**state.user, "id": "other"}, "049271")


@run_async
async def test_regular_user_login_and_admin_enrollment_remain_unchanged(state):
    state.user["role"] = "user"
    result = await server.login(payload(), request(), Response())
    assert result["user"].admin_pin_enabled is False
    assert state.sessions == ["password"]
    state.user["role"] = "super_admin"
    state.user["two_fa_enabled"] = False
    async def setup(user):
        return {"setup_token": "test-setup"}
    # No actual enrollment or secret generation needed for this boundary test.
    original = server._begin_mfa_enrollment
    server._begin_mfa_enrollment = setup
    try:
        result = await server.login(payload(security_method="pin", pin="049271"), request(), Response())
        assert result["mfa_setup_required"]
        assert state.sessions == ["password"]
    finally:
        server._begin_mfa_enrollment = original


@run_async
async def test_pin_session_cannot_authorize_sensitive_admin_operation_or_refresh_around_it(state):
    req = request()
    with pytest.raises(HTTPException) as error:
        await server.require_admin_recent_auth(req, "admin1")
    assert error.value.status_code == 428
    await server._rotate_session(req, Response(), "admin1")
    assert state.sessions == ["pin"]
    with pytest.raises(HTTPException):
        await server.require_admin_recent_auth(req, "admin1")


@run_async
async def test_password_and_totp_reauthentication_upgrade_pin_session(state):
    req = request()
    await server.reauthenticate(server.ReauthenticationRequest(
        current_password="Admin-password-42!", otp="246810"), req, Response(), "admin1")
    assert state.sessions == ["totp"]
    assert await server.require_admin_recent_auth(req, "admin1") == "admin1"


@pytest.mark.parametrize("pin", ["12345", "1234567", "abcdef", "１２３４５６", "12 456"])
def test_pin_requires_exactly_six_ascii_digits(pin):
    with pytest.raises(ValidationError):
        payload(pin=pin)
    with pytest.raises(ValidationError):
        server.AdminPinUpdateRequest(current_password="test", code="246810", pin=pin)


@run_async
async def test_pin_create_change_and_removal_require_password_totp_and_hide_hash(state):
    req = request()
    update = server.AdminPinUpdateRequest(
        current_password="Admin-password-42!", code="246810", pin="305826")
    result = await server.configure_admin_pin(update, req, "admin1")
    assert result == {"enabled": True}
    assert state.user["admin_pin_version"] != "v1"
    assert state.user["admin_pin_hash"] not in ("305826", state.user["password_hash"])
    assert await admin_pin.verify_pin(state.db, dict(state.user), "305826")
    assert not await admin_pin.verify_pin(state.db, dict(state.user), "049271")
    assert "revoked_at" not in state.db.sessions.docs[0]
    assert state.db.sessions.docs[1]["revocation_reason"] == "admin_pin_changed"
    assert "revoked_at" not in state.db.sessions.docs[2]
    assert "305826" not in str(state.db.admin_logs.docs)
    assert server._USER_ADMIN_VIEW_PROJECTION["admin_pin_hash"] == 0
    update.pin = None
    assert await server.configure_admin_pin(update, req, "admin1") == {"enabled": False}
    assert "admin_pin_hash" not in state.user
    assert not server.user_to_public(state.user).admin_pin_enabled


@pytest.mark.parametrize("case", ["regular", "no_mfa", "wrong_password", "wrong_totp"])
@run_async
async def test_pin_settings_reject_unverified_or_non_admin_requests(state, case):
    update = server.AdminPinUpdateRequest(
        current_password="Admin-password-42!", code="246810", pin="305826")
    if case == "regular":
        state.user["role"] = "user"
    elif case == "no_mfa":
        state.user["two_fa_enabled"] = False
    elif case == "wrong_password":
        update.current_password = "wrong"
    else:
        update.code = "000000"
    with pytest.raises(HTTPException):
        await server.configure_admin_pin(update, request(), "admin1")
    assert state.user["admin_pin_version"] == "v1"
    assert not state.db.admin_logs.docs
