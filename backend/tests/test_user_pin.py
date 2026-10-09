"""Isolated mandatory user-PIN regressions; no real provider calls or accounts."""
import hashlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request, Response

import admin_pin
import server
from test_admin_pin import Collection, request, run_async


@pytest.fixture
def state(monkeypatch):
    user = {
        "id": "user1", "email": "user@example.test", "username": "testuser",
        "full_name": "Test User", "account_type": "merchant", "country": "TG",
        "phone": "+228 90000000", "role": "user", "kyc_status": "verified",
        "password_hash": server.hash_password("Password-42!"),
        "balance_xof": 10000, "balance_xaf": 0,
    }
    db = SimpleNamespace(
        users=Collection([user]),
        sessions=Collection([{"id": "old", "user_id": "user1"}]),
        password_reset_tokens=Collection(),
    )
    sessions = []
    failures = []

    async def noop(*args, **kwargs):
        return None

    async def identity(value):
        return value

    async def get_user(uid):
        return await db.users.find_one({"id": uid}, {"_id": 0})

    async def issue(uid, req, response, **kwargs):
        sessions.append((uid, kwargs))

    async def revoke(uid, reason):
        for session in db.sessions.docs:
            if session.get("user_id") == uid:
                session.update({"revoked_at": datetime.now(timezone.utc),
                                "revocation_reason": reason})

    async def failure(*args):
        failures.append(True)

    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "get_user", get_user)
    monkeypatch.setattr(server, "_ensure_platform_owner_role", identity)
    monkeypatch.setattr(server, "_issue_session", issue)
    monkeypatch.setattr(server, "_revoke_user_sessions", revoke)
    monkeypatch.setattr(server, "_record_login_failure", failure)
    for name in ("_require_turnstile", "_check_login_security",
                 "_clear_login_account_failures", "_complete_login"):
        monkeypatch.setattr(server, name, noop)
    return SimpleNamespace(db=db, user=user, sessions=sessions, failures=failures)


def login_payload(**kwargs):
    return server.LoginRequest(
        email="user@example.test", password="Password-42!", **kwargs)


@run_async
async def test_user_must_set_pin_before_registration_login_can_open_a_session(state):
    challenge = await server.login(login_payload(), request(), Response())
    assert challenge["user_pin_setup_required"] is True
    assert challenge["pin_setup_token"]
    assert state.sessions == []

    activated = await server.login(login_payload(
        pin_setup_token=challenge["pin_setup_token"],
        pin="000042", pin_confirmation="000042",
    ), request(), Response())
    assert activated["user"].user_pin_enabled is True
    stored_user = await state.db.users.find_one({"id": "user1"}, {"_id": 0})
    assert stored_user["user_pin_hash"] != "000042"
    assert "pin_setup_token_hash" not in stored_user
    assert state.sessions[-1][1]["user_pin_required"] is True
    assert state.sessions[-1][1]["user_pin_authenticated"] is True


@run_async
async def test_each_user_login_requires_a_version_bound_pin_and_rejects_wrong_code(state):
    state.user.update({
        "user_pin_hash": admin_pin.hash_pin("user1", "000042", "user"),
        "user_pin_version": "user-pin-v1",
    })
    challenge = await server.login(login_payload(), request(), Response())
    assert challenge["user_pin_required"] is True
    assert state.sessions == []

    with pytest.raises(HTTPException) as wrong:
        await server.login(login_payload(
            user_pin_token=challenge["user_pin_token"], pin="999999",
        ), request(), Response())
    assert wrong.value.status_code == 401
    assert state.sessions == []

    await server.login(login_payload(
        user_pin_token=challenge["user_pin_token"], pin="000042",
    ), request(), Response())
    assert state.sessions[-1][1]["user_pin_authenticated"] is True

    state.user["user_pin_version"] = "user-pin-v2"
    with pytest.raises(HTTPException) as stale:
        await server.login(login_payload(
            user_pin_token=challenge["user_pin_token"], pin="000042",
        ), request(), Response())
    assert stale.value.status_code == 401


@run_async
async def test_five_wrong_user_pins_lock_login_and_do_not_create_sessions(state):
    state.user.update({
        "user_pin_hash": admin_pin.hash_pin("user1", "000042", "user"),
        "user_pin_version": "user-pin-v1",
    })
    challenge = await server.login(login_payload(), request(), Response())
    for _ in range(admin_pin.MAX_FAILURES):
        with pytest.raises(HTTPException) as wrong:
            await server.login(login_payload(
                user_pin_token=challenge["user_pin_token"], pin="999999",
            ), request(), Response())
        assert wrong.value.status_code == 401
    with pytest.raises(HTTPException) as locked:
        await server.login(login_payload(
            user_pin_token=challenge["user_pin_token"], pin="000042",
        ), request(), Response())
    assert locked.value.status_code == 429
    assert locked.value.detail["code"] == "USER_PIN_LOCKED"
    assert state.sessions == []


@run_async
async def test_user_pin_reset_requires_email_token_and_current_password_then_revokes_sessions(state, monkeypatch):
    raw_token = "one-time-user-pin-reset-token-value"
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    state.user.update({
        "user_pin_hash": admin_pin.hash_pin("user1", "000042", "user"),
        "user_pin_version": "user-pin-v1",
    })
    state.db.password_reset_tokens.docs.append({
        "id": "reset1", "user_id": "user1", "token_hash": token_hash,
        "purpose": "user_pin", "used": False,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=30),
    })

    async def allow_turnstile(*args, **kwargs):
        return None
    monkeypatch.setattr(server, "_require_turnstile", allow_turnstile)
    original_password_hash = state.user["password_hash"]
    result = await server.confirm_user_pin_reset(
        server.UserPinResetConfirm(
            token=raw_token, current_password="Password-42!", pin="123456"),
        request(), Response(),
    )
    assert result["ok"] is True
    assert state.user["password_hash"] == original_password_hash
    assert state.user["user_pin_version"] != "user-pin-v1"
    assert state.db.password_reset_tokens.docs[0]["used"] is True
    assert state.db.sessions.docs[0]["revocation_reason"] == "user_pin_reset"
    assert await admin_pin.verify_pin(
        state.db, dict(state.user), "123456", field_prefix="user_pin")


@run_async
async def test_transfer_requires_pin_but_merchant_api_contract_is_unchanged(state, monkeypatch):
    def no_kyc(user):
        return None

    async def no_turnstile(*args, **kwargs):
        return None

    async def user_lookup(uid):
        return state.user
    monkeypatch.setattr(server, "get_user", user_lookup)
    monkeypatch.setattr(server, "_require_kyc_verified", no_kyc)
    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    transfer = server.TransferRequest(
        transfer_type="biz_to_mobile", recipient="+22890000000",
        amount=100, currency="XOF", turnstile_token="test",
    )

    with pytest.raises(HTTPException) as missing:
        await server.transfer(transfer, request(), "user1")
    assert missing.value.status_code == 428
    assert missing.value.detail["code"] == "USER_PIN_SETUP_REQUIRED"

    api_request = request()
    api_request.state.merchant_api = True
    with pytest.raises(HTTPException) as api_response:
        await server.transfer(transfer, api_request, "user1")
    # It advances to the existing API idempotency validation rather than
    # requiring a browser PIN or Turnstile challenge.
    assert api_response.value.status_code == 400
    assert "Clé d'idempotence" in api_response.value.detail


@pytest.mark.parametrize("pin", ["12345", "1234567", "abcdef", "１２３４５６"])
def test_user_pin_inputs_accept_only_six_ascii_digits(pin):
    with pytest.raises(Exception):
        login_payload(pin=pin)
    with pytest.raises(Exception):
        server.UserPinResetConfirm(
            token="a" * 32, current_password="Password-42!", pin=pin)


@pytest.mark.parametrize("path", [
    "/api/auth/user-pin/reset/request",
    "/api/auth/user-pin/reset/confirm",
])
def test_public_pin_reset_routes_keep_csrf_checks_for_cookie_sessions(path):
    scope = {
        "type": "http", "method": "POST", "path": path, "query_string": b"",
        "headers": [], "client": ("127.0.0.1", 1234),
    }
    assert server._validate_csrf_request(Request(scope)) is None

    scope["headers"] = [
        (b"cookie", f"{server.SESSION_COOKIE_NAME}=existing-session".encode()),
        (b"origin", b"https://attacker.invalid"),
    ]
    response = server._validate_csrf_request(Request(scope))
    assert response is not None and response.status_code == 403
