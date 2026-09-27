"""Offline tests for transactional email and password-reset boundaries."""

import asyncio
import copy
import hashlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import BackgroundTasks
from pymongo.errors import DuplicateKeyError
from starlette.requests import Request
from starlette.responses import Response

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import email_delivery  # noqa: E402
import server  # noqa: E402
from models import (  # noqa: E402
    PasswordRecoveryRequest,
    PasswordResetConfirm,
    PasswordResetRequest,
    TransactionEmailSettingsUpdate,
    TransferRequest,
)
from postgres_document_store import _apply_update, _matches  # noqa: E402


class _Result:
    def __init__(self, modified_count=0, deleted_count=0):
        self.modified_count = modified_count
        self.deleted_count = deleted_count


class _Collection:
    def __init__(self, docs=None):
        self.docs = copy.deepcopy(docs or [])

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next((doc for doc in self.docs if _matches(doc, query)), None))

    async def insert_one(self, document):
        if any(doc.get("id") == document.get("id") for doc in self.docs):
            raise DuplicateKeyError("duplicate id")
        self.docs.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update, upsert=False):
        for index, doc in enumerate(self.docs):
            if _matches(doc, query):
                changed = _apply_update(doc, update)
                modified = int(changed != doc)
                self.docs[index] = changed
                return _Result(modified)
        if upsert:
            item = _apply_update({}, update, inserting=True)
            item.update({key: value for key, value in query.items() if not key.startswith("$")})
            await self.insert_one(item)
            return _Result(1)
        return _Result(0)

    async def update_many(self, query, update):
        modified = 0
        for index, doc in enumerate(self.docs):
            if _matches(doc, query):
                changed = _apply_update(doc, update)
                modified += int(changed != doc)
                self.docs[index] = changed
        return _Result(modified)

    async def delete_one(self, query):
        for index, doc in enumerate(self.docs):
            if _matches(doc, query):
                self.docs.pop(index)
                return _Result(deleted_count=1)
        return _Result()

    async def delete_many(self, query):
        old_count = len(self.docs)
        self.docs = [doc for doc in self.docs if not _matches(doc, query)]
        return _Result(deleted_count=old_count - len(self.docs))

    async def replace_one(self, query, replacement, upsert=False):
        for index, doc in enumerate(self.docs):
            if _matches(doc, query):
                self.docs[index] = copy.deepcopy(replacement)
                return _Result(1)
        if upsert:
            await self.insert_one(replacement)
            return _Result(1)
        return _Result()


def _request():
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/auth/password-reset/request",
        "headers": [(b"host", b"biz-transppayy.com")],
        "query_string": b"",
    })


def test_password_reset_request_has_same_response_for_existing_and_unknown_email(monkeypatch):
    async def no_turnstile(*_args, **_kwargs):
        return None

    async def allowed(_email):
        return True

    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(server, "_allow_password_reset_request", allowed)

    async def run():
        tasks = []
        responses = []
        for address in ("member@example.com", "missing@example.com"):
            background = BackgroundTasks()
            responses.append(await server.request_password_reset(
                PasswordResetRequest(
                    email=address,
                    turnstile_token="unit-test-turnstile",
                ),
                _request(),
                background,
            ))
            tasks.append(background.tasks)
        return responses, tasks

    responses, tasks = asyncio.run(run())
    assert responses[0] == responses[1] == server.PASSWORD_RESET_GENERIC_RESPONSE
    assert all(len(items) == 1 for items in tasks)
    assert all(item.func is server._prepare_password_reset_email for group in tasks for item in group)


def test_password_reset_rate_limit_is_per_normalized_email(monkeypatch):
    limits = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(password_reset_limits=limits))

    async def run():
        results = [
            await server._allow_password_reset_request("Member@example.com"),
            await server._allow_password_reset_request(" member@EXAMPLE.com "),
            await server._allow_password_reset_request("member@example.com"),
            await server._allow_password_reset_request("member@example.com"),
        ]
        return results

    assert asyncio.run(run()) == [True, True, True, False]


def test_password_reset_token_expiry_and_one_time_use(monkeypatch):
    now = datetime.now(timezone.utc)
    user = {
        "id": "user-1",
        "email": "member@example.com",
        "role": "user",
        "password_hash": "old-hash",
    }
    live_token = "t" * 48
    expired_token = "e" * 48
    tokens = _Collection([
        {
            "id": "live",
            "user_id": user["id"],
            "token_hash": hashlib.sha256(live_token.encode()).hexdigest(),
            "used": False,
            "expires_at": now + timedelta(minutes=10),
        },
        {
            "id": "expired",
            "user_id": user["id"],
            "token_hash": hashlib.sha256(expired_token.encode()).hexdigest(),
            "used": False,
            "expires_at": now - timedelta(seconds=1),
        },
        {
            "id": "other-live",
            "user_id": user["id"],
            "token_hash": "other-hash",
            "used": False,
            "expires_at": now + timedelta(minutes=10),
        },
    ])
    users = _Collection([user])
    sessions = _Collection([
        {"id": "active", "user_id": user["id"]},
        {"id": "already-revoked", "user_id": user["id"], "revoked_at": now},
    ])
    monkeypatch.setattr(server, "db", SimpleNamespace(
        password_reset_tokens=tokens,
        users=users,
        sessions=sessions,
        auth_rate_limits=_Collection(),
    ))

    async def no_turnstile(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(server.auth_security, "password_policy_errors", lambda _value: [])
    monkeypatch.setattr(server, "hash_password", lambda _value: "new-hash")

    async def run():
        expired_response = Response()
        with pytest.raises(server.HTTPException) as expired_error:
            await server.confirm_password_reset(
                PasswordResetConfirm(
                    token=expired_token,
                    new_password="StrongPass10!",
                    turnstile_token="unit-test-turnstile",
                ),
                _request(),
                expired_response,
            )
        assert expired_error.value.status_code == 400

        success_response = Response()
        result = await server.confirm_password_reset(
            PasswordResetConfirm(
                token=live_token,
                new_password="StrongPass10!",
                turnstile_token="unit-test-turnstile",
            ),
            _request(),
            success_response,
        )
        assert result["ok"] is True
        with pytest.raises(server.HTTPException) as replay_error:
            await server.confirm_password_reset(
                PasswordResetConfirm(
                    token=live_token,
                    new_password="AnotherPass11!",
                    turnstile_token="unit-test-turnstile",
                ),
                _request(),
                Response(),
            )
        assert replay_error.value.status_code == 400

    asyncio.run(run())
    assert users.docs[0]["password_hash"] == "new-hash"
    assert sessions.docs[0]["revocation_reason"] == "password_reset"
    assert sessions.docs[1].get("revocation_reason") is None
    assert all(doc["used"] for doc in tokens.docs)


def test_mfa_recovery_code_path_still_resets_and_revokes_sessions(monkeypatch):
    user = {
        "id": "user-2",
        "email": "member@example.com",
        "username": "member2",
        "recovery_codes": [{"id": "code-1", "used": False, "hash": "code-hash"}],
    }
    users = _Collection([user])
    original_update_one = users.update_one

    async def update_one(query, update, upsert=False):
        if "recovery_codes" in query and "$elemMatch" in query["recovery_codes"]:
            item = next(
                code for code in users.docs[0]["recovery_codes"]
                if code["id"] == "code-1" and not code["used"]
            )
            item["used"] = True
            users.docs[0]["password_hash"] = update["$set"]["password_hash"]
            users.docs[0]["password_policy_version"] = 1
            return _Result(1)
        return await original_update_one(query, update, upsert)

    users.update_one = update_one
    sessions = _Collection([{"id": "active", "user_id": user["id"]}])
    monkeypatch.setattr(server, "db", SimpleNamespace(
        users=users,
        sessions=sessions,
        password_reset_tokens=_Collection(),
        auth_rate_limits=_Collection(),
    ))
    monkeypatch.setattr(server, "_require_turnstile", _async_noop)
    monkeypatch.setattr(server, "_check_login_security", _async_noop)
    monkeypatch.setattr(server, "_record_login_failure", _async_noop)
    monkeypatch.setattr(server, "_clear_login_account_failures", _async_noop)
    monkeypatch.setattr(server.auth_security, "password_policy_errors", lambda _value: [])
    monkeypatch.setattr(server, "verify_password", lambda *_args: True)
    monkeypatch.setattr(server, "hash_password", lambda _value: "new-hash")

    result = asyncio.run(server.recover_account(
        PasswordRecoveryRequest(
            identifier="member@example.com",
            recovery_code="one-time-code",
            new_password="StrongPass10!",
            turnstile_token="unit-test-turnstile",
        ),
        _request(),
        Response(),
    ))
    assert result["ok"] is True
    assert users.docs[0]["recovery_codes"][0]["used"] is True
    assert users.docs[0]["password_hash"] == "new-hash"
    assert sessions.docs[0]["revocation_reason"] == "account_recovery"


async def _async_noop(*_args, **_kwargs):
    return None


def test_transaction_email_is_deduplicated_and_only_for_initiated_final_events(monkeypatch):
    outbox = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(email_outbox=outbox))
    monkeypatch.setattr(server, "_transaction_email_settings", lambda: _resolved({
        "enabled": True,
        "event_types": ["payment_final"],
        "content_fields": ["event_status", "reference"],
        "sender_email": "notifications@example.com",
    }))
    monkeypatch.setenv("RESEND_API_KEY", "unit-test-key")
    monkeypatch.setattr(
        server,
        "_load_transaction_email_context",
        lambda *_args: _resolved((
            {
                "id": "outgoing-transfer",
                "type": "transfer",
                "direction": "out",
                "status": "completed",
                "metadata": {"transfer_type": "biz_to_biz"},
                "reference": "ref-1",
            },
            {"email": "initiator@example.com"},
        )),
    )
    deliveries = []

    async def count_delivery(outbox_id):
        deliveries.append(outbox_id)

    monkeypatch.setattr(server, "_deliver_transaction_email", count_delivery)

    async def run():
        await server._enqueue_transaction_email(
            "user-1", "payment_final", "tx-1", "transaction"
        )
        await server._enqueue_transaction_email(
            "user-1", "payment_final", "tx-1", "transaction"
        )

    asyncio.run(run())
    assert len(outbox.docs) == 1
    assert len(deliveries) == 1
    assert server._transaction_email_record_is_final(
        "payment_final",
        {"type": "payment", "direction": "in", "status": "completed"},
        "transaction",
    ) is False
    assert server._transaction_email_record_is_final(
        "withdrawal_success",
        {"type": "transfer", "direction": "out", "status": "pending"},
        "transaction",
    ) is False


def _resolved(value):
    async def inner():
        return value
    return inner()


def test_resend_failure_is_swallowed_and_marked_failed(monkeypatch):
    outbox = _Collection([{
        "id": "outbox-1",
        "user_id": "user-1",
        "event_type": "withdrawal_success",
        "entity_id": "tx-1",
        "entity_kind": "transaction",
        "status": "queued",
    }])
    monkeypatch.setattr(server, "db", SimpleNamespace(email_outbox=outbox))
    monkeypatch.setattr(server, "_transaction_email_settings", lambda: _resolved({
        "enabled": True,
        "event_types": ["withdrawal_success"],
        "content_fields": ["event_status"],
        "sender_email": "notifications@example.com",
    }))
    monkeypatch.setenv("RESEND_API_KEY", "unit-test-key")
    monkeypatch.setattr(server, "_load_transaction_email_context", lambda *_args: _resolved((
        {
            "id": "tx-1",
            "type": "withdrawal",
            "direction": "out",
            "status": "completed",
            "amount": 4,
            "currency": "XOF",
            "reference": "internal-reference",
        },
        {"email": "initiator@example.com"},
    )))

    async def fail_delivery(**_kwargs):
        raise RuntimeError("simulated offline provider")

    monkeypatch.setattr(server, "send_resend_email", fail_delivery)
    asyncio.run(server._deliver_transaction_email("outbox-1"))
    assert outbox.docs[0]["status"] == "failed"
    assert outbox.docs[0]["failure_type"] == "RuntimeError"


def test_resend_adapter_uses_mock_transport_and_idempotency_header():
    captured = {}

    async def handler(request):
        captured["key"] = request.headers.get("Idempotency-Key")
        captured["authorization"] = request.headers.get("Authorization")
        return httpx.Response(202, json={"id": "mock-message"})

    async def run():
        await email_delivery.send_resend_email(
            api_key="offline-test-value",
            sender="notifications@example.com",
            recipient="member@example.com",
            subject="Test",
            text="Offline delivery test",
            html="<p>Offline delivery test</p>",
            idempotency_key="idempotent-test",
            transport=httpx.MockTransport(handler),
        )

    asyncio.run(run())
    assert captured == {
        "key": "idempotent-test",
        "authorization": "Bearer offline-test-value",
    }


def test_withdrawal_email_otp_gates_biz_to_biz_and_is_one_time(monkeypatch):
    now = datetime.now(timezone.utc)
    challenge_store = _Collection()
    transactions = _Collection()
    limits = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(
        withdrawal_email_otps=challenge_store,
        withdrawal_email_otp_limits=limits,
        transactions=transactions,
    ))
    monkeypatch.setenv("SESSION_SECRET", "offline-session-secret")
    monkeypatch.setenv("RESEND_API_KEY", "offline-resend-key")
    monkeypatch.setattr(server, "_transaction_email_settings", lambda: _resolved({
        "sender_email": "notifications@example.com",
        "withdrawal_otp_enabled": True,
    }))
    monkeypatch.setattr(server, "_allow_withdrawal_email_otp_request", _async_true)
    monkeypatch.setattr(server, "_require_turnstile", _async_noop)
    monkeypatch.setattr(server, "get_user", lambda _uid: _resolved({
        "id": "user-otp",
        "email": "member@example.com",
        "username": "sender",
        "kyc_status": "verified",
        "balance_xof": 5000,
    }))
    sent = []

    async def capture_email(**kwargs):
        sent.append(kwargs)

    monkeypatch.setattr(server, "send_resend_email", capture_email)
    request_payload = TransferRequest(
        transfer_type="biz_to_biz",
        recipient="receiver",
        amount=100,
        currency="XOF",
        turnstile_token="first-turnstile-token",
    )

    async def run():
        challenge = await server.transfer(request_payload, _request(), "user-otp")
        assert challenge["withdrawal_otp_required"] is True
        assert challenge["expires_in_seconds"] == 600
        assert challenge["email_hint"] == "m***@example.com"
        assert transactions.docs == []
        assert len(sent) == 1
        code = next(
            part for part in sent[0]["text"].split() if len(part) == 6 and part.isdigit()
        )
        challenge_id = challenge["challenge_id"]

        wrong_code_request = request_payload.model_copy(update={
            "turnstile_token": "fresh-turnstile-token",
            "withdrawal_otp_challenge_id": challenge_id,
            "withdrawal_otp_code": "000000" if code != "000000" else "000001",
        })
        with pytest.raises(server.HTTPException) as wrong_code:
            await server._consume_withdrawal_email_otp("user-otp", wrong_code_request)
        assert wrong_code.value.status_code == 400
        assert challenge_store.docs[0]["attempts"] == 1

        altered_request = wrong_code_request.model_copy(update={
            "amount": 101,
            "withdrawal_otp_code": code,
        })
        with pytest.raises(server.HTTPException):
            await server._consume_withdrawal_email_otp("user-otp", altered_request)
        assert challenge_store.docs[0]["status"] == "active"

        correct_request = request_payload.model_copy(update={
            "turnstile_token": "another-fresh-turnstile-token",
            "withdrawal_otp_challenge_id": challenge_id,
            "withdrawal_otp_code": code,
        })
        await server._consume_withdrawal_email_otp("user-otp", correct_request)
        assert challenge_store.docs[0]["status"] == "used"
        with pytest.raises(server.HTTPException):
            await server._consume_withdrawal_email_otp("user-otp", correct_request)

    asyncio.run(run())
    assert challenge_store.docs[0]["created_at"] <= challenge_store.docs[0]["expires_at"]
    assert challenge_store.docs[0]["expires_at"] <= now + timedelta(minutes=10, seconds=1)


def test_withdrawal_email_otp_expires_and_locks_after_five_wrong_codes(monkeypatch):
    otp_store = _Collection([{
        "id": "user-otp",
        "user_id": "user-otp",
        "challenge_id": "challenge-1",
        "request_fingerprint": "",
        "code_hash": "not-the-submitted-hash",
        "attempts": 0,
        "status": "active",
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
    }])
    monkeypatch.setattr(server, "db", SimpleNamespace(withdrawal_email_otps=otp_store))
    monkeypatch.setenv("SESSION_SECRET", "offline-session-secret")
    request_payload = TransferRequest(
        transfer_type="biz_to_biz",
        recipient="receiver",
        amount=100,
        currency="XOF",
        withdrawal_otp_challenge_id="challenge-1",
        withdrawal_otp_code="123456",
    )
    otp_store.docs[0]["request_fingerprint"] = server._withdrawal_transfer_fingerprint(
        request_payload
    )

    async def run():
        for attempt in range(5):
            with pytest.raises(server.HTTPException) as invalid:
                await server._consume_withdrawal_email_otp("user-otp", request_payload)
            assert invalid.value.status_code == 400
            if attempt < 4:
                assert otp_store.docs[0]["status"] == "active"
        assert otp_store.docs[0]["status"] == "locked"
        assert otp_store.docs[0]["attempts"] == 5

        otp_store.docs[0]["status"] = "active"
        otp_store.docs[0]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        with pytest.raises(server.HTTPException) as expired:
            await server._consume_withdrawal_email_otp("user-otp", request_payload)
        assert expired.value.status_code == 400

    asyncio.run(run())


def test_withdrawal_email_otp_issue_rate_limit(monkeypatch):
    limits = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(withdrawal_email_otp_limits=limits))
    results = asyncio.run(_withdrawal_rate_results())
    assert results == [True, True, True, False]


async def _withdrawal_rate_results():
    return [
        await server._allow_withdrawal_email_otp_request("user-otp")
        for _ in range(4)
    ]


async def _async_true(*_args, **_kwargs):
    return True


def test_admin_can_toggle_withdrawal_otp_independently(monkeypatch):
    settings = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(settings=settings))
    monkeypatch.setattr(server, "audit", _async_noop)
    monkeypatch.setenv("RESEND_API_KEY", "offline-resend-key")

    result = asyncio.run(server.admin_update_email_notifications(
        TransactionEmailSettingsUpdate(
            enabled=False,
            withdrawal_otp_enabled=True,
            sender_email="notifications@example.com",
            event_types=[],
            content_fields=[],
        ),
        {"id": "admin-1", "username": "admin"},
        "admin-1",
    ))
    assert result["withdrawal_otp_enabled"] is True
    assert result["withdrawal_otp_active"] is True
    assert result["active"] is False
    assert settings.docs[0]["enabled"] is False


def test_admin_cannot_enable_withdrawal_otp_without_resend(monkeypatch):
    settings = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(settings=settings))
    monkeypatch.delenv("RESEND_API_KEY", raising=False)

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.admin_update_email_notifications(
            TransactionEmailSettingsUpdate(
                enabled=False,
                withdrawal_otp_enabled=True,
                sender_email="notifications@example.com",
            ),
            {"id": "admin-1", "username": "admin"},
            "admin-1",
        ))
    assert error.value.status_code == 409
    assert settings.docs == []


def test_withdrawal_otp_provider_failure_creates_no_financial_transaction(monkeypatch):
    otp_store = _Collection()
    transaction_store = _Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(
        withdrawal_email_otps=otp_store,
        transactions=transaction_store,
    ))
    monkeypatch.setenv("SESSION_SECRET", "offline-session-secret")
    monkeypatch.setenv("RESEND_API_KEY", "offline-resend-key")
    monkeypatch.setattr(server, "_transaction_email_settings", lambda: _resolved({
        "sender_email": "notifications@example.com",
        "withdrawal_otp_enabled": True,
    }))
    monkeypatch.setattr(server, "_allow_withdrawal_email_otp_request", _async_true)

    async def fail_email(**_kwargs):
        raise RuntimeError("offline mock provider")

    monkeypatch.setattr(server, "send_resend_email", fail_email)
    req = TransferRequest(
        transfer_type="biz_to_biz",
        recipient="receiver",
        amount=100,
        currency="XOF",
        turnstile_token="unit-test-turnstile",
    )

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server._create_withdrawal_email_otp(
            {"id": "user-otp", "email": "member@example.com"}, req
        ))
    assert error.value.status_code == 503
    assert otp_store.docs[0]["status"] == "delivery_failed"
    assert transaction_store.docs == []