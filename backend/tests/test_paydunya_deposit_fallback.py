import asyncio
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class _WriteResult:
    modified_count = 1


class _Deposits:
    def __init__(self):
        self.docs = []

    async def create_index(self, *args, **kwargs):
        return None

    async def find_one(self, query, projection=None):
        for doc in self.docs:
            if all(doc.get(key) == value for key, value in query.items()):
                return dict(doc)
        return None

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return _WriteResult()

    async def update_one(self, query, update):
        for doc in self.docs:
            if all(doc.get(key) == value for key, value in query.items()):
                doc.update(update.get("$set", {}))
                return _WriteResult()
        return _WriteResult()


class _DB:
    def __init__(self):
        self.momo_deposits = _Deposits()


def _request():
    return Request({
        "type": "http",
        "method": "POST",
        "scheme": "https",
        "path": "/api/deposits/mobile-money",
        "query_string": b"",
        "headers": [(b"host", b"example.test")],
        "server": ("example.test", 443),
        "client": ("127.0.0.1", 1234),
    })


def test_softpay_timeout_keeps_tracker_inside_biztranspay(monkeypatch):
    fake_db = _DB()
    monkeypatch.setattr(server, "db", fake_db)
    config = {
        "enabled": True,
        "mode": "live",
        "store_name": "Biz-transPay",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "TG",
            "code": "togocel_tg",
            "name": "TogoCom",
            "currency": "XOF",
            "endpoint_slug": "t-money-togo",
            "active": True,
            "min": 100,
            "max": 500000,
            "fee_pct": 0,
        }],
        "_credentials": {
            "master_key": "configured",
            "private_key": "configured",
            "token": "configured",
        },
    }
    monkeypatch.setattr(
        server,
        "get_paydunya_config",
        lambda decrypt=False: asyncio.sleep(0, result=config),
    )
    monkeypatch.setattr(
        server.paydunya,
        "create_invoice",
        lambda *args, **kwargs: asyncio.sleep(0, result={
            "token": "invoice-token",
            "checkout_url": "https://app.paydunya.com/checkout/invoice-token",
        }),
    )
    monkeypatch.setattr(
        server,
        "_paydunya_public_config",
        lambda config: {"enabled": True, "mobile_money_enabled": True},
    )

    async def timeout(*args, **kwargs):
        raise server.paydunya.PayDunyaError(502, "PayDunya unreachable: timeout")

    monkeypatch.setattr(server.paydunya, "softpay_payment", timeout)
    result = asyncio.run(server.create_mobile_money_deposit(
        server.MobileMoneyDepositRequest(
            amount=1000,
            currency="XOF",
            email="buyer@example.test",
            full_name="Test Buyer",
            country="TG",
            operator="togocel_tg",
            phone_number="90112233",
        ),
        _request(),
        "user-1",
    ))

    assert result["status"] == "pending"
    assert result["payment_kind"] == "phone"
    assert result["payment_fallback"] is None
    assert result["prompt_sent"] is False
    assert result["submission_unknown"] is True
    assert result["redirect_url"] is None
    assert result["checkout_url"] is None
    stored = fake_db.momo_deposits.docs[0]
    assert stored["status"] == "pending"
    assert stored["payment_fallback"] == "hosted_checkout"
    assert stored["submission_unknown"] is True
    assert "failed_at" not in stored
    public = server._public_momo_deposit(stored)
    assert public["payment_kind"] == "phone"
    assert public["payment_fallback"] is None
    assert public["redirect_url"] is None
    assert public["checkout_url"] is None
    assert "ne relancez pas" in public["message"]


def test_softpay_response_checkout_url_is_not_a_customer_redirect(monkeypatch):
    fake_db = _DB()
    monkeypatch.setattr(server, "db", fake_db)
    config = {
        "enabled": True,
        "mode": "live",
        "store_name": "Biz-transPay",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "TG",
            "code": "togocel_tg",
            "name": "TogoCom",
            "currency": "XOF",
            "endpoint_slug": "t-money-togo",
            "active": True,
            "min": 100,
            "max": 500000,
            "fee_pct": 0,
        }],
        "_credentials": {
            "master_key": "configured",
            "private_key": "configured",
            "token": "configured",
        },
    }
    monkeypatch.setattr(
        server,
        "get_paydunya_config",
        lambda decrypt=False: asyncio.sleep(0, result=config),
    )
    monkeypatch.setattr(
        server.paydunya,
        "create_invoice",
        lambda *args, **kwargs: asyncio.sleep(0, result={
            "token": "invoice-token",
            "checkout_url": "https://app.paydunya.com/checkout/invoice-token",
        }),
    )
    monkeypatch.setattr(
        server,
        "_paydunya_public_config",
        lambda config: {"enabled": True, "mobile_money_enabled": True},
    )
    monkeypatch.setattr(
        server.paydunya, "checkout_url",
        lambda response: "https://app.paydunya.com/checkout/softpay-response",
    )
    monkeypatch.setattr(
        server.paydunya,
        "softpay_payment",
        lambda *args, **kwargs: asyncio.sleep(0, result={
            "response_code": "00",
            "checkout_url": "https://app.paydunya.com/checkout/softpay-response",
        }),
    )

    result = asyncio.run(server.create_mobile_money_deposit(
        server.MobileMoneyDepositRequest(
            amount=1000,
            currency="XOF",
            email="buyer@example.test",
            full_name="Test Buyer",
            country="TG",
            operator="togocel_tg",
            phone_number="90112233",
        ),
        _request(),
        "user-1",
    ))

    assert result["payment_kind"] == "phone"
    assert result["redirect_url"] is None
    assert result["checkout_url"] is None
    stored = fake_db.momo_deposits.docs[0]
    assert stored["redirect_url"].startswith("https://app.paydunya.com/")
    public = server._public_momo_deposit(stored)
    assert public["payment_kind"] == "phone"
    assert public["redirect_url"] is None
    assert public["checkout_url"] is None


def test_customer_retry_reuses_the_same_deposit(monkeypatch):
    fake_db = _DB()
    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(
        server,
        "_resolve_deposit_provider",
        lambda *args, **kwargs: asyncio.sleep(0, result="paydunya"),
    )
    monkeypatch.setattr(
        server,
        "get_paydunya_config",
        lambda decrypt=False: asyncio.sleep(0, result={
            "enabled": True,
            "mobile_money_enabled": True,
            "modes": {"softpay_direct": {"enabled": True}},
            "catalog": [],
        }),
    )
    monkeypatch.setattr(
        server,
        "_paydunya_public_config",
        lambda config: {"enabled": True, "mobile_money_enabled": True},
    )
    claims = []
    stores = []
    monkeypatch.setattr(
        server,
        "_idempotency_claim",
        lambda *args, **kwargs: (
            claims.append(args) or asyncio.sleep(0, result=None)
        ),
    )
    monkeypatch.setattr(
        server,
        "_idempotency_store",
        lambda *args, **kwargs: (
            stores.append(args) or asyncio.sleep(0, result=None)
        ),
    )
    calls = []

    async def create(req, request, uid):
        calls.append(req.idempotency_key)
        doc = {
            "id": "deposit-1",
            "user_id": uid,
            "provider": "paydunya",
            "status": "pending",
            "amount": req.amount,
            "currency": req.currency,
            "idempotency_key": req.idempotency_key,
            "request_fingerprint": server._request_fingerprint(req),
            "checkout_url": "https://app.paydunya.com/checkout/invoice-token",
        }
        await fake_db.momo_deposits.insert_one(doc)
        return {
            "id": doc["id"],
            "status": "pending",
            "payment_kind": "redirect",
            "checkout_url": doc["checkout_url"],
        }

    monkeypatch.setattr(server, "create_mobile_money_deposit", create)
    request_model = server.MobileMoneyDepositRequest(
        amount=1000,
        currency="XOF",
        email="buyer@example.test",
        full_name="Test Buyer",
        country="TG",
        operator="togocel_tg",
        phone_number="90112233",
        idempotency_key="same-request-key",
    )
    first = asyncio.run(server.start_mobile_money_deposit(
        request_model, _request(), "user-1"))
    second = asyncio.run(server.start_mobile_money_deposit(
        request_model, _request(), "user-1"))

    assert first["id"] == second["id"] == "deposit-1"
    assert calls == ["same-request-key"]
    assert len(claims) == 1
    assert len(stores) == 1


def test_late_verified_paydunya_payment_is_still_credited(monkeypatch):
    fake_db = _DB()
    fake_db.momo_deposits.docs.append({
        "id": "deposit-late",
        "user_id": "user-1",
        "provider": "paydunya",
        "status": "failed",
        "retryable": False,
        "paydunya_token": "invoice-token",
        "charged_amount": 1000,
        "amount": 1000,
        "currency": "XOF",
    })
    monkeypatch.setattr(server, "db", fake_db)
    master_key = "master"
    monkeypatch.setattr(
        server,
        "get_paydunya_config",
        lambda decrypt=False: asyncio.sleep(0, result={
            "_credentials": {"master_key": master_key},
        }),
    )
    monkeypatch.setattr(
        server.paydunya,
        "confirm_invoice",
        lambda *args, **kwargs: asyncio.sleep(0, result={
            "response_code": "00",
            "status": "completed",
            "token": "invoice-token",
            "amount": 1000,
            "currency": "XOF",
            "hash": hashlib.sha512(master_key.encode()).hexdigest(),
        }),
    )
    credited = []
    monkeypatch.setattr(
        server,
        "_credit_momo_deposit",
        lambda deposit: (
            credited.append(deposit["id"]) or asyncio.sleep(0)
        ),
    )

    assert asyncio.run(server._reconcile_momo_deposit("deposit-late")) is True
    assert credited == ["deposit-late"]


def test_pre_invoice_failure_releases_idempotency_reservation(monkeypatch):
    fake_db = _DB()
    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(
        server,
        "_idempotency_claim",
        lambda *args, **kwargs: asyncio.sleep(0, result=None),
    )
    released = []
    monkeypatch.setattr(
        server,
        "_idempotency_release",
        lambda *args, **kwargs: (
            released.append(args) or asyncio.sleep(0)
        ),
    )

    async def unavailable(*args, **kwargs):
        raise HTTPException(503, "provider unavailable")

    monkeypatch.setattr(server, "_resolve_deposit_provider", unavailable)
    request_model = server.MobileMoneyDepositRequest(
        amount=1000,
        currency="XOF",
        email="buyer@example.test",
        full_name="Test Buyer",
        country="TG",
        operator="togocel_tg",
        phone_number="90112233",
        idempotency_key="retryable-request-key",
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.start_mobile_money_deposit(
            request_model, _request(), "user-1"))

    assert exc.value.status_code == 503
    assert len(released) == 1
    assert released[0][1] == "momo-deposit:retryable-request-key"