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


def test_public_mobile_money_config_hides_provider_identity():
    config = server._mbiyo_public_config({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{
            "country": "GN", "country_label": "Guinée",
            "code": "mbiyo_orange_gn", "network": "orange",
            "name": "Orange Money", "currency": "GNF",
            "min": 500, "max": 1500000, "active": True,
        }],
    })
    assert config["catalog"][0]["code"] == "orange_gn"
    assert "provider" not in config["catalog"][0]
    fees = server._public_fee_provider_mobile_money(config["catalog"])
    assert "provider" not in fees["operators"][0]


def test_mbiyo_public_config_exposes_split_admin_fees():
    config = server._mbiyo_public_config({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{
            "country": "TG", "code": "mbiyo_moov_tg", "network": "moov",
            "name": "Moov Money", "currency": "XOF", "active": True,
            "gateway_fee_pct": 1.5, "platform_fee_pct": 2,
            "gateway_fee_fixed": 10, "platform_fee_fixed": 5,
        }],
    })
    assert config["catalog"][0]["fee_pct"] == 3.5
    assert config["catalog"][0]["fee_fixed"] == 15


@run_async
async def test_deposit_provider_falls_back_to_beyond_pay_when_paydunya_has_no_mode(
        monkeypatch):
    async def value(payload):
        return payload

    shared_route = {
        "country": "TG", "code": "tmoney_tg", "currency": "XOF",
        "active": True,
    }
    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {
            "softpay_direct": {"enabled": False},
            "psr": {"enabled": False},
            "par_redirect": {"enabled": False},
        },
        "catalog": [shared_route],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{**shared_route, "code": "mbiyo_tmoney_tg"}],
    }))

    assert await server._resolve_deposit_provider(
        "TG", "tmoney_tg", "XOF"
    ) == "mbiyo"


@run_async
async def test_deposit_provider_uses_paydunya_when_its_route_is_ready(
        monkeypatch):
    async def value(payload):
        return payload

    shared_route = {
        "country": "TG", "code": "tmoney_tg", "currency": "XOF",
        "active": True,
    }
    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [shared_route],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{**shared_route, "code": "mbiyo_tmoney_tg"}],
    }))

    assert await server._resolve_deposit_provider(
        "TG", "tmoney_tg", "XOF"
    ) == "paydunya"


@run_async
async def test_direct_deposit_route_does_not_use_redirect_only_paydunya(
        monkeypatch):
    async def value(payload):
        return payload

    shared_route = {
        "country": "TG", "code": "tmoney_tg", "currency": "XOF",
        "active": True,
    }
    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {
            "softpay_direct": {"enabled": False},
            "par_redirect": {"enabled": True},
        },
        "catalog": [shared_route],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [{**shared_route, "code": "mbiyo_tmoney_tg"}],
    }))

    assert await server._resolve_deposit_provider(
        "TG", "tmoney_tg", "XOF", required_mode="softpay_direct"
    ) == "mbiyo"


@run_async
async def test_unavailable_deposit_route_error_does_not_expose_provider(
        monkeypatch):
    async def value(payload):
        return payload

    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "TG", "code": "tmoney_tg",
            "currency": "XOF", "active": True,
        }],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": False, "catalog": [],
    }))

    with pytest.raises(HTTPException) as exc:
        await server._resolve_deposit_provider(
            "TG", "tmoney_tg", "XOF"
        )
    assert exc.value.status_code == 503
    assert "paydunya" not in str(exc.value.detail).lower()
    assert "mbiyo" not in str(exc.value.detail).lower()


def test_public_withdrawal_config_keeps_distinct_active_provider_routes():
    config = server._public_transfer_config({
        "mobile_money": {
            "enabled": True,
            "operators": [{
                "country": "TG", "code": "t-money-togo",
                "name": "TMoney", "currency": "XOF", "active": True,
                "withdraw_mode": "t-money-togo",
            }],
        },
        "paydunya": {"enabled": True},
        "mbiyo": {
            "enabled": True,
            "operators": [{
                "country": "TG", "code": "mbiyo_moov_tg",
                "name": "Moov Money", "currency": "XOF", "active": True,
            }],
        },
    })

    operators = config["mobile_money"]["operators"]
    assert config["mobile_money"]["enabled"] is True
    assert {operator["code"] for operator in operators} == {
        "t-money-togo", "moov_tg",
    }
    assert all("provider" not in operator for operator in operators)


def test_public_withdrawal_config_exposes_beyond_pay_fees_without_provider_name():
    config = server._public_transfer_config({
        "mobile_money": {"enabled": True, "operators": []},
        "paydunya": {"enabled": False},
        "mbiyo": {
            "enabled": True,
            "operators": [{
                "country": "TG", "country_label": "Togo",
                "code": "mbiyo_tmoney_tg", "name": "TMoney",
                "currency": "XOF", "active": True,
                "gateway_fee_pct": 1.5, "platform_fee_pct": 0.5,
                "gateway_fee_fixed": 10, "platform_fee_fixed": 15,
                "min": 100, "max": 500000,
            }],
        },
    })

    mobile_money = config["mobile_money"]
    assert mobile_money["enabled"] is True
    assert len(mobile_money["operators"]) == 1
    operator = mobile_money["operators"][0]
    assert operator["code"] == "tmoney_tg"
    assert operator["fee_pct"] == 2
    assert operator["fee_fixed"] == 25
    assert "provider" not in operator
    assert "mbiyo" not in config
    assert "paydunya" not in config


@run_async
async def test_customer_fee_grid_uses_effective_beyond_pay_withdrawal_catalog(
        monkeypatch):
    async def value(payload):
        return payload

    withdrawal = {
        "mobile_money": {"enabled": True, "operators": []},
        "paydunya": {"enabled": False},
        "mbiyo": {
            "enabled": True,
            "operators": [{
                "country": "BJ", "country_label": "Bénin",
                "code": "mbiyo_mtn_bj", "name": "MTN MoMo",
                "currency": "XOF", "active": True,
                "gateway_fee_pct": 1, "platform_fee_pct": 2,
                "gateway_fee_fixed": 5, "platform_fee_fixed": 10,
                "min": 500, "max": 1000000,
            }],
        },
        "crypto": {"enabled": False},
    }
    monkeypatch.setattr(
        server, "get_deposit_config",
        lambda: value({"crypto": {"enabled": False}}))
    monkeypatch.setattr(
        server, "get_transfer_config", lambda: value(withdrawal))
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda: value({"enabled": False}))
    monkeypatch.setattr(
        server, "get_mbiyo_config", lambda: value({"enabled": False}))
    monkeypatch.setattr(
        server, "get_platform_config", lambda: value({}))

    result = await server.public_fees_config(uid="customer-1")
    mobile_money = result["withdrawal"]["mobile_money"]
    assert mobile_money["enabled"] is True
    assert mobile_money["operators"][0]["name"] == "MTN MoMo"
    assert mobile_money["operators"][0]["fee_pct"] == 3
    assert mobile_money["operators"][0]["fee_fixed"] == 15
    assert "provider" not in mobile_money["operators"][0]


def test_mbiyo_transaction_id_ignores_unrelated_nested_ids():
    assert server._mbiyo_transaction_id({
        "data": {
            "transaction_id": "MBIYO-123",
            "customer": {"id": "CUSTOMER-9"},
        },
    }) == "MBIYO-123"
    assert server._mbiyo_transaction_id({
        "data": {"customer": {"id": "CUSTOMER-9"}},
    }) is None


def test_mbiyo_phone_match_accepts_country_prefix_but_rejects_other_number():
    assert server._same_mobile_number("22891978352", "91978352")
    assert server._same_mobile_number("+228 91 97 83 52", "91978352")
    assert server._same_mobile_number("00228 91 97 83 52", "+22891978352")
    assert not server._same_mobile_number("22890978352", "91978352")
    assert not server._same_mobile_number("8352", "91978352")


def test_provider_neutral_route_resolves_internal_mbiyo_code():
    catalog = [{
        "country": "GN", "code": "mbiyo_orange_gn",
        "network": "orange", "active": True,
    }]
    assert server._active_mbiyo_operator(
        catalog, "GN", "orange_gn")["network"] == "orange"


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
                for key in update.get("$unset", {}):
                    target = doc
                    parts = key.split(".")
                    for part in parts[:-1]:
                        target = target.get(part, {})
                    if isinstance(target, dict):
                        target.pop(parts[-1], None)
                return SimpleNamespace(modified_count=1, matched_count=1)
        if kwargs.get("upsert"):
            created = dict(query)
            for key, value in update.get("$set", {}).items():
                target = created
                parts = key.split(".")
                for part in parts[:-1]:
                    target = target.setdefault(part, {})
                target[parts[-1]] = value
            self.docs.append(created)
            return SimpleNamespace(modified_count=1, matched_count=1)
        return SimpleNamespace(modified_count=0, matched_count=0)

    async def count_documents(self, query):
        return len(self.docs)

    async def replace_one(self, query, replacement, **kwargs):
        for index, doc in enumerate(self.docs):
            if all(doc.get(key) == value for key, value in query.items()):
                self.docs[index] = dict(replacement)
                return SimpleNamespace(modified_count=1, upserted_id=None)
        if kwargs.get("upsert"):
            self.docs.append(dict(replacement))
            return SimpleNamespace(modified_count=0, upserted_id=replacement.get("id"))
        return SimpleNamespace(modified_count=0, upserted_id=None)

    async def delete_one(self, query):
        for index, doc in enumerate(self.docs):
            if all(doc.get(key) == value for key, value in query.items()):
                self.docs.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


class FakeDB:
    def __init__(self):
        self.momo_deposits = FakeCollection()
        self.link_payments = FakeCollection()
        self.merchant_payments = FakeCollection()
        self.merchant_payouts = FakeCollection()
        self.merchant_keys = FakeCollection()
        self.api_keys = FakeCollection()
        self.idempotency_keys = FakeCollection()
        self.transactions = FakeCollection()


def merchant(scopes=None, uid="merchant-a", env="test"):
    return {
        "id": uid, "account_type": "merchant", "_api_env": env,
        "_api_scopes": scopes or [
            "checkout:create", "direct:create", "psr:create", "push:create",
            "payments:read"
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
async def test_idempotency_key_cannot_be_reused_on_another_payment_route(monkeypatch):
    fake = FakeDB()
    fake.idempotency_keys.docs.append({
        "user_id": "merchant-a:test", "key": "shared-attempt",
        "method": "POST", "path": "/api/v1/direct-payments",
        "fingerprint": "same-payload", "body": {"id": "direct-payment"},
        "expires_at": (server.datetime.now(server.timezone.utc)
                       + server.timedelta(hours=1)).isoformat(),
    })
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(server.BizAPIError) as exc:
        await server._idempotency_claim(
            "merchant-a:test", "shared-attempt", "POST", "/api/v1/psr",
            "same-payload")

    assert exc.value.code == "IDEMPOTENCY_KEY_REUSED"


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
async def test_psr_requires_its_own_scope(monkeypatch):
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(
                            0, result=merchant(["direct:create"])))
    with pytest.raises(server.BizAPIError) as exc:
        await server.developer_psr_payment(
            server.DeveloperCheckoutRequest(
                amount=1000, currency="XOF", country="TG",
                operator="moov_tg"),
            request(headers={"Idempotency-Key": "psr-scope-key"}),
        )
    assert exc.value.code == "API_SCOPE_REQUIRED"
    assert exc.value.details["required_scope"] == "psr:create"


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
    monkeypatch.setattr(server, "get_paydunya_config",
                        lambda decrypt=False: asyncio.sleep(0, result={
                            "enabled": True, "mode": "test",
                            "catalog": [{"country": "TG", "code": "moov_tg",
                                         "currency": "XOF", "min": 100, "max": 500000,
                                         "active": True, "fee_pct": 2}],
                        }))
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
    assert result["fee"] == "20.00"
    assert result["charged_amount"] == "1020.00"
    assert result["wallet_credit_amount"] == "1000.00"


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
async def test_psr_sandbox_is_local_and_uses_its_own_scope(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    monkeypatch.setattr(
        server, "_developer_operator",
        lambda *args, **kwargs: asyncio.sleep(0, result=(
            {"_gateway_provider": "paydunya"},
            {"country": "TG", "code": "tmoney_tg", "currency": "XOF",
             "fee_pct": 2, "min": 100, "max": 500000},
        )),
    )
    monkeypatch.setattr(server.paydunya, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("sandbox must not call provider")))
    monkeypatch.setattr(server, "_create_paydunya_invoice_deposit",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("sandbox must not create provider invoice")))
    saved = {}

    async def claim(*args):
        return None

    async def store(*args):
        saved["body"] = args[-1]

    monkeypatch.setattr(server, "_idempotency_claim", claim)
    monkeypatch.setattr(server, "_idempotency_store", store)
    result = await server.developer_psr_payment(
        server.DeveloperCheckoutRequest(
            amount=1000, currency="XOF", country="TG", operator="tmoney_tg",
            customer_name="Afi Mensah", reference="psr-test-1"),
        request(headers={"Idempotency-Key": "psr-test-key"}),
    )

    assert result["product"] == "bizpay_psr"
    assert result["psr_token_url"] is None
    assert result["simulation_endpoint"].endswith("/complete")
    assert result["checkout_url"] is None
    assert result["fee"] == "20.00"
    assert fake.momo_deposits.docs[0]["environment"] == "test"
    assert fake.momo_deposits.docs[0]["source"] == "merchant_api"
    assert saved["body"]["psr_token_url"] is None


@run_async
async def test_psr_live_returns_ephemeral_capability_and_reissues_on_replay(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    live = merchant(env="live")
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=live))
    monkeypatch.setattr(
        server, "_developer_operator",
        lambda *args, **kwargs: asyncio.sleep(0, result=(
            {"_gateway_provider": "paydunya"},
            {"country": "TG", "code": "tmoney_tg", "currency": "XOF",
             "fee_pct": 2},
        )),
    )
    calls = []

    async def create(req, uid, flow, callback, idempotency_key=None):
        calls.append((req, uid, flow, callback, idempotency_key))
        await fake.momo_deposits.insert_one({
            "id": "psr-live-1", "user_id": uid, "merchant_id": uid,
            "environment": "live", "product": "bizpay_psr",
            "paydunya_flow": flow, "status": "pending", "amount": 1000,
            "currency": "XOF", "checkout_url": "https://provider.invalid/hidden",
            "idempotency_key": idempotency_key,
        })
        return {
            "id": "psr-live-1",
            "psr_token_url": "/api/deposits/paydunya/psr/psr-live-1/token/first-capability",
        }

    monkeypatch.setattr(server, "_create_paydunya_invoice_deposit", create)
    monkeypatch.setattr(server.secrets, "token_urlsafe",
                        lambda *args: "fresh-capability")
    saved = {}

    async def claim(*args):
        return ({"body": saved["body"]} if saved else None)

    async def store(*args):
        saved["body"] = args[-1]

    monkeypatch.setattr(server, "_idempotency_claim", claim)
    monkeypatch.setattr(server, "_idempotency_store", store)
    req = request(headers={"Idempotency-Key": "psr-live-key"})
    payload = server.DeveloperCheckoutRequest(
        amount=1000, currency="XOF", country="TG", operator="tmoney_tg",
        customer_name="Afi Mensah", reference="psr-live-1")
    first = await server.developer_psr_payment(payload, req)
    second = await server.developer_psr_payment(payload, req)

    assert len(calls) == 1
    assert calls[0][2] == "psr"
    assert first["psr_token_url"].endswith("first-capability")
    assert second["psr_token_url"].endswith("fresh-capability")
    assert first["checkout_url"] is None
    assert saved["body"]["psr_token_url"] is None
    stored = fake.momo_deposits.docs[0]
    assert stored["product"] == "bizpay_psr"
    assert stored["environment"] == "live"
    assert stored["reference"] == "psr-live-1"
    assert stored["psr_capability_hash"] == server.hashlib.sha256(
        b"fresh-capability").hexdigest()
    assert "first-capability" not in str(stored)


@run_async
async def test_shared_payment_reads_find_psr_records(monkeypatch):
    fake = FakeDB()
    fake.momo_deposits.docs.append({
        "id": "psr-paid", "user_id": "merchant-a", "merchant_id": "merchant-a",
        "environment": "test", "product": "bizpay_psr", "status": "approved",
        "amount": 1000, "currency": "XOF", "reference": "PSR-REF",
    })
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))

    full = await server.merchant_get_payment("psr-paid", request("GET"))
    status = await server.merchant_get_payment_status("psr-paid", request("GET"))
    completed = await server.merchant_check_completed("psr-paid", request("GET"))
    search = await server.merchant_search_payment(
        request("GET"), reference="PSR-REF")

    assert full["product"] == "bizpay_psr"
    assert full["status"] == "paid"
    assert status["status"] == "paid"
    assert completed["completed"] is True
    assert search["id"] == "psr-paid"


@run_async
async def test_sandbox_completion_accepts_psr_records(monkeypatch):
    fake = FakeDB()
    fake.momo_deposits.docs.append({
        "id": "psr-test", "user_id": "merchant-a", "merchant_id": "merchant-a",
        "environment": "test", "product": "bizpay_psr", "status": "pending",
        "amount": 1000, "currency": "XOF", "reference": "PSR-TEST",
    })
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    delivered = []

    async def deliver(*args):
        delivered.append(args)

    monkeypatch.setattr(server, "_deliver_webhook", deliver)
    result = await server.complete_sandbox_payment(
        "psr-test", request(headers={"Authorization": "Bearer sk_test_dummy"}))

    assert result["status"] == "paid"
    assert fake.momo_deposits.docs[0]["status"] == "paid"
    assert len(delivered) == 1


@run_async
async def test_crypto_payment_sandbox_snapshots_fee(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    monkeypatch.setattr(server, "get_deposit_config",
                        lambda: asyncio.sleep(0, result={
                            "crypto": {
                                "fees": {"USDT": 4},
                                "fees_gateway": {"USDT": 3},
                                "fees_platform": {"USDT": 1},
                            },
                        }))
    monkeypatch.setattr(server, "get_transfer_config",
                        lambda: asyncio.sleep(0, result={"crypto": {"fees": {"USDT": 4}}}))
    monkeypatch.setattr(server, "izipay",
                        SimpleNamespace(is_configured=lambda: False))
    monkeypatch.setattr(server, "_idempotency_claim",
                        lambda *args: asyncio.sleep(0, result=None))
    monkeypatch.setattr(server, "_idempotency_store",
                        lambda *args: asyncio.sleep(0))

    result = await server.merchant_create_payment(
        server.MerchantPaymentRequest(amount=100, coin="USDT"),
        request(headers={"Idempotency-Key": "crypto-test-key"}),
    )

    assert result["amount_gross"] == "100.00"
    assert result["amount_net"] == "96.00"
    assert result["fee"] == "4.00"
    assert result["gateway_fee"] == "3.00"
    assert result["platform_fee"] == "1.00"
    assert fake.merchant_payments.docs[0]["amount_net"] == 96
    assert fake.merchant_payments.docs[0]["fee"] == 4


@run_async
async def test_legacy_payments_route_dispatches_mobile_money(monkeypatch):
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    captured = {}

    async def fake_checkout(payload, req, product, idem_path="/api/v1/checkout"):
        captured.update({
            "payload": payload,
            "product": product,
            "idem_path": idem_path,
        })
        return {"id": "momo-1", "status": "pending"}

    monkeypatch.setattr(server, "_developer_checkout", fake_checkout)
    result = await server.merchant_create_payment(
        server.MerchantPaymentRequest(
            amount=1000,
            payment_method="mobile_money",
            currency="XOF",
            country="TG",
            operator="mbiyo_togocom_tg",
            customer_phone="90123456",
            reference="ORDER-1",
        ),
        request(headers={"Idempotency-Key": "mobile-test-key"}),
    )

    assert result == {"id": "momo-1", "status": "pending"}
    assert captured["product"] == "bizpay_checkout"
    assert captured["idem_path"] == "/api/v1/payments"
    assert captured["payload"].currency == "XOF"
    assert captured["payload"].customer_phone == "90123456"


def test_developer_payment_view_normalizes_approved_to_paid():
    view = server._developer_payment_view({
        "id": "momo-1",
        "status": "approved",
        "amount": 1000,
        "currency": "XOF",
    })
    assert view["status"] == "paid"


@run_async
async def test_expired_mbiyo_payment_fails_and_stops_retrying(monkeypatch):
    fake = FakeDB()
    fake.momo_deposits.docs.append({
        "id": "momo-expired",
        "provider": "mbiyo",
        "status": "pending",
        "pending_expires_at": "2000-01-01T00:00:00+00:00",
    })
    monkeypatch.setattr(server, "db", fake)

    expired = await server._expire_momo_deposit_if_due(
        dict(fake.momo_deposits.docs[0]))

    assert expired is True
    saved = fake.momo_deposits.docs[0]
    assert saved["status"] == "failed"
    assert saved["failed_reason"] == "expired"
    assert saved["retryable"] is False


@run_async
async def test_crypto_payout_sandbox_snapshots_fee(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_authenticate_merchant",
                        lambda req: asyncio.sleep(0, result=merchant()))
    monkeypatch.setattr(server, "get_transfer_config",
                        lambda: asyncio.sleep(0, result={
                            "crypto": {
                                "fees": {"USDT": 4},
                                "fees_gateway": {"USDT": 3},
                                "fees_platform": {"USDT": 1},
                            },
                        }))
    monkeypatch.setattr(server, "_idempotency_claim",
                        lambda *args: asyncio.sleep(0, result=None))
    monkeypatch.setattr(server, "_idempotency_store",
                        lambda *args: asyncio.sleep(0))

    result = await server.merchant_create_payout(
        server.PayoutCreate(
            amount=100, coin="USDT", network="TRC20",
            destination_address="T" + "1" * 33,
        ),
        request(headers={"Idempotency-Key": "payout-test-key"}),
    )

    assert result["amount"] == "100.00"
    assert result["amount_net"] == "100.00"
    assert result["fee"] == "4.00"
    assert result["total_debit"] == "104.00"
    assert fake.merchant_payouts.docs[0]["fee"] == 4
    assert fake.merchant_payouts.docs[0]["total_debit"] == 104


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
                            "master_key_encrypted": "configured",
                            "private_key_encrypted": "configured",
                            "token_encrypted": "configured",
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
    monkeypatch.setattr(server, "get_transfer_config",
                        lambda: asyncio.sleep(0, result={
                            "mobile_money": {
                                "enabled": True,
                                "operators": [{"country": "TG", "code": "moov_tg",
                                                "currency": "XOF", "min": 100,
                                                "max": 500000, "active": True,
                                                "fee_pct": 2}],
                            },
                        }))
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
    monkeypatch.setattr(server, "get_transfer_config",
                        lambda: asyncio.sleep(0, result={
                            "mobile_money": {
                                "enabled": True,
                                "operators": [{"country": "TG", "code": "moov_tg",
                                                "currency": "XOF", "min": 100,
                                                "max": 500000, "active": True,
                                                "fee_pct": 2}],
                            },
                        }))
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
    assert result["fee"] == 20
    assert result["total_debit"] == 1020
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
async def test_key_creation_accepts_psr_scope(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_ensure_api_keys",
                        lambda *args: asyncio.sleep(0, result={}))

    result = await server.create_merchant_key(
        server.CreateMerchantKeyReq(
            name="PSR client flow", scopes=["psr:create"]),
        uid="merchant-a", request=request(),
    )

    assert result["scopes"] == ["psr:create"]
    assert fake.merchant_keys.docs[0]["scopes"] == ["psr:create"]


@run_async
async def test_api_key_container_does_not_provision_default_test_key(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(server, "db", fake)

    doc = await server._ensure_api_keys("merchant-a")

    assert "keys" not in doc
    assert not fake.api_keys.docs[0].get("keys")


@run_async
async def test_deleting_last_merchant_key_removes_legacy_copy(monkeypatch):
    fake = FakeDB()
    fake.merchant_keys.docs.append({
        "id": "key-1",
        "user_id": "merchant-a",
        "env": "test",
        "public_key": "pk_test_1",
        "secret_hash": "hash-1",
        "secret_hint": "sk_test_1…hash",
    })
    fake.api_keys.docs.append({
        "user_id": "merchant-a",
        "keys": {"test": {"public_key": "pk_test_1", "secret_hash": "hash-1"}},
    })
    monkeypatch.setattr(server, "db", fake)

    result = await server.delete_merchant_key("key-1", uid="merchant-a")

    assert result == {"deleted": True}
    assert fake.merchant_keys.docs == []
    assert "test" not in fake.api_keys.docs[0].get("keys", {})


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