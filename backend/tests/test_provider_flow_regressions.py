"""Regression tests for ordinary provider payment and payout handling."""

import asyncio
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
import sys
from pymongo.errors import DuplicateKeyError
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def run_async(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return wrapper


async def disabled_afribapay_config(*args, **kwargs):
    return {"enabled": False, "catalog": []}


class MemoryCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    async def create_index(self, *args, **kwargs):
        return None

    @staticmethod
    def _value(doc, path):
        value = doc
        for part in path.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    @classmethod
    def _matches(cls, doc, query):
        for key, expected in query.items():
            if key == "$or":
                if not any(cls._matches(doc, part) for part in expected):
                    return False
                continue
            if key == "$and":
                if not all(cls._matches(doc, part) for part in expected):
                    return False
                continue
            actual = cls._value(doc, key)
            if not isinstance(expected, dict):
                if actual != expected:
                    return False
                continue
            if "$in" in expected and not (
                    actual in expected["$in"]
                    or (isinstance(actual, list)
                        and any(value in expected["$in"] for value in actual))):
                return False
            if "$nin" in expected and (
                    actual in expected["$nin"]
                    or (isinstance(actual, list)
                        and any(value in expected["$nin"] for value in actual))):
                return False
            if "$ne" in expected and (
                    actual == expected["$ne"]
                    or (isinstance(actual, list) and expected["$ne"] in actual)):
                return False
            if "$gte" in expected and (
                    actual is None or actual < expected["$gte"]):
                return False
            if "$lte" in expected:
                compare_actual, compare_expected = actual, expected["$lte"]
                if isinstance(compare_actual, str) and isinstance(compare_expected, datetime):
                    try:
                        compare_actual = datetime.fromisoformat(
                            compare_actual.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                if compare_actual is None or compare_actual > compare_expected:
                    return False
            if "$exists" in expected and (actual is not None) != expected["$exists"]:
                return False
        return True

    @staticmethod
    def _set_path(doc, path, value):
        target = doc
        parts = path.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return SimpleNamespace(inserted_id=doc.get("id"))

    async def find_one(self, query, projection=None, **kwargs):
        for doc in reversed(self.docs):
            if self._matches(doc, query):
                return dict(doc)
        return None

    async def update_one(self, query, update, **kwargs):
        for doc in reversed(self.docs):
            if not self._matches(doc, query):
                continue
            before = repr(doc)
            for path, value in update.get("$set", {}).items():
                self._set_path(doc, path, value)
            for path, value in update.get("$inc", {}).items():
                self._set_path(
                    doc, path, (self._value(doc, path) or 0) + value)
            for path, value in update.get("$addToSet", {}).items():
                target = doc
                parts = path.split(".")
                for part in parts[:-1]:
                    target = target.setdefault(part, {})
                values = target.setdefault(parts[-1], [])
                if value not in values:
                    values.append(value)
            for path in update.get("$unset", {}):
                target = doc
                parts = path.split(".")
                for part in parts[:-1]:
                    target = target.get(part, {})
                if isinstance(target, dict):
                    target.pop(parts[-1], None)
            return SimpleNamespace(
                matched_count=1, modified_count=int(repr(doc) != before))
        return SimpleNamespace(matched_count=0, modified_count=0)


class MemoryDB:
    def __init__(self):
        self.settings = MemoryCollection()
        self.webhook_events = MemoryCollection()
        self.crypto_deposits = MemoryCollection()
        self.link_payments = MemoryCollection()
        self.payment_links = MemoryCollection()
        self.momo_deposits = MemoryCollection()
        self.merchant_payouts = MemoryCollection()
        self.users = MemoryCollection()
        self.transactions = MemoryCollection()


@run_async
async def test_concurrent_izipay_claim_allows_only_one_active_settlement(monkeypatch):
    fake = MemoryDB()
    fake.crypto_deposits.docs.append({
        "id": "claim-deposit", "status": "pending",
        "user_id": "user-a", "izipay_intent_id": "intent-claim",
    })
    monkeypatch.setattr(server, "db", fake)

    claims = await asyncio.gather(*[
        server._claim_izipay_payment_settlement(
            fake.crypto_deposits, "claim-deposit", "intent-claim")
        for _ in range(2)
    ])

    assert sum(claim is not None for claim in claims) == 1
    assert fake.crypto_deposits.docs[0]["status"] == "settling"


@run_async
async def test_izipay_claim_rejects_mismatched_intent_and_recovers_stale_lease(
        monkeypatch):
    fake = MemoryDB()
    fake.crypto_deposits.docs.append({
        "id": "claim-deposit", "status": "pending",
        "user_id": "user-a", "izipay_intent_id": "intent-expected",
    })
    monkeypatch.setattr(server, "db", fake)

    assert await server._claim_izipay_payment_settlement(
        fake.crypto_deposits, "claim-deposit", "intent-other") is None
    assert fake.crypto_deposits.docs[0]["status"] == "pending"
    assert fake.crypto_deposits.docs[0]["izipay_intent_id"] == "intent-expected"

    fake.crypto_deposits.docs[0].update({
        "status": "settling",
        "settlement_claim_id": "stale-claim",
        "settlement_claimed_at": (
            datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat(),
    })
    reclaimed = await server._claim_izipay_payment_settlement(
        fake.crypto_deposits, "claim-deposit", "intent-expected")
    assert reclaimed and reclaimed["status"] == "settling"
    assert reclaimed["settlement_claim_id"] != "stale-claim"


@run_async
async def test_record_tx_concurrent_operation_id_creates_one_ledger_row(monkeypatch):
    class UniqueTransactions(MemoryCollection):
        def __init__(self):
            super().__init__()
            self.lock = asyncio.Lock()

        async def find_one(self, query, projection=None, **kwargs):
            await asyncio.sleep(0)
            return await super().find_one(query, projection, **kwargs)

        async def insert_one(self, doc):
            async with self.lock:
                if any(existing.get("id") == doc.get("id") for existing in self.docs):
                    raise DuplicateKeyError("duplicate transaction id")
                self.docs.append(dict(doc))
            return SimpleNamespace(inserted_id=doc.get("id"))

    database = SimpleNamespace(transactions=UniqueTransactions())
    monkeypatch.setattr(server, "db", database)

    async def no_referral(_tx):
        return None

    monkeypatch.setattr(server, "_process_referral_transaction", no_referral)
    rows = await asyncio.gather(*[
        server.record_tx(
            "user-a", "deposit", "in", 25, "XOF",
            operation_id="provider-event:stable-1",
        )
        for _ in range(2)
    ])

    assert len(database.transactions.docs) == 1
    assert rows[0].id == rows[1].id
    assert database.transactions.docs[0]["metadata"]["operation_id"] == "provider-event:stable-1"


@run_async
async def test_mobile_money_deposit_credit_is_once_per_local_and_provider_id(monkeypatch):
    fake = MemoryDB()
    fake.users.docs.append({
        "id": "user-a", "balance_xof": 100,
        "wallet_credit_operation_ids": [],
        "wallet_debit_operation_ids": [],
        "credited_deposit_ids": [],
    })
    monkeypatch.setattr(server, "db", fake)

    async def no_side_effect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "_upsert_momo_ledger", no_side_effect)
    monkeypatch.setattr(server, "_notify_integration_business_transition", no_side_effect)
    monkeypatch.setattr(server, "notify", no_side_effect)
    monkeypatch.setattr(server, "_process_referral_transaction", no_side_effect)

    first = {
        "id": "momo-deposit-1", "user_id": "user-a", "provider": "paydunya",
        "status": "pending", "amount": 50, "requested_amount": 50,
        "wallet_credit_amount": 48, "currency": "XOF", "country": "TG",
        "paydunya_token": "provider-payment-unique-1",
    }
    duplicate_local_row = {
        **first, "id": "momo-deposit-2",
    }
    fake.momo_deposits.docs.extend([
        dict(first), dict(duplicate_local_row),
    ])
    assert await server._credit_momo_deposit(first) is True
    assert await server._credit_momo_deposit(first) is True
    assert fake.users.docs[0]["balance_xof"] == 148

    assert await server._credit_momo_deposit(duplicate_local_row) is False
    assert fake.users.docs[0]["balance_xof"] == 148
    assert fake.momo_deposits.docs[-1]["status"] == "quarantined"


@run_async
async def test_stripe_webhook_repairs_ledger_for_already_paid_payment(monkeypatch):
    fake = MemoryDB()
    fake.users.docs.append({
        "id": "user-a", "balance_xof": 0,
        "wallet_credit_operation_ids": [],
        "wallet_debit_operation_ids": [],
    })
    fake.payment_transactions = MemoryCollection()
    fake.payment_transactions.docs.append({
        "id": "payment-1", "session_id": "stripe-session-1",
        "user_id": "user-a", "payment_status": "paid", "status": "completed",
        "amount": 75, "currency": "XOF",
    })
    monkeypatch.setattr(server, "db", fake)
    ledger_attempts = []
    credit_operations = set()

    class VerifiedEvent:
        payment_status = "paid"
        session_id = "stripe-session-1"

    class Checkout:
        def __init__(self, **_kwargs):
            pass

        async def handle_webhook(self, *_args):
            return VerifiedEvent()

    class Request:
        headers = {"Stripe-Signature": "verified-test-signature"}
        base_url = "https://example.test/"

        async def body(self):
            return b"verified test payload"

    async def record(*args, **kwargs):
        ledger_attempts.append(kwargs.get("operation_id"))

    async def credit(_user_id, _field, _amount, operation_id):
        credit_operations.add(operation_id)
        return True

    monkeypatch.setattr(server, "StripeCheckout", Checkout)
    monkeypatch.setattr(server, "_credit_wallet_once", credit)
    monkeypatch.setattr(server, "record_tx", record)

    await server.stripe_webhook(Request())
    await server.stripe_webhook(Request())

    assert credit_operations == {"stripe:deposit:stripe-session-1"}
    assert ledger_attempts == [
        "stripe:deposit:stripe-session-1",
        "stripe:deposit:stripe-session-1",
    ]


@run_async
async def test_merchant_api_payment_replay_uses_same_wallet_and_ledger_operation(
        monkeypatch):
    fake = MemoryDB()
    fake.merchant_payments = MemoryCollection()
    fake.merchant_payments.docs.append({
        "id": "merchant-payment-1", "merchant_id": "merchant-user",
        "status": "pending", "coin": "USDT", "usdt_rate": 1,
        "amount_gross_usdt": 10, "amount_net_usdt": 9.5,
        "fee": 0.5, "gateway_fee": 0.3, "platform_fee": 0.2,
        "fee_currency": "USDT", "izipay_intent_id": "merchant-intent-1",
        "reference": "merchant-reference-1",
    })
    monkeypatch.setattr(server, "db", fake)
    applied_operations, ledger_operations = set(), set()
    attempts = []

    async def apply(_user_id, _increments, operation_id, _direction, **kwargs):
        attempts.append((operation_id, kwargs.get("aliases")))
        if operation_id in applied_operations:
            return {"state": "already"}
        applied_operations.add(operation_id)
        return {"state": "applied"}

    async def record(*_args, **kwargs):
        operation_id = kwargs.get("operation_id")
        ledger_operations.add(operation_id)
        return SimpleNamespace(id="merchant-ledger-1")

    async def no_side_effect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "_apply_wallet_operation_once", apply)
    monkeypatch.setattr(server, "record_tx", record)
    monkeypatch.setattr(server, "notify", no_side_effect)

    assert await server._settle_izipay_payment(
        "merchant-payment-1", "merchant-intent-1", "chain-hash-1", "webhook")
    assert await server._settle_izipay_payment(
        "merchant-payment-1", "merchant-intent-1", "chain-hash-1", "reconcile")

    assert len(attempts) == 2
    assert attempts[0] == attempts[1]
    assert attempts[0][0] == "izipay:merchant-payment:merchant-payment-1"
    assert attempts[0][1] == [
        "izipay:intent:merchant-intent-1", "izipay:tx:chain-hash-1",
    ]
    assert applied_operations == {"izipay:merchant-payment:merchant-payment-1"}
    assert ledger_operations == {"izipay:merchant-payment:merchant-payment-1"}
    assert fake.merchant_payments.docs[0]["status"] == "paid"


@pytest.mark.parametrize(
    ("status", "message", "raw", "expected"),
    [
        (400, "Invalid phone number", None, True),
        (422, "Invalid payout details", None, True),
        (400, "Mbiyo request failed",
         {"message": "Order ID already exists"}, False),
        (400, "Insufficient orange network balance. Available: 0",
         None, False),
        (503, "Invalid phone number", None, False),
    ],
)
def test_mbiyo_definitive_payout_rejection_classifier(
        status, message, raw, expected):
    error = server.mbiyo.MbiyoError(status, message, raw)
    assert server._is_definitive_mbiyo_payout_rejection(error) is expected


@pytest.mark.parametrize(
    ("provider_error", "provider_id_before_error", "expected_http_status",
     "expected_outcome"),
    [
        (
            server.mbiyo.MbiyoError(
                400,
                "Invalid phone number or unsupported network for CI/mobile_money",
            ),
            False, 400, "refunded",
        ),
        (
            server.mbiyo.MbiyoError(
                400, "Insufficient orange network balance. Available: 0"),
            False, None, "provider_liquidity",
        ),
        (
            server.mbiyo.MbiyoError(
                400, "Order ID already exists; possible duplicate payout"),
            False, 502, "manual_review",
        ),
        (
            server.mbiyo.MbiyoError(503, "Invalid phone number"),
            False, 502, "manual_review",
        ),
        (
            server.mbiyo.MbiyoError(
                400, "Invalid phone number or unsupported network"),
            True, 502, "provider_id",
        ),
    ],
)
@run_async
async def test_mbiyo_ci_payout_normalizes_phone_and_preserves_settlement_safety(
        monkeypatch, provider_error, provider_id_before_error,
        expected_http_status, expected_outcome):
    db = MemoryDB()
    user = {
        "id": "biz", "balance_xof": 5000, "kyc_status": "approved",
        "full_name": "Test Merchant",
    }
    db.users.docs.append(user)
    monkeypatch.setattr(server, "db", db)

    async def get_user(_uid):
        return user

    async def get_transfer_config():
        return {"mobile_money": {"enabled": True, "operators": []}}

    async def get_mbiyo_config(decrypt=False):
        return {
            "enabled": True, "_api_key": "test-key",
            "base_url": "https://mbiyo.test",
        }

    async def get_platform_config():
        return {"auto_withdrawals_disabled": False}

    async def no_notify(*_args, **_kwargs):
        return None

    route = {
        "provider": "mbiyo", "country": "CI", "code": "mtn_ci",
        "network": "mtn", "currency": "XOF", "name": "MTN Mobile Money",
        "active": True, "min": 100, "max": 500000,
    }

    def active_route(_catalog, provider, country, code, currency):
        if (provider == "mbiyo" and country == "CI"
                and code == "mtn_ci" and currency == "XOF"):
            return route
        return None

    payout_calls = []

    class RejectingMbiyoClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def payout(self, **kwargs):
            payout_calls.append(kwargs)
            if provider_id_before_error:
                await db.transactions.update_one(
                    {"id": kwargs["order_id"]},
                    {"$set": {
                        "metadata.mbiyo_transaction_id": "mbiyo-accepted",
                        "metadata.next_reconcile_at": server.now_iso(),
                    }},
                )
            raise provider_error

    monkeypatch.setattr(server, "get_user", get_user)
    monkeypatch.setattr(
        server, "_require_kyc_verified", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "get_transfer_config", get_transfer_config)
    monkeypatch.setattr(server, "get_mbiyo_config", get_mbiyo_config)
    monkeypatch.setattr(server, "get_afribapay_config", disabled_afribapay_config)
    monkeypatch.setattr(server, "_afribapay_ready", lambda *_a, **_k: False)
    monkeypatch.setattr(server, "_active_withdrawal_operator", active_route)
    monkeypatch.setattr(server, "get_platform_config", get_platform_config)
    monkeypatch.setattr(server.paydunya, "calculate_fees", lambda amount, *_a: {
        "wallet_credit_amount": amount, "charged_amount": amount,
        "total_fee": 0.0, "gateway_fee": 0.0, "platform_fee": 0.0,
        "fee_bearer": "sender",
    })
    monkeypatch.setattr(server.mbiyo, "MbiyoClient", RejectingMbiyoClient)
    monkeypatch.setattr(server, "notify", no_notify)
    monkeypatch.setattr(
        server, "_notify_integration_business_transition", no_notify)
    monkeypatch.setenv("OFFICIAL_DOMAIN", "https://payments.example.test")

    request = Request({
        "type": "http", "method": "POST", "path": "/api/transfers",
        "scheme": "https", "headers": [(b"host", b"payments.example.test")],
        "query_string": b"", "server": ("payments.example.test", 443),
    })
    request.state.merchant_api = True
    payload = server.TransferRequest(
        transfer_type="biz_to_mobile", recipient="0712345678",
        country="CI", operator="mtn_ci", amount=500, currency="XOF",
        idempotency_key="test-mbiyo-ci-payout",
    )

    if expected_http_status is None:
        result = await server.transfer(payload, request, "biz")
        assert result["pending_manual"] is True
    else:
        with pytest.raises(HTTPException) as exc:
            await server.transfer(payload, request, "biz")
        assert exc.value.status_code == expected_http_status

    assert len(payout_calls) == 1
    assert payout_calls[0]["metadata"]["phone_number"] == "+2250712345678"
    tx = db.transactions.docs[0]
    assert user["withdrawal_debit_ids"] == [tx["id"]]

    if expected_outcome == "refunded":
        assert tx["status"] == "failed"
        assert tx["metadata"]["refunded"] is True
        assert tx["metadata"]["mbiyo_submission_phase"] == "provider_rejected"
        assert tx["metadata"]["provider_status"] == 400
        assert tx["metadata"]["submission_unknown"] is False
        assert user["balance_xof"] == 5000
        assert user["withdrawal_refund_ids"] == [tx["id"]]
    else:
        assert tx["status"] == "pending"
        assert user["balance_xof"] == 4500
        assert "withdrawal_refund_ids" not in user
        if expected_outcome == "provider_liquidity":
            assert tx["metadata"]["provider_balance_insufficient"] is True
            assert tx["metadata"]["manual_review_required"] is True
            assert tx["metadata"]["mbiyo_submission_review_required"] is True
        elif expected_outcome == "manual_review":
            assert tx["metadata"]["manual_review_required"] is True
            assert tx["metadata"]["submission_unknown"] is True
        else:
            assert tx["metadata"]["mbiyo_transaction_id"] == "mbiyo-accepted"


@pytest.mark.parametrize(
    ("configured_code", "requested_code"),
    [("togocel_tg", "tmoney_tg"),
     ("togocel_tg", "t-money-togo"),
     ("togocel_tg", "togocel_tg"),
     ("moov_tg", "moov_tg")],
)
@run_async
async def test_public_link_payment_accepts_active_configured_operator(
        monkeypatch, configured_code, requested_code):
    db = MemoryDB()
    db.payment_links.docs.append({
        "id": "link-1", "slug": "test-link", "active": True,
        "amount": 1000, "amount_type": "fixed",
        "currency": "XOF", "user_id": "merchant-1",
        "title": "Test", "fee_bearer": "customer",
    })
    monkeypatch.setattr(server, "db", db)
    operator = {
        "country": "TG", "code": configured_code, "currency": "XOF",
        "name": "Opérateur", "active": True, "min": 100, "max": 500000,
        "endpoint_slug": "t-money-togo" if configured_code == "togocel_tg" else "moov-togo",
    }
    cfg = {
        "enabled": True, "mode": "live",
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [operator],
    }
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)
    async def no_turnstile(*args):
        return None
    async def no_notify(*args):
        return None
    submitted = []
    async def create_invoice(*args, **kwargs):
        return {"token": "invoice-1"}
    async def softpay(*args, **kwargs):
        submitted.append(kwargs["operator"]["code"])
        return {"response_code": "00", "reference": "provider-1"}
    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda decrypt=False: value(cfg))
    monkeypatch.setattr(server, "get_mbiyo_config",
                        lambda decrypt=False: value({"enabled": False, "catalog": []}))
    monkeypatch.setattr(server.paydunya, "create_invoice", create_invoice)
    monkeypatch.setattr(server.paydunya, "softpay_payment", softpay)
    monkeypatch.setattr(server, "_notify_integration_link_payment", no_notify)
    request = Request({
        "type": "http", "method": "POST", "path": "/api/links/pay/mobile-money",
        "scheme": "https", "headers": [(b"host", b"example.test")],
        "query_string": b"", "server": ("example.test", 443),
    })
    payload = server.LinkPayMoMoRequest(
        slug="test-link", full_name="Test Buyer", email="buyer@example.test",
        country="TG", operator=requested_code, phone_number="90112233")

    result = await server.start_link_payment_momo(payload, request)

    assert result["method"] == "mobile_money"
    assert result["status"] == "pending"
    assert submitted == [configured_code]
    assert db.momo_deposits.docs[0]["operator_snapshot"]["code"] == configured_code
    assert len(db.link_payments.docs) == 1


@pytest.mark.parametrize("phone_number", [
    "+226 51 76 56 64", "00226 51 76 56 64",
])
@run_async
async def test_public_link_moov_burkina_sends_local_paydunya_phone(
        monkeypatch, phone_number):
    db = MemoryDB()
    db.payment_links.docs.append({
        "id": "link-bf", "slug": "bf-link", "active": True,
        "amount": 1000, "amount_type": "fixed", "currency": "XOF",
        "user_id": "merchant-1", "title": "Test", "fee_bearer": "customer",
    })
    monkeypatch.setattr(server, "db", db)
    operator = {
        "country": "BF", "code": "moov_bf", "currency": "XOF",
        "name": "Moov Money Burkina Faso", "active": True,
        "min": 100, "max": 500000, "endpoint_slug": "moov-burkina",
    }
    cfg = {
        "enabled": True, "mode": "live",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [operator],
    }

    async def value(payload):
        return payload

    async def no_turnstile(*args):
        return None

    async def resolve_paydunya(*args, **kwargs):
        return "paydunya"

    async def no_notify(*args):
        return None

    async def create_invoice(*args, **kwargs):
        return {"token": "invoice-bf"}

    submitted_phones = []

    async def softpay(*args, **kwargs):
        submitted_phones.append(kwargs["phone"])
        return {"response_code": "00", "reference": "provider-bf"}

    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(server, "_resolve_deposit_provider", resolve_paydunya)
    monkeypatch.setattr(server, "get_paydunya_config",
                        lambda decrypt=False: value(cfg))
    monkeypatch.setattr(server, "get_mbiyo_config",
                        lambda decrypt=False: value({"enabled": False, "catalog": []}))
    monkeypatch.setattr(server, "get_afribapay_config", disabled_afribapay_config)
    monkeypatch.setattr(server.paydunya, "create_invoice", create_invoice)
    monkeypatch.setattr(server.paydunya, "softpay_payment", softpay)
    monkeypatch.setattr(server, "_notify_integration_link_payment", no_notify)

    request = Request({
        "type": "http", "method": "POST",
        "path": "/api/links/pay/mobile-money", "scheme": "https",
        "headers": [(b"host", b"example.test")], "query_string": b"",
        "server": ("example.test", 443),
    })
    payload = server.LinkPayMoMoRequest(
        slug="bf-link", full_name="Test Buyer", email="buyer@example.test",
        country="BF", operator="moov_bf", phone_number=phone_number,
    )

    result = await server.start_link_payment_momo(payload, request)

    assert result["status"] == "pending"
    assert submitted_phones == ["51765664"]
    assert db.momo_deposits.docs[0]["phone_number"] == "51765664"


@pytest.mark.parametrize("restriction", ["active", "archived", "hidden"])
@run_async
async def test_public_link_payment_keeps_tmoney_restrictions(monkeypatch, restriction):
    db = MemoryDB()
    db.payment_links.docs.append({
        "id": "link-1", "slug": "test-link", "active": True,
        "amount": 1000, "amount_type": "fixed",
        "currency": "XOF", "user_id": "merchant-1",
    })
    monkeypatch.setattr(server, "db", db)
    operator = {"country": "TG", "code": "togocel_tg",
                "currency": "XOF", "active": True}
    operator[restriction] = False if restriction == "active" else True
    cfg = {
        "enabled": True, "master_key_encrypted": "configured",
        "private_key_encrypted": "configured", "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [operator],
    }
    async def value(payload):
        return payload
    async def no_turnstile(*args):
        return None
    monkeypatch.setattr(server, "_require_turnstile", no_turnstile)
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda decrypt=False: value(cfg))
    monkeypatch.setattr(server, "get_mbiyo_config",
                        lambda decrypt=False: value({"enabled": False, "catalog": []}))
    request = Request({
        "type": "http", "method": "POST", "path": "/api/links/pay/mobile-money",
        "headers": [(b"host", b"example.test")], "query_string": b"",
    })
    payload = server.LinkPayMoMoRequest(
        slug="test-link", full_name="Test Buyer", email="buyer@example.test",
        country="TG", operator="tmoney_tg", phone_number="90112233")

    with pytest.raises(HTTPException) as exc:
        await server.start_link_payment_momo(payload, request)
    assert exc.value.status_code == 400
    assert not db.momo_deposits.docs
    assert not db.link_payments.docs


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
async def test_deposit_provider_falls_back_when_paydunya_has_no_enabled_mode(
        monkeypatch):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

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
        "TG", "tmoney_tg", "XOF") == "mbiyo"


@pytest.mark.parametrize("configured_code", ["tmoney_tg", "togocel_tg"])
@run_async
async def test_deposit_provider_uses_ready_paydunya_route(monkeypatch, configured_code):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

    shared_route = {
        "country": "TG", "code": configured_code, "currency": "XOF",
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
        "TG", "tmoney_tg", "XOF") == "paydunya"


@run_async
async def test_direct_deposit_avoids_redirect_only_paydunya(monkeypatch):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

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
        "TG", "tmoney_tg", "XOF", required_mode="softpay_direct") == "mbiyo"


@run_async
async def test_unavailable_deposit_error_does_not_disclose_provider(monkeypatch):
    async def value(payload):
        return payload
    monkeypatch.setattr(
        server, "get_afribapay_config", disabled_afribapay_config)

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
        await server._resolve_deposit_provider("TG", "tmoney_tg", "XOF")
    assert exc.value.status_code == 503
    assert "paydunya" not in str(exc.value.detail).lower()
    assert "mbiyo" not in str(exc.value.detail).lower()


def test_public_withdrawal_catalog_keeps_active_provider_routes_distinct():
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


def test_public_withdrawal_catalog_hides_routes_owned_by_another_provider():
    config = server._public_transfer_config({
        "mobile_money": {
            "enabled": True,
            "operators": [
                {
                    "provider": "paydunya", "country": "TG",
                    "code": "t-money-togo", "withdraw_mode": "t-money-togo",
                    "name": "TMoney", "currency": "XOF", "active": True,
                },
                {
                    "provider": "mbiyo", "country": "TG",
                    "code": "mbiyo_tmoney_tg", "network": "togocom",
                    "name": "TMoney", "currency": "XOF", "active": True,
                },
                {
                    "provider": "afribapay", "country": "TG",
                    "code": "afribapay_tmoney_tg", "public_code": "tmoney_tg",
                    "operator": "tmoney", "name": "TMoney",
                    "currency": "XOF", "active": True,
                },
            ],
        },
        "paydunya": {"enabled": True},
        "mbiyo": {"enabled": True},
        "afribapay": {"enabled": True},
    })

    operators = config["mobile_money"]["operators"]
    assert [operator["code"] for operator in operators] == ["t-money-togo"]
    assert all("provider" not in operator for operator in operators)


def test_withdrawal_route_resolver_is_scoped_to_selected_provider():
    paydunya_route = next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    )
    mbiyo_route = next(
        op for op in server.mbiyo.default_catalog()
        if op["country"] == "TG" and op["network"] == "moov"
    )
    afribapay_route = next(
        op for op in server.afribapay.default_payout_catalog()
        if op["country"] == "TG" and op["operator"] == "moov"
    )
    catalogue = [paydunya_route, mbiyo_route, afribapay_route]

    assert server._active_withdrawal_operator(
        catalogue, "paydunya", "TG", "moov-togo", "XOF"
    )["withdraw_mode"] == "moov-togo"
    assert server._active_withdrawal_operator(
        catalogue, "mbiyo", "TG", "moov_tg", "XOF"
    )["network"] == "moov"
    assert server._active_withdrawal_operator(
        catalogue, "afribapay", "TG", "moov_tg", "XOF"
    )["operator"] == "moov"


def test_withdrawal_route_identity_and_defaults_keep_one_provider_active():
    paydunya_route = next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    )
    mbiyo_route = next(
        op for op in server.mbiyo.default_catalog()
        if op["country"] == "TG" and op["network"] == "moov"
    )
    afribapay_route = next(
        op for op in server.afribapay.default_payout_catalog()
        if op["country"] == "TG" and op["operator"] == "moov"
    )
    routes = [afribapay_route, mbiyo_route, paydunya_route]

    assert {
        server._withdrawal_route_identity(route) for route in routes
    } == {("TG", "moov")}
    server._deactivate_duplicate_withdrawal_routes(routes)
    assert paydunya_route["active"] is True
    assert mbiyo_route["active"] is False
    assert afribapay_route["active"] is False


def test_legacy_provider_codes_keep_their_provider_when_catalogue_is_merged():
    catalogue = server._merged_mobile_money(
        server.DEFAULT_TRANSFER_CONFIG,
        {"operators": [{
            "country": "TG",
            "code": "afribapay_moov_tg",
            "currency": "XOF",
            "active": True,
        }]},
    )
    route = next(
        op for op in catalogue["operators"]
        if op["code"] == "afribapay_moov_tg"
    )

    assert route["provider"] == "afribapay"
    assert route["active"] is True
    assert route.get("archived") is False


def test_withdrawal_catalog_rejects_same_active_route_on_multiple_providers():
    paydunya_route = next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    )
    mbiyo_route = next(
        op for op in server.mbiyo.default_catalog()
        if op["country"] == "TG" and op["network"] == "moov"
    )

    with pytest.raises(HTTPException, match="un seul prestataire"):
        server._validate_withdrawal_catalog({
            "operators": [paydunya_route, mbiyo_route],
        })

    mbiyo_route["active"] = False
    server._validate_withdrawal_catalog({
        "operators": [paydunya_route, mbiyo_route],
    })


def test_withdrawal_catalog_can_disable_all_routes_with_inconsistent_legacy_limits():
    routes = [
        dict(next(
            op for op in server.paydunya.default_withdrawal_catalog()
            if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
        )),
        dict(next(
            op for op in server.mbiyo.default_catalog()
            if op["country"] == "TG" and op["network"] == "moov"
        )),
        dict(next(
            op for op in server.afribapay.default_payout_catalog()
            if op["country"] == "TG" and op["operator"] == "moov"
        )),
    ]
    for route in routes:
        route["active"] = False
    routes[0]["min"] = 500
    routes[0]["max"] = 100

    # Saving an all-disabled catalogue must not require editing limits.
    server._validate_withdrawal_catalog({"operators": routes})


def test_active_withdrawal_routes_validate_finite_limits_but_allow_no_maximum():
    route = dict(next(
        op for op in server.paydunya.default_withdrawal_catalog()
        if op["country"] == "TG" and op["withdraw_mode"] == "moov-togo"
    ))
    route.update({"min": 500, "max": 100})
    with pytest.raises(HTTPException, match="limite maximale"):
        server._validate_withdrawal_catalog({"operators": [route]})

    route["max"] = 0
    server._validate_withdrawal_catalog({"operators": [route]})


@run_async
async def test_transfer_config_migrates_mbiyo_payout_catalog_only_once(monkeypatch):
    db = MemoryDB()
    db.settings.docs.append({
        "id": "transfer_config",
        "mobile_money": {"enabled": True, "operators": []},
    })
    monkeypatch.setattr(server, "db", db)
    legacy_catalog = [{
        "country": "ZZ",
        "country_label": "Test Country",
        "code": "mbiyo_test_route",
        "network": "test-route",
        "currency": "XOF",
        "name": "Test Network",
        "active": True,
    }]

    async def paydunya_config():
        return {"enabled": False}

    async def mbiyo_config():
        return {"enabled": False, "catalog": legacy_catalog}

    async def afribapay_config():
        return {"enabled": False}

    monkeypatch.setattr(server, "get_paydunya_config", paydunya_config)
    monkeypatch.setattr(server, "_paydunya_credentials_configured", lambda _: False)
    monkeypatch.setattr(server, "get_mbiyo_config", mbiyo_config)
    monkeypatch.setattr(server, "get_afribapay_config", afribapay_config)
    monkeypatch.setattr(server, "_afribapay_ready", lambda *args, **kwargs: False)

    first = await server.get_transfer_config()
    assert any(
        op.get("provider") == "mbiyo" and op["code"] == "mbiyo_test_route"
        for op in first["mobile_money"]["operators"]
    )
    assert db.settings.docs[0]["withdrawal_catalog_migration_version"] == 1

    legacy_catalog.append({
        **legacy_catalog[0],
        "code": "mbiyo_later_deposit_route",
        "network": "later-deposit-route",
    })
    second = await server.get_transfer_config()
    assert not any(
        op.get("provider") == "mbiyo"
        and op["code"] == "mbiyo_later_deposit_route"
        for op in second["mobile_money"]["operators"]
    )


def test_public_withdrawal_config_exposes_provider_fees_without_identity():
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


@run_async
async def test_customer_withdrawal_fee_grid_uses_effective_provider_catalog(
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
    monkeypatch.setattr(server, "get_transfer_config", lambda: value(withdrawal))
    monkeypatch.setattr(
        server, "get_paydunya_config", lambda: value({"enabled": False}))
    monkeypatch.setattr(
        server, "get_mbiyo_config", lambda: value({"enabled": False}))
    monkeypatch.setattr(server, "get_platform_config", lambda: value({}))

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


def test_mobile_number_match_accepts_country_prefix_only_for_same_number():
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


def _izipay_webhook_request(event, monkeypatch):
    raw = b'{"signed":"event"}'
    monkeypatch.setattr(
        server.izipay, "verify_webhook", lambda payload, signature: event)
    monkeypatch.setattr(server.izipay, "event_id", lambda payload: payload["id"])
    request = Request({
        "type": "http", "method": "POST", "path": "/api/webhooks/izipay",
        "headers": [(b"x-izipay-signature", b"test-signature")],
        "query_string": b"",
    })
    request._body = raw
    return request


@run_async
async def test_ordinary_provider_payout_callback_completes_transaction(
        monkeypatch):
    fake = MemoryDB()
    fake.transactions.docs.append({
        "id": "crypto-withdrawal-1", "user_id": "user-a",
        "status": "pending", "amount": 105, "currency": "USDT",
        "reference": "withdrawal-1",
        "metadata": {
            "transfer_type": "biz_to_crypto", "crypto": "USDT",
            "network": "TRC20", "recipient_gets": 100,
            "total_debit": 105, "operation_id": "withdrawal-operation",
        },
    })
    monkeypatch.setattr(server, "db", fake)
    notifications = []

    async def notify(*args, **kwargs):
        notifications.append((args, kwargs))

    monkeypatch.setattr(server, "notify", notify)
    request = _izipay_webhook_request({
        "id": "event-complete-1", "event": "payout.completed",
        "data": {
            "merchantReference": "crypto-withdrawal-1",
            "payoutId": "provider-payout-1",
            "status": "completed", "txHash": "chain-tx-1",
        },
    }, monkeypatch)

    result = await server.izipay_webhook(request)

    saved = fake.transactions.docs[0]
    assert result == {"received": True}
    assert saved["status"] == "completed"
    assert saved["metadata"]["tx_hash"] == "chain-tx-1"
    assert saved["metadata"]["izipay_payout_id"] == "provider-payout-1"
    assert fake.webhook_events.docs[0]["processed"] is True
    assert notifications
    assert notifications[0][0][1] == "withdrawal_success"


@run_async
async def test_ordinary_provider_payout_failure_refunds_once(monkeypatch):
    fake = MemoryDB()
    fake.transactions.docs.append({
        "id": "crypto-withdrawal-failed", "user_id": "user-a",
        "status": "pending", "amount": 105, "currency": "USDT",
        "metadata": {
            "transfer_type": "biz_to_crypto", "crypto": "USDT",
            "recipient_gets": 100, "total_debit": 105,
            "operation_id": "failed-withdrawal-operation",
        },
    })
    monkeypatch.setattr(server, "db", fake)
    refunds, notifications = [], []

    async def refund(user_id, field, amount, operation_id):
        refunds.append((user_id, field, amount, operation_id))

    async def notify(*args, **kwargs):
        notifications.append((args, kwargs))

    monkeypatch.setattr(server, "_refund_wallet_once", refund)
    monkeypatch.setattr(server, "notify", notify)
    request = _izipay_webhook_request({
        "id": "event-failed-1", "event": "payout.failed",
        "data": {
            "merchantReference": "crypto-withdrawal-failed",
            "payoutId": "provider-payout-failed",
            "status": "failed", "reason": "provider rejected",
        },
    }, monkeypatch)

    await server.izipay_webhook(request)

    saved = fake.transactions.docs[0]
    assert saved["status"] == "failed"
    assert saved["metadata"]["refunded_at"]
    assert refunds == [(
        "user-a", "balance_usdt", 105,
        "crypto-transfer:failed-withdrawal-operation",
    )]
    assert notifications
    assert notifications[0][0][1] == "withdrawal_failed"


@run_async
async def test_non_usdt_provider_deposit_settlement_credits_once(monkeypatch):
    fake = MemoryDB()
    fake.crypto_deposits.docs.append({
        "id": "btc-deposit", "user_id": "user-a", "status": "pending",
        "amount": 0.01, "coin": "BTC", "network": "BTC",
        "usdt_rate": 50000, "fee_pct": 1.5,
        "gateway_fee_pct": 1, "platform_fee_pct": 0.5,
        "gateway_fee_fixed": 0, "platform_fee_fixed": 0,
    })
    monkeypatch.setattr(server, "db", fake)
    credits, transactions = [], []

    async def credit(user_id, field, amount, operation_id):
        key = (user_id, operation_id)
        if key in applied:
            return {"state": "already"}
        applied.add(key)
        credits.append((user_id, field, amount, operation_id))
        return {"state": "applied"}

    async def apply(user_id, increments, operation_id, direction, **kwargs):
        field, amount = next(iter(increments.items()))
        return await credit(user_id, field, abs(amount), operation_id)

    async def record(*args, **kwargs):
        operation_id = kwargs.get("operation_id")
        if operation_id not in recorded:
            recorded.add(operation_id)
            transactions.append((args, kwargs))

    applied, recorded = set(), set()
    monkeypatch.setattr(server, "_apply_wallet_operation_once", apply)
    monkeypatch.setattr(server, "record_tx", record)

    assert await server._settle_izipay_payment(
        "btc-deposit", "intent-btc", "tx-btc", "webhook")
    assert await server._settle_izipay_payment(
        "btc-deposit", "intent-btc", "tx-btc", "reconcile")

    saved = fake.crypto_deposits.docs[0]
    assert len(credits) == 1
    btc_wallet_field = server._crypto_wallet_field("BTC.BTC")
    assert credits[0][1:3] == (btc_wallet_field, 0.00985)
    assert saved["amount_gross_usdt"] == 500
    assert saved["amount_crypto"] == 0.01
    assert saved["fee"] == 0.00015
    assert saved["amount_net"] == 0.00985
    assert saved["amount_net_usdt"] == 492.5
    assert saved["amount_net_currency"] == "BTC.BTC"
    assert saved["status"] == "confirmed"
    assert len(transactions) == 1
    assert transactions[0][0][3:5] == (0.00985, "BTC.BTC")


@run_async
async def test_link_payment_provider_settlement_credits_and_consumes_once(
        monkeypatch):
    fake = MemoryDB()
    fake.link_payments.docs.append({
        "id": "link-payment-1", "link_id": "link-1", "status": "pending",
        "coin": "BTC", "network": "BTC", "usdt_rate": 50000,
        "charged_amount": 0.01, "charged_amount_usdt": 500,
        "fee": 5, "fee_currency": "USDT", "gateway_fee": 3,
        "platform_fee": 2, "wallet_credit_amount": 495,
        "single_use_claim_id": "claim-1", "customer_email": "buyer@example.com",
    })
    fake.payment_links.docs.append({
        "id": "link-1", "user_id": "merchant-owner",
        "active": True, "payments_received": 0, "total_received": 0,
        "link_payment_operation_ids": [], "single_use_claim_id": "claim-1",
    })
    monkeypatch.setattr(server, "db", fake)
    credits, transactions = [], []

    async def credit(user_id, field, amount, operation_id):
        key = (user_id, operation_id)
        if key in applied:
            return {"state": "already"}
        applied.add(key)
        credits.append((user_id, field, amount, operation_id))
        return {"state": "applied"}

    async def apply(user_id, increments, operation_id, direction, **kwargs):
        field, amount = next(iter(increments.items()))
        return await credit(user_id, field, abs(amount), operation_id)

    async def record(*args, **kwargs):
        operation_id = kwargs.get("operation_id")
        if operation_id not in recorded:
            recorded.add(operation_id)
            transactions.append((args, kwargs))

    applied, recorded = set(), set()
    monkeypatch.setattr(server, "_apply_wallet_operation_once", apply)
    monkeypatch.setattr(server, "record_tx", record)

    await server._settle_izipay_payment(
        "link-payment-1", "intent-link", "tx-link", "webhook")
    await server._settle_izipay_payment(
        "link-payment-1", "intent-link", "tx-link", "reconcile")

    payment = fake.link_payments.docs[0]
    link = fake.payment_links.docs[0]
    assert payment["status"] == "paid"
    assert payment["amount_net"] == 495
    assert len(credits) == 1
    assert credits[0][:3] == ("merchant-owner", "balance_usdt", 495)
    assert link["payments_received"] == 1
    assert link["total_received"] == 495
    assert link["active"] is False
    assert link["link_payment_operation_ids"] == ["link-payment-1"]
    assert len(transactions) == 1


@run_async
async def test_provider_failure_does_not_override_settlement_or_claim(
        monkeypatch):
    fake = MemoryDB()
    fake.link_payments.docs.extend([
        {"id": "link-settling", "link_id": "link-a",
         "single_use_claim_id": "claim-settling", "status": "settling"},
        {"id": "link-pending", "link_id": "link-b",
         "single_use_claim_id": "claim-pending", "status": "pending"},
    ])
    monkeypatch.setattr(server, "db", fake)
    released = []

    async def release(link_id, claim_id):
        released.append((link_id, claim_id))

    monkeypatch.setattr(server, "_release_single_use_link", release)
    await server._fail_izipay_payment("link-settling", "expired")
    await server._fail_izipay_payment("link-pending", "expired")

    assert fake.link_payments.docs[0]["status"] == "settling"
    assert fake.link_payments.docs[1]["status"] == "expired"
    assert released == [("link-b", "claim-pending")]


@run_async
async def test_provider_payout_failure_refunds_once_and_ignores_late_success(
        monkeypatch):
    fake = MemoryDB()
    payout = {
        "id": "payout-1", "merchant_id": "merchant-a",
        "status": "pending", "total_debit": 105,
        "amount": 0.01, "coin": "BTC",
    }
    fake.merchant_payouts.docs.append(dict(payout))
    fake.transactions.docs.append({
        "id": "tx-payout-1", "status": "pending",
        "metadata": {"merchant_payout_id": "payout-1"},
    })
    monkeypatch.setattr(server, "db", fake)
    refunds = []

    async def refund(user_id, field, amount, operation_id):
        refunds.append((user_id, field, amount, operation_id))

    monkeypatch.setattr(server, "_refund_wallet_once", refund)
    await server._apply_merchant_payout_status(
        dict(payout), "failed", {"reason": "provider rejected"})
    await server._apply_merchant_payout_status(
        dict(fake.merchant_payouts.docs[0]), "completed", {})

    saved = fake.merchant_payouts.docs[0]
    assert saved["status"] == "failed"
    assert saved["refunded_at"]
    assert fake.transactions.docs[0]["status"] == "failed"
    assert len(refunds) == 1
    assert refunds[0][2:] == (105, "merchant-payout:payout-1")


@run_async
async def test_provider_reconciliation_routes_success_through_settlement(
        monkeypatch):
    async def configured_credentials():
        return {"enabled": True}

    async def get_payment_intent(intent_id):
        assert intent_id == "intent-1"
        return {
            "status": "completed", "merchantReference": "deposit-1",
            "txHash": "tx-1",
        }

    monkeypatch.setattr(server, "izipay", SimpleNamespace(
        is_configured=lambda: True,
        get_payment_intent=get_payment_intent,
    ))
    monkeypatch.setattr(
        server, "_load_izipay_credentials", configured_credentials)
    settled = []

    async def settle(*args, **kwargs):
        settled.append((args, kwargs))

    monkeypatch.setattr(server, "_settle_izipay_payment", settle)
    await server._reconcile_intent("intent-1")

    assert settled == [(("deposit-1", "intent-1", "tx-1"),
                        {"source": "reconcile"})]


@run_async
async def test_expired_mbiyo_deposit_fails_without_retry(monkeypatch):
    fake = MemoryDB()
    fake.momo_deposits.docs.append({
        "id": "momo-expired", "provider": "mbiyo", "status": "pending",
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


@pytest.mark.parametrize(
    ("provider_response", "expected_status"),
    [
        (
            {
                "status": "success",
                "data": {"transaction_id": "MBIYO-PENDING", "status": "pending"},
            },
            "pending",
        ),
        (
            {
                "status": "error",
                "message": "Transaction initiation failed",
                "data": {"transaction_id": "MBIYO-FAILED", "status": "failed"},
            },
            "failed",
        ),
    ],
)
@run_async
async def test_mbiyo_ci_local_phone_is_normalized_and_provider_status_kept(
        monkeypatch, provider_response, expected_status):
    fake = MemoryDB()
    monkeypatch.setattr(server, "db", fake)
    captured = {}

    async def config(*args, **kwargs):
        return {
            "enabled": True,
            "_api_key": "test-key",
            "catalog": [{
                "country": "CI", "code": "mbiyo_mtn_ci",
                "network": "mtn", "currency": "XOF",
                "name": "MTN Mobile Money", "active": True,
                "min": 500, "max": 1500000,
            }],
        }

    class FakeMbiyoClient:
        def __init__(self, *args, **kwargs):
            pass

        async def payin(self, **kwargs):
            captured.update(kwargs)
            return provider_response

    monkeypatch.setattr(server, "get_mbiyo_config", config)
    monkeypatch.setattr(server.mbiyo, "MbiyoClient", FakeMbiyoClient)
    request = Request({
        "type": "http", "method": "POST",
        "scheme": "https", "path": "/api/deposits/mobile-money/start",
        "headers": [(b"host", b"example.test")],
        "query_string": b"", "server": ("example.test", 443),
    })
    req = server.MobileMoneyDepositRequest(
        amount=1000, currency="XOF", email="buyer@example.test",
        full_name="Test Buyer", country="CI", operator="mtn_ci",
        phone_number="0700000000",
    )

    result = await server._create_mbiyo_deposit(req, request, "user-1")

    assert result["status"] == expected_status
    assert captured["metadata"]["phone_number"] == "+2250700000000"
    assert captured["metadata"]["country_code"] == "CI"
    assert captured["metadata"]["network"] == "mtn"
    if expected_status == "failed":
        assert "refusé" in result["message"]
    else:
        assert "Si une notification" in result["instructions"]
        assert "Si une notification" in result["message"]
    saved = fake.momo_deposits.docs[0]
    assert saved["status"] == expected_status
    assert saved["phone_number"] == "0700000000"
    assert saved["instructions"] == result["instructions"]


@pytest.mark.parametrize(
    ("network", "local_phone_number", "expected_instruction"),
    [
        ("orange", "70123456", "menu USSD"),
        ("moov", "68123456", "application Moov Money"),
    ],
)
@run_async
async def test_mbiyo_mali_deposit_sends_international_phone_and_network(
        monkeypatch, network, local_phone_number, expected_instruction):
    fake = MemoryDB()
    monkeypatch.setattr(server, "db", fake)
    captured = {}

    async def config(*args, **kwargs):
        return {
            "enabled": True,
            "_api_key": "test-key",
            "catalog": [{
                "country": "ML", "code": f"mbiyo_{network}_ml",
                "network": network, "currency": "XOF",
                "name": f"{network.title()} Money", "active": True,
                "min": 500, "max": 1500000,
            }],
        }

    class FakeMbiyoClient:
        def __init__(self, *args, **kwargs):
            pass

        async def payin(self, **kwargs):
            captured.update(kwargs)
            return {
                "status": "success",
                "data": {
                    "transaction_id": f"MBIYO-ML-{network.upper()}",
                    "status": "pending",
                },
            }

    monkeypatch.setattr(server, "get_mbiyo_config", config)
    monkeypatch.setattr(server.mbiyo, "MbiyoClient", FakeMbiyoClient)
    request = Request({
        "type": "http", "method": "POST",
        "scheme": "https", "path": "/api/deposits/mobile-money/start",
        "headers": [(b"host", b"example.test")],
        "query_string": b"", "server": ("example.test", 443),
    })
    req = server.MobileMoneyDepositRequest(
        amount=1000, currency="XOF", email="buyer@example.test",
        full_name="Test Buyer", country="ML", operator=f"{network}_ml",
        phone_number=local_phone_number,
    )

    result = await server._create_mbiyo_deposit(req, request, "user-1")

    assert captured["metadata"]["phone_number"] == f"+223{local_phone_number}"
    assert captured["metadata"]["country_code"] == "ML"
    assert captured["metadata"]["network"] == network
    assert result["status"] == "pending"
    assert result["payment_flow"]["kind"] == (
        "ussd" if network == "orange" else "phone_confirmation"
    )
    assert expected_instruction in result["instructions"]
    assert result["message"] == result["instructions"]
    assert fake.momo_deposits.docs[0]["provider"] == "mbiyo"
    assert fake.momo_deposits.docs[0]["status"] == "pending"


@run_async
async def test_mbiyo_status_poll_keeps_operator_rejection_terminal(monkeypatch):
    fake = MemoryDB()
    fake.momo_deposits.docs.append({
        "id": "momo-ci-pending", "user_id": "user-1",
        "provider": "mbiyo", "status": "pending",
        "mbiyo_transaction_id": "MBIYO-FAILED",
        "provider_binding_verified": True,
        "country": "CI", "currency": "XOF", "amount": 1000,
        "processed_amount": 1000, "provider_submitted_amount": 1000,
        "phone_number": "0700000000",
        "operator_snapshot": {"network": "mtn"},
        "instructions": "Si une notification Mobile Money apparaît, confirmez-la.",
    })
    monkeypatch.setattr(server, "db", fake)

    async def config(*args, **kwargs):
        return {"_api_key": "test-key"}

    class FakeMbiyoClient:
        def __init__(self, *args, **kwargs):
            pass

        async def status(self, transaction_id):
            assert transaction_id == "MBIYO-FAILED"
            return {
                "status": "success",
                "data": {
                    "transaction_id": transaction_id,
                    "status": "failed",
                },
            }

    async def no_notify(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "get_mbiyo_config", config)
    monkeypatch.setattr(server.mbiyo, "MbiyoClient", FakeMbiyoClient)
    monkeypatch.setattr(
        server, "_notify_integration_business_transition", no_notify)

    settled = await server._reconcile_mbiyo_deposit("momo-ci-pending")

    saved = fake.momo_deposits.docs[0]
    assert settled is False
    assert saved["status"] == "failed"
    assert saved["provider_status"] == "failed"
    assert saved["retryable"] is False
    assert saved["instructions"].startswith("Si une notification")
    assert not fake.transactions.docs


@pytest.mark.parametrize(
    ("country", "currency"),
    [
        (country, currency)
        for country, currencies in server.afribapay.COUNTRY_CURRENCIES.items()
        for currency in currencies
    ],
)
@run_async
async def test_afribapay_gross_amount_settles_verified_deposit_once(
        monkeypatch, country, currency):
    fake = MemoryDB()
    deposit = {
        "id": f"afri-{country}", "user_id": "user-1",
        "provider": "afribapay", "status": "pending",
        "afribapay_order_id": f"order-{country}",
        "afribapay_submission_phase": "provider_id_received",
        "provider_submitted_amount": 2000, "requested_amount": 2000,
        "amount": 2000, "currency": currency, "country": country,
        "next_reconcile_at": "2000-01-01T00:00:00+00:00",
    }
    fake.momo_deposits.docs.append(deposit)
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_afribapay_confirmation_tasks", {})
    monkeypatch.setattr(
        server, "get_afribapay_config",
        lambda **kwargs: asyncio.sleep(0, result={"_api_key": "test-only"}))

    class FakeClient:
        async def status(self, *, order_id):
            assert order_id == f"order-{country}"
            return {"data": {
                "status": "SUCCESS", "order_id": order_id,
                "original_amount": "2000", "amount": "1970",
                "fees": "30", "amount_total": "2000",
                "currency": currency, "country": country,
            }}

    monkeypatch.setattr(
        server.afribapay, "client_from_config", lambda _cfg: FakeClient())
    credits = []

    async def credit_once(d):
        credits.append(d["id"])
        await fake.momo_deposits.update_one(
            {"id": d["id"], "status": d["status"]},
            {"$set": {"status": "approved"}})
        return True

    monkeypatch.setattr(server, "_credit_momo_deposit", credit_once)
    assert await server._reconcile_afribapay_deposit(deposit["id"]) is True
    assert await server._reconcile_afribapay_deposit(deposit["id"]) is True
    assert credits == [deposit["id"]]
    assert fake.momo_deposits.docs[0]["status"] == "approved"


@run_async
async def test_afribapay_repairs_amount_quarantine_only_after_provider_verification(
        monkeypatch):
    fake = MemoryDB()
    deposit = {
        "id": "afri-legacy", "user_id": "user-1", "provider": "afribapay",
        "status": "quarantined", "reconciliation_mismatch": "amount",
        "afribapay_order_id": "order-legacy",
        "afribapay_submission_phase": "provider_id_received",
        "provider_submitted_amount": 2000, "amount": 2000,
        "currency": "XOF", "country": "CM",
        "next_reconcile_at": "2000-01-01T00:00:00+00:00",
    }
    fake.momo_deposits.docs.append(deposit)
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_afribapay_confirmation_tasks", {})
    monkeypatch.setattr(
        server, "get_afribapay_config",
        lambda **kwargs: asyncio.sleep(0, result={"_api_key": "test-only"}))

    class FakeClient:
        async def status(self, *, order_id):
            return {"data": {
                "status": "SUCCESS", "order_id": order_id,
                "original_amount": "2000", "amount": "1970", "fees": "30",
                "currency": "XOF", "country": "CM",
            }}

    monkeypatch.setattr(
        server.afribapay, "client_from_config", lambda _cfg: FakeClient())
    credited = []

    async def credit_once(d):
        credited.append(d["id"])
        await fake.momo_deposits.update_one(
            {"id": d["id"], "status": d["status"]},
            {"$set": {"status": "approved"}})
        return True

    monkeypatch.setattr(server, "_credit_momo_deposit", credit_once)
    assert await server._reconcile_afribapay_deposit(deposit["id"]) is True
    assert credited == [deposit["id"]]
    assert fake.momo_deposits.docs[0]["status"] == "approved"


@run_async
async def test_afribapay_pending_is_not_expired_or_credited(monkeypatch):
    fake = MemoryDB()
    deposit = {
        "id": "afri-late", "user_id": "user-1", "provider": "afribapay",
        "status": "pending", "afribapay_order_id": "order-late",
        "afribapay_submission_phase": "provider_id_received",
        "provider_submitted_amount": 2000, "amount": 2000,
        "currency": "XOF", "country": "BF",
        "pending_expires_at": "2000-01-01T00:00:00+00:00",
        "next_reconcile_at": "2000-01-01T00:00:00+00:00",
    }
    fake.momo_deposits.docs.append(deposit)
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "_afribapay_confirmation_tasks", {})
    monkeypatch.setattr(
        server, "get_afribapay_config",
        lambda **kwargs: asyncio.sleep(0, result={"_api_key": "test-only"}))

    class FakeClient:
        async def status(self, *, order_id):
            return {"data": {"status": "PENDING", "order_id": order_id}}

    monkeypatch.setattr(
        server.afribapay, "client_from_config", lambda _cfg: FakeClient())
    credited = []

    async def never_credit(_deposit):
        credited.append(True)
        return True

    monkeypatch.setattr(server, "_credit_momo_deposit", never_credit)
    assert await server._reconcile_afribapay_deposit(deposit["id"]) is False
    assert credited == []
    assert fake.momo_deposits.docs[0]["status"] == "pending"
    assert fake.momo_deposits.docs[0]["provider_status"] == "pending"


@run_async
async def test_afribapay_deposit_returns_after_payin_without_waiting_for_status(
        monkeypatch):
    fake = MemoryDB()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "new_id", lambda: "afri-fast")
    monkeypatch.setattr(
        server, "get_afribapay_config",
        lambda **kwargs: asyncio.sleep(0, result={"_api_user": "test"}))
    operator = {
        "country": "BF", "operator": "moov", "code": "afribapay_moov_bf",
        "name": "Moov Money", "min": 100, "max": 100000, "active": True,
    }
    monkeypatch.setattr(
        server, "_afribapay_public_config",
        lambda *_args, **_kwargs: {"mobile_money_enabled": True})
    monkeypatch.setattr(server, "_afribapay_ready", lambda *_a, **_k: True)
    monkeypatch.setattr(
        server, "_active_afribapay_operator", lambda *_a, **_k: operator)
    monkeypatch.setattr(
        server, "_paydunya_callback_base", lambda _request: "https://example.test")
    monkeypatch.setattr(
        server.paydunya, "calculate_fees",
        lambda amount, *_args: {
            "charged_amount": amount, "wallet_credit_amount": amount,
            "gateway_fee": 0, "platform_fee": 0, "total_fee": 0,
            "fee_bearer": "client",
        })
    calls = []

    class FakeClient:
        async def payin(self, **_kwargs):
            calls.append("payin")
            return {"data": {"status": "PENDING", "transaction_id": "provider-1"}}

        async def status(self, **_kwargs):
            calls.append("status")
            raise AssertionError("The initial deposit must not await status polling")

    monkeypatch.setattr(
        server.afribapay, "client_from_config", lambda _cfg: FakeClient())
    request = Request({
        "type": "http", "method": "POST", "scheme": "https",
        "path": "/api/deposits/mobile-money/start",
        "headers": [(b"host", b"example.test")],
        "query_string": b"", "server": ("example.test", 443),
    })
    req = server.MobileMoneyDepositRequest(
        amount=1000, currency="XOF", email="test@example.test",
        full_name="Test User", country="BF", operator="moov_bf",
        phone_number="70000000",
    )

    result = await server._create_afribapay_deposit(req, request, "user-1")

    assert calls == ["payin"]
    assert result["status"] == "pending"
    assert fake.momo_deposits.docs[0]["afribapay_transaction_id"] == "provider-1"


@run_async
async def test_afribapay_callback_requires_signature_and_only_queues_verification(
        monkeypatch):
    import hashlib
    import hmac
    import json

    fake = MemoryDB()
    fake.momo_deposits.docs.append({
        "id": "afri-webhook", "provider": "afribapay", "status": "pending",
    })
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(
        server, "get_afribapay_config",
        lambda **kwargs: asyncio.sleep(0, result={"_api_key": "test-signing-key"}))
    queued = []
    monkeypatch.setattr(
        server, "_schedule_afribapay_deposit_reconciliation",
        lambda dep_id, *, force=False: queued.append((dep_id, force)))
    raw = json.dumps(
        {"order_id": "afri-webhook", "status": "SUCCESS"},
        separators=(",", ":")).encode()
    signature = hmac.new(
        b"test-signing-key", raw, hashlib.sha256).hexdigest()

    def make_request(method, body, sign=""):
        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}
        headers = []
        if sign:
            headers.append((b"afribapay_sign", sign.encode()))
        return Request({
            "type": "http", "method": method, "path": "/api/webhooks/afribapay",
            "query_string": b"", "headers": headers,
        }, receive)

    await server.afribapay_webhook(
        make_request("POST", raw, signature), ref="")
    assert queued == [("afri-webhook", True)]
    assert fake.momo_deposits.docs[0].get("afribapay_callback_received_at")

    queued.clear()
    with pytest.raises(HTTPException) as error:
        await server.afribapay_webhook(
            make_request("POST", raw, "0" * 64), ref="")
    assert error.value.status_code == 403
    assert queued == []

    await server.afribapay_webhook(make_request("GET", b""), ref="")
    assert queued == []


def test_afribapay_gross_amount_validation_uses_fees_when_needed():
    assert server._afribapay_amount_matches(
        {"original_amount": "2000", "amount": "1970", "fees": "30"},
        2000)
    assert server._afribapay_amount_matches(
        {"amount": "1970", "fees": "25", "taxes": "5"}, 2000)
    assert not server._afribapay_amount_matches(
        {"original_amount": "1970", "amount": "1970", "fees": "30"}, 2000)
    assert not server._afribapay_amount_matches({"amount": "1970"}, 2000)