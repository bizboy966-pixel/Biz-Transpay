"""Local unit tests for the public developer API contracts.

These tests call the endpoint functions directly with a fake database.  They
never start the application, contact a payment provider, or mutate MongoDB.
"""

import asyncio
from functools import wraps
import sys
from types import SimpleNamespace
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def run_async(fn):
    """Keep this test file independent of pytest-asyncio."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return wrapper


def request(method="POST", path="/api/v1/test", headers=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": method, "path": path,
                    "headers": raw, "query_string": b""})


class FakeCollection:
    def __init__(self):
        self.docs = []
        self.queries = []

    async def create_index(self, *args, **kwargs):
        return "idx"

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return SimpleNamespace(inserted_id=doc.get("id"))

    async def find_one(self, query, projection=None, **kwargs):
        self.queries.append(query)
        def value(doc, key):
            for part in key.split("."):
                doc = doc.get(part, {}) if isinstance(doc, dict) else {}
            return doc
        def matches(doc):
            for key, expected in query.items():
                actual = value(doc, key)
                if isinstance(expected, dict):
                    if "$ne" in expected and actual == expected["$ne"]:
                        return False
                    if "$in" in expected and actual not in expected["$in"]:
                        return False
                    if "$nin" in expected and actual in expected["$nin"]:
                        return False
                elif actual != expected:
                    return False
            return True
        for doc in reversed(self.docs):
            if matches(doc):
                return dict(doc)
        return None

    async def update_one(self, query, update, **kwargs):
        def value(doc, key):
            for part in key.split("."):
                doc = doc.get(part, {}) if isinstance(doc, dict) else {}
            return doc
        for doc in reversed(self.docs):
            if all((not isinstance(v, dict) and value(doc, k) == v) or
                   (isinstance(v, dict) and
                    (("$ne" in v and value(doc, k) != v["$ne"]) or
                     ("$nin" in v and value(doc, k) not in v["$nin"])))
                   for k, v in query.items()):
                for key, value in update.get("$set", {}).items():
                    target = doc
                    parts = key.split(".")
                    for part in parts[:-1]:
                        target = target.setdefault(part, {})
                    target[parts[-1]] = value
                return SimpleNamespace(modified_count=1, matched_count=1)
        return SimpleNamespace(modified_count=0, matched_count=0)

    async def count_documents(self, query):
        return len(self.docs)


class FakeDB:
    def __init__(self):
        self.momo_deposits = FakeCollection()
        self.merchant_payments = FakeCollection()
        self.merchant_keys = FakeCollection()
        self.idempotency_keys = FakeCollection()
        self.transactions = FakeCollection()


def merchant(scopes=None, uid="merchant-a", env="test"):
    return {
        "id": uid, "account_type": "merchant", "_api_env": env,
        "_api_scopes": scopes or [
            "checkout:create", "direct:create", "push:create", "payments:read"
        ],
        "kyc_status": "verified",
    }


def payload_direct(**extra):
    values = {
        "amount": 1000, "currency": "XOF", "country": "TG",
        "operator": "moov_tg", "customer_phone": "90000000",
        "customer_email": "buyer@example.com", "reference": "order-1",
    }
    values.update(extra)
    return server.BizPayDirectRequest(**values)


@run_async
async def test_mutations_require_idempotency_key(monkeypatch):
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    cases = [
        (server.developer_checkout, server.DeveloperCheckoutRequest(
            amount=1000, currency="XOF", country="TG", operator="moov_tg")),
        (server.developer_direct_payment, payload_direct()),
        (server.developer_push, server.BizPushRequest(
            amount=1000, currency="XOF", country="TG", operator="moov_tg",
            beneficiary_phone="90000000")),
    ]
    for endpoint, body in cases:
        with pytest.raises(server.BizAPIError) as exc:
            await endpoint(body, request())
        assert exc.value.code == "IDEMPOTENCY_KEY_REQUIRED"


@run_async
async def test_scope_is_refused(monkeypatch):
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(
                            0, result=merchant(["payments:read"])))
    with pytest.raises(server.BizAPIError) as exc:
        await server.developer_direct_payment(
            payload_direct(), request(headers={"Idempotency-Key": "direct-1"}))
    assert exc.value.code == "API_SCOPE_REQUIRED"


@run_async
async def test_legacy_key_without_scope_field_keeps_compatibility(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    legacy = merchant()
    legacy.pop("_api_scopes")
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=legacy))
    with pytest.raises(server.BizAPIError) as exc:
        await server.merchant_get_payment("missing", request("GET"))
    # It reached the merchant-isolated lookup rather than scope rejection.
    assert exc.value.code == "PAYMENT_NOT_FOUND"


@run_async
async def test_checkout_sandbox_is_local_and_hides_provider(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    calls = []

    async def create(req, uid, flow, callback):
        calls.append((req, uid, flow))
        fake.momo_deposits.docs.append({
            "id": "checkout-1", "user_id": uid, "amount": req.amount,
            "currency": req.currency, "status": "pending",
            "checkout_url": "https://checkout.invalid/session",
            "provider": "paydunya", "created_at": "2024-01-01T00:00:00+00:00",
        })
        return {"id": "checkout-1", "checkout_url": "https://checkout.invalid/session"}

    monkeypatch.setattr(server, "_create_paydunya_invoice_deposit", create)
    monkeypatch.setattr(server.paydunya, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("sandbox must not call provider")))
    monkeypatch.setattr(server, "_idempotency_claim",
                        lambda *args: asyncio.sleep(0, result=None))
    monkeypatch.setattr(server, "_idempotency_store",
                        lambda *args: asyncio.sleep(0))
    result = await server.developer_checkout(
        server.DeveloperCheckoutRequest(
            amount=1000, currency="XOF", country="TG", operator="moov_tg",
            customer_email="buyer@example.com", reference="checkout-1"),
        request(headers={"Idempotency-Key": "checkout-key"}))
    assert not calls
    assert result["checkout_url"] is None
    assert result["simulation_endpoint"].startswith("/api/v1/test/payments/")
    assert "provider" not in result
    assert fake.momo_deposits.docs[0]["environment"] == "test"
    assert fake.momo_deposits.docs[0]["source"] == "merchant_api"
    assert fake.momo_deposits.docs[0]["reference"] == "checkout-1"


@run_async
async def test_direct_sandbox_has_no_provider_call_and_replays(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    monkeypatch.setattr(server, "get_paydunya_config",
                        lambda decrypt=False: asyncio.sleep(0, result={
                            "enabled": True, "mode": "test",
                            "catalog": [{"country": "TG", "code": "moov_tg",
                                         "currency": "XOF", "min": 100, "max": 500000,
                                         "active": True, "endpoint_slug": "moov-togo"}],
                        }))
    order = []
    monkeypatch.setattr(server.paydunya, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("sandbox must not call provider")))

    monkeypatch.setattr(server.paydunya, "softpay_payment",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("sandbox must not call provider")))
    stored = {}
    monkeypatch.setattr(server, "_idempotency_claim",
                        lambda *args: asyncio.sleep(0, result=None))

    async def store(*args):
        stored["body"] = args[-1]

    monkeypatch.setattr(server, "_idempotency_store", store)
    first = await server.developer_direct_payment(
        payload_direct(), request(headers={"Idempotency-Key": "direct-key"}))
    assert not order
    assert "provider" not in first

    async def replay(*args):
        return {"body": stored["body"], "status_code": 200}

    monkeypatch.setattr(server, "_idempotency_claim", replay)
    second = await server.developer_direct_payment(
        payload_direct(), request(headers={"Idempotency-Key": "direct-key"}))
    assert second == first
    assert len(fake.momo_deposits.docs) == 1
    assert fake.momo_deposits.docs[0]["environment"] == "test"


@run_async
async def test_live_direct_timeout_is_durable_and_unknown(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    live = merchant(env="live")
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=live))
    monkeypatch.setattr(server, "get_paydunya_config",
                        lambda decrypt=False: asyncio.sleep(0, result={
                            "enabled": True, "mode": "live",
                            "catalog": [{"country": "TG", "code": "moov_tg",
                                         "currency": "XOF", "min": 100, "max": 500000,
                                         "active": True}],
                        }))
    monkeypatch.setattr(server.paydunya, "create_invoice",
                        lambda *a, **k: asyncio.sleep(0, result={"token": "live-token"}))
    monkeypatch.setattr(server.paydunya, "invoice_token", lambda value: "live-token")
    monkeypatch.setattr(server.paydunya, "checkout_url",
                        lambda value: "/provider-url-must-not-leak")

    async def timeout(*args, **kwargs):
        raise server.paydunya.PayDunyaError(504, "timeout")

    monkeypatch.setattr(server.paydunya, "softpay_payment", timeout)
    saved = {}

    async def claim(*args):
        return None

    async def store(*args):
        saved["body"] = args[-1]

    monkeypatch.setattr(server, "_idempotency_claim", claim)
    monkeypatch.setattr(server, "_idempotency_store", store)
    with pytest.raises(server.BizAPIError):
        await server.developer_direct_payment(
            payload_direct(reference="live-timeout"),
            request(headers={"Idempotency-Key": "live-timeout-key"}))
    assert len(fake.momo_deposits.docs) == 1
    doc = fake.momo_deposits.docs[0]
    assert doc["environment"] == "live"
    assert doc["source"] == "merchant_api"
    assert doc["provider_status_unknown"] is True
    assert saved["body"]["id"] == doc["id"]


@run_async
async def test_environment_isolation_in_payment_read_query(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(
                            0, result=merchant(uid="merchant-a", env="live")))
    with pytest.raises(server.BizAPIError):
        await server.merchant_get_payment("sandbox-id", request("GET"))
    assert fake.momo_deposits.queries[0]["$or"] == [
        {"environment": "live"}, {"environment": {"$exists": False}}
    ]


@run_async
async def test_push_get_status_isolated_and_sandbox_completion_webhook_once(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    m = merchant()
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=m))
    await server.developer_push(
        server.BizPushRequest(amount=1000, currency="XOF", country="TG",
                              operator="moov_tg", beneficiary_phone="90000000"),
        request(headers={"Idempotency-Key": "push-get"}))
    # The push dedicated reader uses merchant+environment and does not expose
    # another merchant's transaction.
    push_id = fake.transactions.docs[0]["id"]
    detail = await server.developer_push_details(push_id, request("GET"))
    assert detail["id"] == push_id
    assert fake.transactions.queries[-1]["metadata.environment"] == "test"

    payment = {
        "id": "sandbox-checkout", "merchant_id": m["id"],
        "environment": "test", "product": "bizpay_checkout",
        "status": "initiated", "amount": 1000, "coin": "XOF",
        "reference": "sandbox-ref", "created_at": "2024-01-01T00:00:00+00:00",
    }
    await fake.merchant_payments.insert_one(payment)
    events = []
    async def capture_webhook(*args):
        events.append(args)
    monkeypatch.setattr(server, "_deliver_webhook", capture_webhook)
    first = await server.complete_sandbox_payment(
        "sandbox-checkout", request(headers={}))
    second = await server.complete_sandbox_payment(
        "sandbox-checkout", request(headers={}))
    assert first["status"] == second["status"] == "paid"
    assert len(events) == 1
    assert fake.merchant_payments.docs[0].get("test_webhook_claimed") is True


@run_async
async def test_payment_read_is_merchant_isolated(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant(uid="merchant-a")))
    with pytest.raises(server.BizAPIError) as exc:
        await server.merchant_get_payment("belongs-to-b", request("GET"))
    assert exc.value.code == "PAYMENT_NOT_FOUND"
    assert fake.momo_deposits.queries[0]["user_id"] == "merchant-a"


@run_async
async def test_push_sandbox_does_not_transfer_and_hides_metadata(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    monkeypatch.setattr(server, "_idempotency_claim",
                        lambda *args: asyncio.sleep(0, result=None))
    monkeypatch.setattr(server, "_idempotency_store",
                        lambda *args: asyncio.sleep(0))
    captured = {}

    async def fake_transfer(req, request_obj, uid):
        captured["request"] = req
        return {"fee": 5, "total_debit": 1005, "transaction": {
            "id": "push-1", "status": "pending", "amount": 1000,
            "currency": "XOF", "reference": "push-ref",
            "created_at": "2024-01-01T00:00:00+00:00",
            "metadata": {"provider": "paydunya", "secret": "hidden"},
        }}

    monkeypatch.setattr(server, "transfer", fake_transfer)
    result = await server.developer_push(
        server.BizPushRequest(
            amount=1000, currency="XOF", country="TG", operator="moov_tg",
            beneficiary_phone="90000000", reference="push-ref"),
        request(headers={"Idempotency-Key": "push-key"}))
    assert not captured
    assert "provider" not in result and "secret" not in result
    assert result["status"] == "pending"
    assert fake.transactions.docs[0]["metadata"]["source"] == "merchant_api"
    assert fake.transactions.docs[0]["metadata"]["environment"] == "test"


@run_async
async def test_key_creation_rejects_unknown_scope(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_ensure_api_keys",
                        lambda *args: asyncio.sleep(0, result={}))
    with pytest.raises(HTTPException) as exc:
        await server.create_merchant_key(
            server.CreateMerchantKeyReq(name="bad", scopes=["admin:all"]),
            uid="merchant-a", request=request())
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "INVALID_API_SCOPE"


@run_async
async def test_paydunya_push_success_emits_public_webhook(monkeypatch):
    fake = FakeDB()
    fake.transactions.docs.append({
        "id": "tx-success",
        "status": "pending",
        "merchant_webhook_claimed": False,
    })
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(
        server, "get_paydunya_config",
        lambda decrypt=False: asyncio.sleep(0, result={}),
    )
    monkeypatch.setattr(
        server.paydunya, "check_disbursement_status",
        lambda *args, **kwargs: asyncio.sleep(0, result={
            "response_code": "00",
            "token": "invoice-token",
            "amount": 2500,
            "withdraw_mode": "t-money-togo",
            "disburse_id": "push-ref",
            "status": "completed",
        }),
    )
    monkeypatch.setattr(server, "notify", lambda *args, **kwargs: asyncio.sleep(0))
    events = []

    async def deliver(user_id, event, data):
        events.append((user_id, event, data))

    monkeypatch.setattr(server, "_deliver_webhook", deliver)
    tx = {
        "id": "tx-success", "user_id": "merchant-a", "reference": "push-ref",
        "amount": 2500, "currency": "XOF", "status": "pending",
        "metadata": {
            "source": "merchant_api",
            "merchant_reference": "PUSH-42",
            "paydunya_invoice_token": "invoice-token",
            "paydunya_disbursement_id": "provider-id",
            "paydunya_withdraw_mode": "t-money-togo",
            "recipient_gets": 2500,
        },
    }
    assert await server._reconcile_mobile_withdrawal(tx) == "completed"
    assert events[0][0:2] == ("merchant-a", "push.succeeded")
    assert "provider" not in events[0][2]