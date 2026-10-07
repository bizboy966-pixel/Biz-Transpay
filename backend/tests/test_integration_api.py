"""Focused contract tests for the new, separate Biz-transPay integration API."""
import asyncio
import inspect
from types import SimpleNamespace
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402
import integration_api  # noqa: E402
from integration_api import create_router  # noqa: E402


class Cursor:
    def __init__(self, docs):
        self.docs = docs
        self.offset = 0
        self.limit_value = None

    def sort(self, key, direction=1):
        if isinstance(key, str):
            self.docs.sort(key=lambda item: item.get(key), reverse=direction < 0)
        else:
            for field, order in reversed(key):
                self.docs.sort(
                    key=lambda item: item.get(field), reverse=order < 0)
        return self

    def skip(self, offset):
        self.offset = offset
        return self

    def limit(self, count):
        self.limit_value = count
        return self

    async def to_list(self, limit):
        count = self.limit_value if self.limit_value is not None else limit
        count = limit if count is None else min(limit, count)
        return self.docs[self.offset:self.offset + count]


class Collection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    @staticmethod
    def _value(doc, key):
        value = doc
        for part in key.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    @classmethod
    def _matches(cls, doc, query):
        for key, expected in query.items():
            if key == "$or":
                if not any(cls._matches(doc, part) for part in expected):
                    return False
                continue
            actual = cls._value(doc, key)
            if isinstance(expected, dict):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$lte" in expected and not (
                        actual is not None and actual <= expected["$lte"]):
                    return False
                if "$gte" in expected and not (
                        actual is not None and actual >= expected["$gte"]):
                    return False
                if "$exists" in expected and bool(actual is not None) != expected["$exists"]:
                    return False
            elif isinstance(actual, list) and not isinstance(expected, list):
                if expected not in actual:
                    return False
            elif actual != expected:
                return False
        return True

    async def find_one(self, query, projection=None):
        for doc in reversed(self.docs):
            if self._matches(doc, query):
                return dict(doc)
        return None

    async def insert_one(self, doc):
        if await self.find_one({"id": doc.get("id")}):
            raise DuplicateKeyError("duplicate")
        self.docs.append(dict(doc))

    async def update_one(self, query, update, upsert=False):
        for doc in self.docs:
            if not self._matches(doc, query):
                continue
            for key, value in update.get("$set", {}).items():
                doc[key] = value
            for key, value in update.get("$inc", {}).items():
                doc[key] = doc.get(key, 0) + value
            return SimpleNamespace(matched_count=1, modified_count=1)
        if upsert:
            doc = dict(query)
            doc.update(update.get("$set", {}))
            for key, value in update.get("$inc", {}).items():
                doc[key] = doc.get(key, 0) + value
            self.docs.append(doc)
            return SimpleNamespace(matched_count=0, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def replace_one(self, query, replacement, upsert=False):
        for i, doc in enumerate(self.docs):
            if self._matches(doc, query):
                self.docs[i] = dict(replacement)
                return SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            self.docs.append(dict(replacement))
            return SimpleNamespace(matched_count=0, upserted_id=replacement.get("id"))
        return SimpleNamespace(matched_count=0, upserted_id=None)

    def find(self, query, projection=None):
        return Cursor([dict(doc) for doc in self.docs
                       if self._matches(doc, query)])

    async def delete_many(self, query):
        before = len(self.docs)
        self.docs = [doc for doc in self.docs if not self._matches(doc, query)]
        return SimpleNamespace(deleted_count=before - len(self.docs))


class DB:
    def __init__(self, **collections):
        for name in (
            "integration_credentials", "integration_idempotency",
            "integration_operations", "integration_webhooks",
            "integration_webhook_deliveries", "integration_webhook_events",
            "integration_rate_limits", "integration_exchange_intents",
            "users", "momo_deposits",
            "transactions", "payment_links", "link_payments",
        ):
            setattr(self, name, collections.get(name, Collection()))


def run(coro):
    return asyncio.run(coro)


def req(headers=None):
    return Request({
        "type": "http", "method": "POST", "path": "/api/integration/v1/deposits",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "query_string": b"",
    })


def _admin_transaction(tx_id, metadata, tx_type="withdrawal", direction="out"):
    return {
        "id": tx_id,
        "user_id": "merchant-1",
        "type": tx_type,
        "direction": direction,
        "amount": 500,
        "currency": "XOF",
        "status": "pending",
        "metadata": {"total_debit": 525, **metadata},
    }


def _stub_admin_side_effects(monkeypatch, db):
    monkeypatch.setattr(server, "db", db)
    audits = []
    refunds = []
    credits = []

    async def audit(admin_id, admin_username, action, **kwargs):
        audits.append({
            "admin_id": admin_id, "admin_username": admin_username,
            "action": action, **kwargs,
        })

    async def notify(*args, **kwargs):
        return None

    async def refund(uid, field, amount, operation_id):
        refunds.append((uid, field, amount, operation_id))
        return True

    async def credit(uid, field, amount, operation_id):
        credits.append((uid, field, amount, operation_id))
        return True

    monkeypatch.setattr(server, "audit", audit)
    monkeypatch.setattr(server, "_notify_user", notify)
    monkeypatch.setattr(server, "_refund_wallet_once", refund)
    monkeypatch.setattr(server, "_credit_wallet_once", credit)
    return audits, refunds, credits


def ctx(db, **overrides):
    base = {
        "db": db,
        "_mask": server._mask,
        "_hash_secret": server._hash_secret,
        "_encrypt": server._encrypt,
        "_decrypt": server._decrypt,
        "_is_safe_outbound_http_url": server._is_safe_outbound_http_url,
        "_resolve_safe_outbound_http_ips": server._resolve_safe_outbound_http_ips,
        "_validate_outbound_http_url": server._validate_outbound_http_url,
        "get_current_user_id": server.get_current_user_id,
        "require_recent_auth": server.require_recent_auth,
        "_require_kyc_verified": server._require_kyc_verified,
        "MobileMoneyDepositRequest": server.MobileMoneyDepositRequest,
        "TransferRequest": server.TransferRequest,
        "ExchangeRequest": server.ExchangeRequest,
        "PaymentLinkCreate": server.PaymentLinkCreate,
        "start_mobile_money_deposit": server.start_mobile_money_deposit,
        "get_momo_deposit": server.get_momo_deposit,
        "transfer": server.transfer,
        "do_exchange": server.do_exchange,
        "conversion_quote": server.conversion_quote,
        "create_link": server.create_link,
        "_create_payment_link": server._create_payment_link,
        "_public_momo_deposit": server._public_momo_deposit,
        "_recover_integration_exchange": server._recover_integration_exchange,
    }
    base.update(overrides)
    return base


def route(router, path, method):
    candidates = list(router.routes)
    while candidates:
        item = candidates.pop(0)
        if getattr(item, "path", None) == path and method in item.methods:
            return item.endpoint
        nested = getattr(item, "original_router", None)
        if nested:
            candidates.extend(nested.routes)
    raise LookupError(path)


def test_m2m_requires_matching_public_secret_and_environment(monkeypatch):
    db = DB()
    pub, secret = "pk_test_public", "sk_test_secret"
    db.integration_credentials.docs.append({
        "id": "biz:test", "user_id": "biz", "environment": "test",
        "public_key": pub, "secret_hash": server._hash_secret(secret),
        "active": True,
    })
    db.users.docs.append({"id": "biz", "account_type": "merchant"})
    monkeypatch.setattr(server, "db", db)
    router = create_router(ctx(db))
    endpoint = route(router, "/v1/deposits", "POST")
    auth_dep = inspect.signature(endpoint).parameters["credential"].default
    authenticate = auth_dep.dependency

    assert run(authenticate(req({
        "Authorization": f"Bearer {secret}", "X-Public-Key": pub,
    })))["environment"] == "test"
    with pytest.raises(HTTPException) as mismatch:
        run(authenticate(req({
            "Authorization": f"Bearer {secret}", "X-Public-Key": "pk_live_other",
        })))
    assert mismatch.value.status_code == 401
    with pytest.raises(HTTPException) as absent_pair:
        run(authenticate(req({"Authorization": f"Bearer sk_live_{secret}"})))
    assert absent_pair.value.status_code == 401


def test_test_environment_financial_mutations_fail_closed():
    db = DB()
    router = create_router(ctx(db))
    endpoint = route(router, "/v1/deposits", "POST")
    body = SimpleNamespace(model_dump=lambda: {
        "amount": 1000, "currency": "XOF", "country": "TG",
        "operator": "tmoney_tg", "phone_number": "90000000",
        "email": "buyer@example.com", "full_name": "Buyer",
    })
    credential = {"user_id": "biz", "environment": "test",
                  "scopes": ["deposits:write"]}
    with pytest.raises(HTTPException) as exc:
        run(endpoint(body, req({"Idempotency-Key": "order-test-1"}), credential))
    assert exc.value.status_code == 503
    assert not db.integration_operations.docs
    assert not db.integration_idempotency.docs


def test_idempotency_claim_replays_without_calling_business_handler():
    db = DB()
    calls = []

    async def ordinary_handler(model, request, uid):
        calls.append((model, uid))
        return {"id": "deposit-1", "status": "pending"}

    router = create_router(ctx(db, start_mobile_money_deposit=ordinary_handler))
    endpoint = route(router, "/v1/deposits", "POST")
    body = SimpleNamespace(model_dump=lambda: {
        "amount": 1000, "currency": "XOF", "country": "TG",
        "operator": "tmoney_tg", "phone_number": "90000000",
        "email": "buyer@example.com", "full_name": "Buyer",
        "reference": "order-1", "description": None, "otp": None,
        "fee_bearer": "client",
    }, reference="order-1")
    credential = {"user_id": "biz", "environment": "live",
                  "scopes": ["deposits:write"]}
    request = req({"Idempotency-Key": "order-live-1"})
    first = run(endpoint(body, request, credential))
    second = run(endpoint(body, request, credential))
    assert first == second
    assert len(calls) == 1
    assert calls[0][0].idempotency_key.startswith("btpi_")
    assert calls[0][0].idempotency_key != "order-live-1"
    assert len(calls[0][0].idempotency_key) <= 120
    assert len(db.integration_operations.docs) == 1


@pytest.mark.parametrize("legacy_bearer", [None, "client", "sender", "merchant"])
def test_integration_deposit_includes_fees_in_payer_total(legacy_bearer):
    db = DB()
    calls = []

    async def deposit_handler(model, _request, uid):
        calls.append((model, uid))
        fees = server.paydunya.calculate_fees(
            model.amount, {"currency": "XOF", "gateway_fee_fixed": 500},
            model.fee_bearer,
        )
        return {"id": "deposit-1", "status": "pending", **fees}

    router = create_router(ctx(db, start_mobile_money_deposit=deposit_handler))
    endpoint = route(router, "/v1/deposits", "POST")
    body_type = inspect.signature(endpoint).parameters["body"].annotation
    body_values = dict(amount=2000, currency="XOF", country="TG",
                       operator="tmoney_tg", phone_number="90000000",
                       email="buyer@example.com", full_name="Buyer")
    if legacy_bearer is not None:
        body_values["fee_bearer"] = legacy_bearer
    body = body_type(**body_values)
    assert body.model_dump()["fee_bearer"] == (legacy_bearer or "client")
    result = run(endpoint(
        body, req({"Idempotency-Key": f"deposit-inclusive-{legacy_bearer}"}),
        {"user_id": "biz", "environment": "live", "scopes": ["deposits:write"]},
    ))
    assert calls[0][1] == "biz"
    assert calls[0][0].fee_bearer == "merchant"
    assert result["deposit"]["charged_amount"] == 2000
    assert result["deposit"]["wallet_credit_amount"] == 1500
    assert result["deposit"]["total_fee"] == 500
    assert run(endpoint(
        body, req({"Idempotency-Key": f"deposit-inclusive-{legacy_bearer}"}),
        {"user_id": "biz", "environment": "live", "scopes": ["deposits:write"]},
    )) == result
    assert len(calls) == 1


@pytest.mark.parametrize("legacy_bearer", [None, "receiver", "sender"])
def test_integration_payout_adds_fees_to_merchant_debit(legacy_bearer):
    db = DB()
    calls = []

    async def transfer_handler(model, _request, uid):
        calls.append((model, uid))
        fees = server.paydunya.calculate_fees(
            model.amount, {"currency": "XOF", "gateway_fee_fixed": 500},
            model.fee_bearer,
        )
        return {
            "transaction": {"id": "payout-1", "status": "pending"},
            "fee": fees["total_fee"],
            "total_debit": fees["charged_amount"],
            "recipient_gets": fees["wallet_credit_amount"],
        }

    router = create_router(ctx(db, transfer=transfer_handler))
    endpoint = route(router, "/v1/payouts", "POST")
    body_type = inspect.signature(endpoint).parameters["body"].annotation
    body_values = dict(amount=2000, currency="XOF", country="TG",
                       operator="tmoney_tg", recipient="90000000")
    if legacy_bearer is not None:
        body_values["fee_bearer"] = legacy_bearer
    body = body_type(**body_values)
    credential = {"user_id": "biz", "environment": "live",
                  "scopes": ["payouts:write"], "payout_opt_in": True,
                  "user": {"id": "biz", "kyc_status": "verified"}}
    request = req({"Idempotency-Key": f"payout-external-{legacy_bearer}"})
    result = run(endpoint(body, request, credential))
    assert calls[0][1] == "biz"
    assert calls[0][0].fee_bearer == "sender"
    assert result["payout"]["fee"] == 500
    assert result["payout"]["total_debit"] == 2500
    assert result["payout"]["recipient_gets"] == 2000
    assert run(endpoint(body, request, credential)) == result
    assert len(calls) == 1


def test_integration_payout_rejects_unverified_kyc_before_idempotency_claim():
    db = DB()
    calls = []

    async def transfer_handler(*args):
        calls.append(args)
        return {"transaction": {"id": "should-not-run", "status": "pending"}}

    router = create_router(ctx(db, transfer=transfer_handler))
    endpoint = route(router, "/v1/payouts", "POST")
    body_type = inspect.signature(endpoint).parameters["body"].annotation
    body = body_type(
        amount=2000, currency="XOF", country="TG", operator="tmoney_tg",
        recipient="90000000",
    )
    credential = {
        "user_id": "biz", "environment": "live",
        "scopes": ["payouts:write"], "payout_opt_in": True,
        "user": {"id": "biz", "kyc_status": "pending"},
    }

    with pytest.raises(HTTPException) as exc:
        run(endpoint(body, req({"Idempotency-Key": "unverified-payout"}), credential))

    assert exc.value.status_code == 403
    assert exc.value.detail == server.OUTGOING_KYC_REQUIRED_DETAIL
    assert not calls
    assert not db.integration_operations.docs
    assert not db.integration_idempotency.docs


def test_integration_exchange_rejects_unverified_kyc_before_claim():
    db = DB()
    calls = []

    async def exchange_handler(*args):
        calls.append(args)
        return {"transaction": {"id": "should-not-run", "status": "completed"}}

    router = create_router(ctx(db, do_exchange=exchange_handler))
    endpoint = route(router, "/v1/exchanges", "POST")
    body_type = inspect.signature(endpoint).parameters["body"].annotation
    body = body_type(from_currency="XOF", to_currency="XAF", amount=1000)
    credential = {
        "user_id": "biz", "environment": "live",
        "scopes": ["exchanges:write"],
        "user": {"id": "biz", "kyc_status": "rejected"},
    }

    with pytest.raises(HTTPException) as exc:
        run(endpoint(body, req({"Idempotency-Key": "unverified-exchange"}), credential))

    assert exc.value.status_code == 403
    assert exc.value.detail == server.OUTGOING_KYC_REQUIRED_DETAIL
    assert not calls
    assert not db.integration_operations.docs
    assert not db.integration_idempotency.docs


def test_reads_are_user_and_environment_scoped():
    db = DB(integration_operations=Collection([{
        "id": "x", "user_id": "other", "environment": "live",
        "kind": "deposit", "business_id": "deposit-1", "status": "pending",
    }]))
    router = create_router(ctx(db))
    endpoint = route(router, "/v1/deposits/{deposit_id}", "GET")
    credential = {"user_id": "biz", "environment": "live"}
    with pytest.raises(HTTPException) as exc:
        run(endpoint("deposit-1", credential))
    assert exc.value.status_code == 404


def test_live_api_uses_responsive_shared_deposit_verification(monkeypatch):
    async def scenario():
        released = asyncio.Event()
        deposit = {
            "id": "deposit-fast", "user_id": "biz", "provider": "paydunya",
            "paydunya_flow": "softpay_direct", "status": "pending", "amount": 500,
            "currency": "XOF", "payment_flow": server.paydunya.payment_flow(
                {"endpoint_slug": "moov-burkina"}),
        }
        db = DB(
            momo_deposits=Collection([deposit]),
            integration_operations=Collection([{
                "id": "operation-fast", "user_id": "biz", "environment": "live",
                "kind": "deposit", "business_id": "deposit-fast", "status": "pending",
            }]),
        )
        monkeypatch.setattr(server, "db", db)
        monkeypatch.setattr(server, "MOMO_STATUS_WAIT_SECONDS", 0.01)

        async def verify(identifier):
            await released.wait()
            await db.momo_deposits.update_one(
                {"id": identifier}, {"$set": {"status": "approved"}})
            return True

        monkeypatch.setattr(server, "_verify_paydunya_deposit", verify)
        router = create_router(ctx(db))
        endpoint = route(router, "/v1/deposits/{deposit_id}", "GET")
        credential = {"user_id": "biz", "environment": "live"}
        pending = await endpoint("deposit-fast", credential)
        assert pending["status"] == "pending"
        assert pending["payment_flow"]["ussd_code"] == "*555*6#"
        task = server._paydunya_confirmation_tasks["deposit-fast"]
        assert not task.done()
        released.set()
        await task
        assert (await endpoint("deposit-fast", credential))["status"] == "approved"
        assert db.integration_operations.docs[0]["status"] == "approved"

    run(scenario())


def test_test_environment_payment_link_creation_fails_closed():
    db = DB()
    router = create_router(ctx(db))
    endpoint = route(router, "/v1/links", "POST")
    body = SimpleNamespace(model_dump=lambda: {
        "title": "Sandbox order", "amount": 1000, "currency": "XOF",
        "description": "", "expires_at": None, "single_use": False,
        "amount_type": "fixed", "min_amount": None, "max_amount": None,
        "fee_bearer": "customer",
    })
    credential = {"user_id": "biz", "environment": "test",
                  "scopes": ["links:write"]}
    with pytest.raises(HTTPException) as exc:
        run(endpoint(body, req({"Idempotency-Key": "link-test-1"}), credential))
    assert exc.value.status_code == 503
    assert not db.integration_idempotency.docs


def test_link_creation_recovers_by_internal_deterministic_id():
    db = DB()
    created = []

    async def create_link_once(body, uid, deterministic_id=None):
        created.append(deterministic_id)
        link = {
            "id": deterministic_id, "user_id": uid, "status": "active",
            "title": body.title, "amount": body.amount, "currency": body.currency,
        }
        await db.payment_links.insert_one(link)
        raise RuntimeError("lost link creation response")

    router = create_router(ctx(db, _create_payment_link=create_link_once))
    endpoint = route(router, "/v1/links", "POST")
    body = SimpleNamespace(model_dump=lambda: {
        "title": "Recovery order", "amount": 1000, "currency": "XOF",
        "description": "", "expires_at": None, "single_use": False,
        "amount_type": "fixed", "min_amount": None, "max_amount": None,
        "fee_bearer": "customer",
    })
    credential = {"user_id": "biz", "environment": "live",
                  "scopes": ["links:write"]}
    request = req({"Idempotency-Key": "link-recovery-1"})
    with pytest.raises(RuntimeError):
        run(endpoint(body, request, credential))

    recovered = run(endpoint(body, request, credential))
    assert recovered["link"]["id"] == created[0]
    assert len(created) == 1
    assert len(db.payment_links.docs) == 1
    assert len(db.integration_operations.docs) == 1


def test_terminal_transition_queues_durable_deduplicated_event():
    db = DB(integration_operations=Collection([{
        "id": "operation-1", "user_id": "biz", "environment": "live",
        "kind": "deposit", "business_id": "dep-1", "status": "pending",
    }]))
    state = ctx(db)
    create_router(state)
    run(state["_integration_status_transition"]("biz", "deposit", "dep-1", "approved"))
    run(state["_integration_status_transition"]("biz", "deposit", "dep-1", "approved"))
    assert db.integration_operations.docs[0]["status"] == "approved"
    assert len(db.integration_webhook_events.docs) == 1
    event = db.integration_webhook_events.docs[0]
    assert event["event_type"] == "payment.success"
    assert event["status"] == "queued"


def test_provider_acceptance_then_handler_error_recovers_without_resubmitting():
    db = DB()
    calls = []

    async def accepted_then_error(model, request, uid):
        calls.append(model.idempotency_key)
        await db.momo_deposits.insert_one({
            "id": "accepted-deposit", "user_id": uid,
            "idempotency_key": model.idempotency_key,
            "status": "pending", "amount": 1000,
        })
        raise RuntimeError("process lost response after provider acceptance")

    router = create_router(ctx(db, start_mobile_money_deposit=accepted_then_error))
    endpoint = route(router, "/v1/deposits", "POST")
    body = SimpleNamespace(model_dump=lambda: {
        "amount": 1000, "currency": "XOF", "country": "TG",
        "operator": "tmoney_tg", "phone_number": "90000000",
        "email": "buyer@example.com", "full_name": "Buyer",
        "reference": "accepted-order", "description": None, "otp": None,
        "fee_bearer": "client",
    }, reference="accepted-order")
    credential = {"user_id": "biz", "environment": "live",
                  "scopes": ["deposits:write"]}
    request = req({"Idempotency-Key": "accepted-provider-1"})
    with pytest.raises(RuntimeError):
        run(endpoint(body, request, credential))

    recovered = run(endpoint(body, request, credential))
    assert recovered["id"] == "accepted-deposit"
    assert recovered["deposit"]["id"] == "accepted-deposit"
    assert len(calls) == 1
    assert len(db.integration_operations.docs) == 1
    assert db.integration_idempotency.docs[0]["response"] == recovered


def test_exchange_after_wallet_debit_recovers_ledger_without_redebit():
    db = DB()
    calls = []

    async def debit_then_error(model, uid):
        calls.append(model.idempotency_key)
        operation_id = f"exchange:{uid}:{model.idempotency_key}"
        db.users.docs.append({
            "id": uid, "wallet_debit_operation_ids": [operation_id],
            "wallet_credit_operation_ids": [operation_id],
        })
        await db.integration_exchange_intents.insert_one({
            "id": f"{uid}:{model.idempotency_key}", "user_id": uid,
            "operation_id": operation_id, "amount": 1000,
            "fee": 10, "rate": 1.2, "received": 1188,
            "from_currency": "XOF", "to_currency": "XAF",
            "pair": "XOF_XAF", "status": "applied",
        })
        raise RuntimeError("crash after local exchange debit")

    async def repair_ledger(intent):
        await db.transactions.insert_one({
            "id": "exchange-ledger", "user_id": intent["user_id"],
            "type": "exchange", "status": "completed", "currency": "XOF",
            "amount": 1000, "metadata": {
                "operation_id": f"{intent['operation_id']}:out",
                "rate": intent["rate"], "fee": intent["fee"],
                "received": intent["received"],
                "from_currency": intent["from_currency"],
                "to_currency": intent["to_currency"],
            },
        })

    router = create_router(ctx(db, do_exchange=debit_then_error,
                               _recover_integration_exchange=repair_ledger))
    endpoint = route(router, "/v1/exchanges", "POST")
    body = SimpleNamespace(model_dump=lambda: {
        "from_currency": "XOF", "to_currency": "XAF", "amount": 1000,
    }, from_currency="XOF", to_currency="XAF", amount=1000)
    credential = {"user_id": "biz", "environment": "live",
                  "scopes": ["exchanges:write"],
                  "user": {"id": "biz", "kyc_status": "verified"}}
    request = req({"Idempotency-Key": "exchange-debit-recovery"})
    with pytest.raises(RuntimeError):
        run(endpoint(body, request, credential))

    recovered = run(endpoint(body, request, credential))
    assert recovered["id"] == "exchange-ledger"
    assert recovered["status"] == "completed"
    assert len(calls) == 1
    assert len(db.integration_operations.docs) == 1
    assert len(db.transactions.docs) == 1


def test_processing_outbox_event_is_reclaimed_after_worker_crash(monkeypatch):
    event = {
        "id": "stable-event-id", "user_id": "biz", "environment": "live",
        "event_type": "payment.success", "data": {"id": "dep-1", "status": "approved"},
        "status": "processing", "attempts": 1, "processing_at": "2000-01-01T00:00:00+00:00",
    }
    db = DB(
        integration_webhooks=Collection([{
            "id": "biz:live", "user_id": "biz", "environment": "live",
            "active": True, "url": "https://merchant.example/hook",
            "secret_encrypted": server._encrypt("hook-secret"),
        }]),
        integration_webhook_events=Collection([event]),
    )
    async def resolve_public(_):
        return _public_dns()

    state = ctx(db, _resolve_safe_outbound_http_ips=resolve_public)
    create_router(state)
    sent = []

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, **kwargs):
            self.transport = kwargs["transport"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, url, content, headers):
            sent.append((url, headers["X-BizTransPay-Event-Id"],
                         self.transport._pool._network_backend.pinned_ip))
            return FakeResponse()

    monkeypatch.setattr(integration_api.httpx, "AsyncClient", FakeClient)
    run(state["_integration_process_event"](event))
    assert sent == [("https://merchant.example/hook", "stable-event-id", "8.8.8.8")]
    assert db.integration_webhook_events.docs[0]["status"] == "delivered", (
        db.integration_webhook_events.docs[0],
        db.integration_webhook_deliveries.docs,
    )


def test_failed_outbox_event_stops_after_bounded_retry_limit(monkeypatch):
    event = {
        "id": "bounded-event-id", "user_id": "biz", "environment": "live",
        "event_type": "payment.success", "data": {"id": "dep-3", "status": "approved"},
        "status": "failed", "attempts": 4,
        "next_retry_at": "2000-01-01T00:00:00+00:00",
    }
    db = DB(
        integration_webhooks=Collection([{
            "id": "biz:live", "user_id": "biz", "environment": "live",
            "active": True, "url": "https://merchant.example/hook",
            "secret_encrypted": server._encrypt("hook-secret"),
        }]),
        integration_webhook_events=Collection([event]),
    )
    async def resolve_public(_):
        return _public_dns()

    state = ctx(db, _resolve_safe_outbound_http_ips=resolve_public)
    create_router(state)
    calls = []

    class FailedResponse:
        status_code = 503

    class FailingClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, *_args, **_kwargs):
            calls.append(1)
            return FailedResponse()

    monkeypatch.setattr(integration_api.httpx, "AsyncClient", FailingClient)
    run(state["_integration_process_event"](event))
    stored = db.integration_webhook_events.docs[0]
    assert stored["status"] == "failed"
    assert stored["attempts"] == 5
    assert stored["next_retry_at"] is None
    assert len(calls) == 3


def test_event_without_webhook_waits_and_delivers_after_configuration(monkeypatch):
    event = {
        "id": "unconfigured-stable-id", "user_id": "biz", "environment": "live",
        "event_type": "payment.success", "data": {"id": "dep-4", "status": "paid"},
        "status": "queued", "attempts": 0,
    }
    db = DB(integration_webhook_events=Collection([event]))

    async def resolve_public(_):
        return _public_dns()

    state = ctx(db, _resolve_safe_outbound_http_ips=resolve_public)
    create_router(state)
    run(state["_integration_process_event"](event))
    assert db.integration_webhook_events.docs[0]["status"] == "waiting_webhook"
    assert db.integration_webhook_events.docs[0]["attempts"] == 0

    db.integration_webhooks.docs.append({
        "id": "biz:live", "user_id": "biz", "environment": "live",
        "active": True, "url": "https://merchant.example/hook",
        "secret_encrypted": server._encrypt("hook-secret"),
    })
    db.integration_webhook_events.docs[0]["next_retry_at"] = "2000-01-01T00:00:00+00:00"
    sent_ids = []

    class SuccessResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, _url, content, headers):
            sent_ids.append(headers["X-BizTransPay-Event-Id"])
            return SuccessResponse()

    monkeypatch.setattr(integration_api.httpx, "AsyncClient", FakeClient)
    waiting = db.integration_webhook_events.docs[0]
    run(state["_integration_process_event"](waiting))
    assert db.integration_webhook_events.docs[0]["status"] == "delivered", (
        db.integration_webhook_events.docs[0].get("last_error"),
        [doc.get("error") for doc in db.integration_webhook_deliveries.docs],
    )
    assert sent_ids == ["unconfigured-stable-id"]


def _public_dns():
    return ["8.8.8.8"]


def test_mbiyo_dispatch_phase_recovery_refunds_only_proven_pre_dispatch(monkeypatch):
    db = DB(
        transactions=Collection([
            {"id": "before-dispatch", "user_id": "biz", "type": "transfer",
             "status": "pending", "currency": "XOF", "created_at": "2000-01-01",
             "metadata": {"provider": "mbiyo", "transfer_type": "biz_to_mobile",
                          "total_debit": 1200,
                          "mbiyo_submission_phase": "not_submitted",
                          "mbiyo_submission_phase_at": "2000-01-01"}},
            {"id": "after-dispatch", "user_id": "biz", "type": "transfer",
             "status": "pending", "currency": "XOF", "created_at": "2000-01-01",
             "metadata": {"provider": "mbiyo", "transfer_type": "biz_to_mobile",
                          "total_debit": 1200,
                          "mbiyo_submission_phase": "dispatching",
                          "mbiyo_submission_phase_at": "2000-01-01"}},
            {"id": "legacy-unknown", "user_id": "biz", "type": "transfer",
             "status": "pending", "currency": "XOF", "created_at": "2000-01-01",
             "metadata": {"provider": "mbiyo", "transfer_type": "biz_to_mobile",
                          "total_debit": 1200}},
            {"id": "not-debited", "user_id": "biz", "type": "transfer",
             "status": "pending", "currency": "XOF", "created_at": "2000-01-01",
             "metadata": {"provider": "mbiyo", "transfer_type": "biz_to_mobile",
                          "total_debit": 1200,
                          "mbiyo_submission_phase": "not_submitted",
                          "mbiyo_submission_phase_at": "2000-01-01"}},
        ]),
        users=Collection([{
            "id": "biz", "balance_xof": 8800,
            "withdrawal_debit_ids": ["before-dispatch", "after-dispatch",
                                     "legacy-unknown"],
        }]),
    )
    monkeypatch.setattr(server, "db", db)
    refund_calls = []
    review_calls = []
    provider_calls = []

    async def refund_once(tx_id, reason):
        refund_calls.append((tx_id, reason))
        tx = next(row for row in db.transactions.docs if row["id"] == tx_id)
        if tx["status"] != "pending":
            return False
        tx["status"] = "failed"
        tx["metadata"]["refunded"] = True
        return True

    async def mark_review(tx_id, reason, detail=""):
        review_calls.append((tx_id, reason))
        tx = next(row for row in db.transactions.docs if row["id"] == tx_id)
        tx["metadata"]["manual_review_required"] = True
        tx["metadata"]["mbiyo_submission_review_required"] = True
        tx["metadata"]["manual_review_reason"] = reason
        return tx

    class NoDispatchClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def payout(self, **_kwargs):
            provider_calls.append("payout")

        async def status(self, *_args):
            provider_calls.append("status")

    monkeypatch.setattr(server, "_refund_mobile_withdrawal", refund_once)
    monkeypatch.setattr(server, "_mark_mbiyo_submission_manual_review", mark_review)
    monkeypatch.setattr(server.mbiyo, "MbiyoClient", NoDispatchClient)
    grace_before = "2020-01-01T00:00:00+00:00"

    before = db.transactions.docs[0]
    assert run(server._reconcile_mbiyo_without_provider_id(before, grace_before)) == "failed"
    assert run(server._reconcile_mbiyo_without_provider_id(before, grace_before)) == "failed"
    assert refund_calls == [("before-dispatch", "mbiyo_payout_not_submitted")]

    for tx in db.transactions.docs[1:3]:
        assert run(server._reconcile_mbiyo_without_provider_id(tx, grace_before)) == "manual_review"
        assert run(server._reconcile_mbiyo_without_provider_id(tx, grace_before)) == "manual_review"
        assert tx["status"] == "pending"
        assert tx["metadata"]["manual_review_required"] is True
    assert {call[0] for call in review_calls} == {"after-dispatch", "legacy-unknown"}
    no_debit = db.transactions.docs[3]
    assert run(server._reconcile_mbiyo_without_provider_id(
        no_debit, grace_before)) == "failed"
    assert no_debit["status"] == "failed"
    assert not any(call[0] == "not-debited" for call in refund_calls)
    assert provider_calls == []
    assert db.users.docs[0]["balance_xof"] == 8800


def test_pending_operation_scanner_repairs_missed_terminal_enqueue():
    db = DB(
        integration_operations=Collection([{
            "id": "claim:deposit", "user_id": "biz", "environment": "live",
            "kind": "deposit", "business_id": "dep-1", "status": "pending",
            "updated_at": "2025-01-01T00:00:00+00:00",
        }]),
        momo_deposits=Collection([{
            "id": "dep-1", "user_id": "biz", "status": "approved",
        }]),
    )
    state = ctx(db)
    create_router(state)
    run(state["_integration_reconcile_pending"]())
    assert db.integration_operations.docs[0]["status"] == "approved"
    assert len(db.integration_webhook_events.docs) == 1
    assert db.integration_webhook_events.docs[0]["event_type"] == "payment.success"


def test_scanner_pages_past_500_operations_and_link_payments():
    operations = [{
        "id": f"op-{index:04d}", "user_id": "biz", "environment": "live",
        "kind": "deposit", "business_id": f"missing-{index}",
        "status": "pending",
    } for index in range(501)]
    operations.extend([
        {"id": "op-z-terminal", "user_id": "biz", "environment": "live",
         "kind": "exchange", "business_id": "exchange-old", "status": "pending"},
        {"id": "link-operation", "user_id": "biz", "environment": "live",
         "kind": "link", "business_id": "link-old", "status": "active"},
    ])
    payments = [{
        "id": f"payment-{index:04d}", "link_id": "link-old",
        "status": "pending", "created_at": f"2000-01-{(index % 28) + 1:02d}",
    } for index in range(501)]
    payments.append({
        "id": "payment-z-terminal", "link_id": "link-old",
        "status": "paid", "created_at": "2000-01-01",
    })
    db = DB(
        integration_operations=Collection(operations),
        transactions=Collection([{
            "id": "exchange-old", "user_id": "biz", "status": "completed",
        }]),
        link_payments=Collection(payments),
    )
    state = ctx(db)
    create_router(state)
    run(state["_integration_reconcile_pending"]())

    assert any(event["event_type"] == "exchange.success"
               and event["data"]["id"] == "exchange-old"
               for event in db.integration_webhook_events.docs)
    assert any(event["event_type"] == "payment.success"
               and event["data"]["id"] == "payment-z-terminal"
               for event in db.integration_webhook_events.docs)


def test_manual_rate_limit_cleanup_deletes_expired_and_legacy_rows():
    db = DB(integration_rate_limits=Collection([
        {"id": "old", "expires_at": "2000-01-01T00:00:00+00:00"},
        {"id": "legacy"},
        {"id": "current", "expires_at": "2999-01-01T00:00:00+00:00"},
    ]))
    state = ctx(db)
    create_router(state)
    run(state["_integration_cleanup_rate_limits"]())
    assert [doc["id"] for doc in db.integration_rate_limits.docs] == ["current"]


def test_webhook_dns_rebinding_is_rejected_before_second_connection(monkeypatch):
    addresses = iter((["8.8.8.8"], ["10.0.0.4"]))
    resolver_calls = []

    async def resolver(_url):
        result = next(addresses)
        resolver_calls.append(result)
        return result

    db = DB(integration_webhooks=Collection([{
        "id": "biz:live", "user_id": "biz", "environment": "live",
        "active": True, "url": "https://merchant.example/hook",
        "secret_encrypted": server._encrypt("hook-secret"),
    }]))
    state = ctx(db, _resolve_safe_outbound_http_ips=resolver)
    create_router(state)
    attempted_ips = []

    class FakeClient:
        def __init__(self, **kwargs):
            self.backend = kwargs["transport"]._pool._network_backend

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, url, content, headers):
            attempted_ips.append(self.backend.pinned_ip)
            raise integration_api.httpx.ConnectError("mock connection failure")

    monkeypatch.setattr(integration_api.httpx, "AsyncClient", FakeClient)
    result = run(state["_integration_deliver_event"](
        "biz", "live", "payment.success", {"id": "dep-2"}, "event-rebind"))
    assert resolver_calls == [["8.8.8.8"], ["10.0.0.4"]]
    assert attempted_ips == ["8.8.8.8"]
    assert result["status"] == "failed"


def test_security_mutations_require_recent_browser_authentication():
    router = create_router(ctx(DB()))
    for path, method in (
        ("/credentials", "POST"),
        ("/credentials/{environment}/regenerate", "POST"),
        ("/credentials/{environment}", "PATCH"),
        ("/credentials/{environment}", "DELETE"),
        ("/webhooks/{environment}", "PUT"),
        ("/webhooks/{environment}/regenerate-secret", "POST"),
    ):
        endpoint = route(router, path, method)
        uid_param = next(param for name, param in inspect.signature(endpoint).parameters.items()
                         if name in ("uid", "recently_authenticated_uid"))
        assert uid_param.default.dependency is not None


def test_payout_scope_is_explicit_and_mutated_under_recent_auth_route():
    db = DB()
    router = create_router(ctx(db))
    create = route(router, "/credentials", "POST")
    created = run(create(
        SimpleNamespace(environment="live", payout_opt_in=False), "biz"))
    assert "payouts:write" not in created["credentials"]["scopes"]
    patch = route(router, "/credentials/{environment}", "PATCH")
    run(patch("live", SimpleNamespace(active=True, payout_opt_in=True), "biz"))
    credential = db.integration_credentials.docs[0]
    assert credential["payout_opt_in"] is True
    assert "payouts:write" in credential["scopes"]


def test_delete_credentials_revokes_one_environment_and_preserves_history():
    db = DB()
    for env in ("test", "live"):
        db.integration_credentials.docs.append({
            "id": f"biz:{env}", "user_id": "biz", "environment": env,
        })
        db.integration_webhooks.docs.append({
            "id": f"biz:{env}", "user_id": "biz", "environment": env,
        })
    db.integration_credentials.docs.append({
        "id": "other:live", "user_id": "other", "environment": "live",
    })
    db.integration_operations.docs.append({
        "id": "pending-operation", "user_id": "biz", "environment": "live",
    })
    db.integration_idempotency.docs.append({
        "id": "claim", "user_id": "biz", "environment": "live",
    })

    class Connection:
        def __init__(self):
            self.queries = []

        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def fetch(self, query, uid, env):
            self.queries.append(query)
            matching = [doc for doc in db.integration_credentials.docs
                        if doc["user_id"] == uid and doc["environment"] == env]
            db.integration_credentials.docs = [
                doc for doc in db.integration_credentials.docs if doc not in matching]
            return [{"doc_id": doc["id"]} for doc in matching]

        async def execute(self, query, uid, env):
            self.queries.append(query)
            db.integration_webhooks.docs = [
                doc for doc in db.integration_webhooks.docs
                if doc["user_id"] != uid or doc["environment"] != env]

    conn = Connection()
    store = SimpleNamespace(pool=SimpleNamespace(acquire=lambda: conn))
    endpoint = route(create_router(ctx(db, postgres_store=store)),
                     "/credentials/{environment}", "DELETE")
    body_type = inspect.signature(endpoint).parameters["body"].annotation
    assert body_type.model_fields["confirmation"].is_required()
    with pytest.raises(ValueError):
        body_type(confirmation="no")
    with pytest.raises(HTTPException) as not_found:
        run(endpoint("live", body_type(confirmation="SUPPRIMER"), "missing"))
    assert not_found.value.status_code == 404
    assert run(endpoint("live", body_type(confirmation="SUPPRIMER"), "biz")) == {
        "environment": "live", "deleted": True,
    }
    assert [(doc["user_id"], doc["environment"])
            for doc in db.integration_credentials.docs] == [
                ("biz", "test"), ("other", "live"),
            ]
    assert [doc["environment"] for doc in db.integration_webhooks.docs] == ["test"]
    assert db.integration_operations.docs[0]["id"] == "pending-operation"
    assert db.integration_idempotency.docs[0]["id"] == "claim"
    assert all("document->>'user_id' = $1" in query
               and "document->>'environment' = $2" in query for query in conn.queries)


def test_webhook_destinations_share_api_credentials_and_fan_out_independently(monkeypatch):
    credential = {
        "id": "biz:live", "user_id": "biz", "environment": "live",
        "public_key": "pk_live_shared", "secret_hash": "same-secret-hash",
        "active": True,
    }
    db = DB(integration_credentials=Collection([credential]))

    async def validate_url(url, _label):
        return url

    async def resolve_ips(_url):
        return ["8.8.8.8"]

    state = ctx(
        db, _validate_outbound_http_url=validate_url,
        _resolve_safe_outbound_http_ips=resolve_ips,
    )
    router = create_router(state)
    create = route(router, "/webhooks/{environment}", "POST")
    body_type = inspect.signature(create).parameters["body"].annotation
    first = run(create(
        "live", body_type(name="Boutique A", url="https://a.example/hooks"), "biz"))
    second = run(create(
        "live", body_type(name="Boutique B", url="https://b.example/hooks"), "biz"))

    assert first["webhook"]["id"] != second["webhook"]["id"]
    assert first["webhook_secret"] != second["webhook_secret"]
    assert len(db.integration_credentials.docs) == 1
    assert db.integration_credentials.docs[0] == credential

    posted = []

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, content, headers):
            posted.append((url, content, headers))
            return SimpleNamespace(status_code=204)

    monkeypatch.setattr(integration_api.httpx, "AsyncClient", FakeClient)
    result = run(state["_integration_deliver_event"](
        "biz", "live", "payment.success", {"id": "payment-1"}, "shared-event"))

    assert result["status"] == "delivered"
    assert len(result["deliveries"]) == 2
    assert {entry[0] for entry in posted} == {
        "https://a.example/hooks", "https://b.example/hooks",
    }
    assert {entry[2]["X-BizTransPay-Event-Id"] for entry in posted} == {"shared-event"}
    assert {doc["destination_id"] for doc in db.integration_webhook_deliveries.docs} == {
        first["webhook"]["id"], second["webhook"]["id"],
    }
    assert all(doc["status"] == "delivered"
               for doc in db.integration_webhook_deliveries.docs)


def test_webhook_update_and_delete_are_owner_scoped_and_keep_delivery_history():
    db = DB(integration_webhooks=Collection([
        {
            "id": "wh_owned", "user_id": "biz", "environment": "live",
            "name": "Owned", "url": "https://owned.example/hook",
            "active": True, "secret_encrypted": server._encrypt("owned-secret"),
        },
        {
            "id": "wh_foreign", "user_id": "other", "environment": "live",
            "name": "Foreign", "url": "https://foreign.example/hook",
            "active": True, "secret_encrypted": server._encrypt("foreign-secret"),
        },
    ]), integration_webhook_deliveries=Collection([{
        "id": "delivery-owned", "user_id": "biz", "environment": "live",
        "destination_id": "wh_owned", "status": "delivered",
    }]))
    router = create_router(ctx(db))
    update = route(router, "/webhooks/{environment}/{webhook_id}", "PATCH")
    update_body = inspect.signature(update).parameters["body"].annotation
    with pytest.raises(HTTPException) as foreign_update:
        run(update(
            "live", "wh_foreign", update_body(active=False), "biz"))
    assert foreign_update.value.status_code == 404

    async def validate_url(url, _label):
        return url

    router = create_router(ctx(db, _validate_outbound_http_url=validate_url))
    update = route(router, "/webhooks/{environment}/{webhook_id}", "PATCH")
    update_body = inspect.signature(update).parameters["body"].annotation
    changed = run(update(
        "live", "wh_owned",
        update_body(name="Updated site", url="https://new.example/hooks", active=False),
        "biz"))
    assert changed["webhook"]["name"] == "Updated site"
    assert changed["webhook"]["active"] is False
    assert db.integration_webhooks.docs[1]["url"] == "https://foreign.example/hook"

    delete = route(router, "/webhooks/{environment}/{webhook_id}", "DELETE")
    assert run(delete("live", "wh_owned", "biz"))["deleted"] is True
    assert [doc["id"] for doc in db.integration_webhooks.docs] == ["wh_foreign"]
    assert db.integration_webhook_deliveries.docs[0]["id"] == "delivery-owned"


def test_payment_api_global_toggle_blocks_access_without_deleting_existing_keys():
    db = DB(
        users=Collection([{"id": "biz", "account_type": "merchant"}]),
        integration_credentials=Collection([{
            "id": "biz:live", "user_id": "biz", "environment": "live",
            "active": True, "public_key": "pk_live_stored",
        }]),
        integration_webhook_events=Collection([{
            "id": "queued-event", "user_id": "biz", "environment": "live",
            "event_type": "payment.success", "data": {},
            "status": "queued", "attempts": 0,
        }]),
    )
    async def load_features():
        return {"payment_api_enabled": False}

    state = ctx(db, get_app_features=load_features)
    router = create_router(state)
    settings = route(router, "/settings", "GET")
    browser_owner = inspect.signature(settings).parameters["uid"].default.dependency
    with pytest.raises(HTTPException) as browser_error:
        run(browser_owner("biz"))
    assert browser_error.value.status_code == 403
    assert browser_error.value.detail["code"] == "PAYMENT_API_DISABLED"

    start_deposit = route(router, "/v1/deposits", "POST")
    authenticate = inspect.signature(start_deposit).parameters["credential"].default.dependency
    with pytest.raises(HTTPException) as api_error:
        run(authenticate(req()))
    assert api_error.value.status_code == 403
    assert api_error.value.detail["code"] == "PAYMENT_API_DISABLED"

    run(state["_integration_process_event"](db.integration_webhook_events.docs[0]))
    assert db.integration_webhook_events.docs[0]["status"] == "disabled"
    assert db.integration_credentials.docs[0]["public_key"] == "pk_live_stored"
    assert db.integration_webhook_deliveries.docs == []


def test_admin_payment_api_toggle_is_public_and_persistent(monkeypatch):
    db = SimpleNamespace(settings=Collection())
    monkeypatch.setattr(server, "db", db)
    async def audit(*_args, **_kwargs):
        return None
    monkeypatch.setattr(server, "audit", audit)
    admin = {"id": "admin", "username": "admin"}

    public_get = server.public_get_features
    assert run(public_get())["payment_api_enabled"] is True
    result = run(server.admin_update_features(
        server.AdminFeaturesReq(payment_api_enabled=False), admin))
    assert result["payment_api_enabled"] is False
    assert run(public_get())["payment_api_enabled"] is False


def test_user_session_listing_and_remote_revocation_routes_are_absent():
    paths = server.app.openapi()["paths"]
    assert "/api/auth/sessions" not in paths
    assert "/api/auth/sessions/{session_id}" not in paths
    assert "/api/auth/sessions/revoke-all" not in paths


def test_documentation_json_pdf_and_route_method_coverage():
    router = create_router(ctx(DB()))
    json_endpoint = route(router, "/documentation", "GET")
    payload = run(json_endpoint())
    assert payload["title"]
    assert payload["description"]
    assert payload["sections"]
    assert payload["endpoints"]
    assert all(endpoint["examples"] for endpoint in payload["endpoints"])

    pdf_endpoint = route(router, "/documentation.pdf", "GET")
    pdf = run(pdf_endpoint())
    assert pdf.media_type == "application/pdf"
    assert pdf.body.startswith(b"%PDF-")
    assert len(__import__("re").findall(rb"/Type\s*/Page\b", pdf.body)) > 1

    # FastAPI keeps nested routers lazy until OpenAPI generation, so checking
    # app.routes directly misses registered integration paths.
    app_routes = {
        (method.upper(), path.removeprefix("/api/integration"))
        for path, operations in server.app.openapi()["paths"].items()
        for method in operations
    }
    for endpoint in integration_api.ENDPOINTS:
        path = endpoint["path"].split("?", 1)[0].removeprefix("/api/integration")
        assert (endpoint["method"], path) in app_routes


def test_documentation_metadata_matches_openapi_and_real_response_shapes():
    router = create_router(ctx(DB()))
    payload = run(route(router, "/documentation", "GET")())
    openapi = server.app.openapi()
    documented = {(item["method"], item["path"]): item
                  for item in payload["endpoints"]}

    for (method, path), endpoint in documented.items():
        operation = openapi["paths"][path][method.lower()]
        actual_parameters = {
            (item["name"], item["in"], bool(item.get("required")))
            for item in operation.get("parameters", [])
        }
        documented_parameters = {
            (item["name"], item["location"], bool(item["required"]))
            for item in endpoint["parameters"]
            if item["location"] in {"path", "query"}
        }
        assert documented_parameters == actual_parameters, (method, path)

        request_body = operation.get("requestBody")
        body_schema_fields = set()
        body_required_fields = set()
        if request_body:
            schema = request_body["content"]["application/json"]["schema"]
            while "$ref" in schema:
                schema = openapi["components"]["schemas"][
                    schema["$ref"].rsplit("/", 1)[-1]]
            body_schema_fields = set(schema.get("properties", {}))
            body_required_fields = set(schema.get("required", []))
        documented_body = {
            item["name"]: bool(item["required"])
            for item in endpoint["parameters"] if item["location"] == "body"
        }
        assert set(documented_body) == body_schema_fields, (method, path)
        assert {name for name, required in documented_body.items() if required} == (
            body_required_fields), (method, path)
        assert (endpoint["request"] is not None) == bool(request_body), (method, path)
        assert set(endpoint["examples"]) == {"curl", "php", "js", "python"}
        assert all("BIZ_BASE_URL" in code
                   for code in endpoint["examples"].values())
        assert all("https://biz-transppayy.com" not in code
                   for code in endpoint["examples"].values())
        assert all(error_item["description"].endswith(".")
                   for error_item in endpoint["errors"])

    assert all(
        item["auth_type"] in {"bearer", "public"}
        for item in integration_api.ENDPOINTS
        if (item["method"], item["path"].split("?", 1)[0]) in documented
    )
    assert ("GET", "/api/integration/settings") not in documented
    assert ("DELETE", "/api/integration/credentials/{environment}") not in documented
    assert payload["documentation_url"] == "https://biz-transppayy.com/integration/docs"
    public_text = str(payload)
    assert "btp_session" not in public_text
    assert "btp_csrf" not in public_text
    assert "BIZ_SESSION_TOKEN" not in public_text
    quote = documented[("GET", "/api/integration/v1/exchanges/quote")]
    assert set(quote["response"]) == {
        "from_currency", "to_currency", "amount", "fee", "rate", "received",
        "fee_currency",
    }
    assert not any(item["status"] in {409, 503} for item in quote["errors"])
    exchange = documented[("POST", "/api/integration/v1/exchanges")]["response"]
    assert exchange["status"] == "completed"
    assert set(exchange["exchange"]) == {
        "received", "fee", "rate", "from_currency", "to_currency", "transaction",
    }
    for method, path in (
        ("POST", "/api/integration/v1/deposits"),
        ("POST", "/api/integration/v1/payouts"),
        ("POST", "/api/integration/v1/links"),
    ):
        response = documented[(method, path)]["response"]
        assert "success" not in response
        assert {"id", "status"} <= response.keys()
    for (method, path), endpoint in documented.items():
        if method == "GET":
            assert endpoint["request"] is None
        if path in {
                "/api/integration/v1/deposits", "/api/integration/v1/payouts",
                "/api/integration/v1/exchanges", "/api/integration/v1/links",
                "/api/integration/v1/transactions",
        } and method == "POST":
            assert not any(p["name"] == "limit" for p in endpoint["parameters"])

    sections = {section["id"]: section for section in payload["sections"]}
    assert payload["title"] == "API d’intégration Biz-transPay"
    assert {
        "startup", "authentication", "sandbox", "deposits", "payouts",
        "exchanges", "links", "transactions", "security",
        "integration-examples", "webhooks", "http", "errors",
    } <= sections.keys()
    assert {
        "Bien démarrer", "Authentification", "Environnements test et live",
        "Dépôts", "Retraits", "Change", "Liens de paiement",
        "Opérations et états", "Sécurité", "Exemples d’intégration",
        "Webhooks et vérification de signature", "Codes de réponse HTTP",
        "Erreurs et nouvelles tentatives",
    } <= {section["title"] for section in payload["sections"]}
    for endpoint in payload["endpoints"]:
        assert endpoint["section"] in sections
        assert endpoint["title"] == endpoint["description"].rstrip(".")
        assert endpoint["title"].startswith((
            "Consulter", "Créer", "Renouveler", "Activer", "Définir",
            "Envoyer", "Télécharger", "Lancer", "Lister", "Obtenir",
            "Effectuer",
        ))
        assert "auth_type" not in endpoint
    verifier = sections["webhooks"]["examples"]
    assert {"php", "js", "python"} <= verifier.keys()
    for language, required_terms in {
        "php": ("php://input", "hash_equals", "timestamp"),
        "js": ("rawBody", "timingSafeEqual", "timestamp"),
        "python": ("raw_body", "compare_digest", "timestamp"),
    }.items():
        assert all(term in verifier[language] for term in required_terms)

    async def conversion_quote(from_currency, to_currency, amount):
        return {
            "from_currency": from_currency, "to_currency": to_currency,
            "amount": amount, "fee": 100, "rate": 1.0,
            "received": amount - 100, "fee_currency": from_currency,
        }

    response_router = create_router(ctx(
        DB(), conversion_quote=conversion_quote,
        do_exchange=lambda _body, _uid: None,
    ))
    quote_response = run(route(response_router, "/v1/exchanges/quote", "GET")(
        "XOF", "XAF", 10000,
        {"user_id": "biz", "environment": "live", "scopes": []},
    ))
    assert quote_response.keys() == quote["response"].keys()

    async def exchange_result(_body, _uid):
        return {
            "received": 9900, "fee": 100, "rate": 1.0,
            "from_currency": "XOF", "to_currency": "XAF",
            "transaction": {"id": "exchange-actual", "status": "completed"},
        }

    exchange_router = create_router(ctx(DB(), do_exchange=exchange_result))
    exchange_body = SimpleNamespace(
        model_dump=lambda: {"from_currency": "XOF", "to_currency": "XAF",
                            "amount": 10000},
        from_currency="XOF", to_currency="XAF", amount=10000,
    )
    exchange_actual = run(route(exchange_router, "/v1/exchanges", "POST")(
        exchange_body, req({"Idempotency-Key": "docs-exchange-actual"}),
        {"user_id": "biz", "environment": "live", "scopes": ["exchanges:write"],
         "user": {"id": "biz", "kyc_status": "verified"}},
    ))
    assert exchange_actual["status"] == "completed"
    assert exchange_actual.keys() == exchange.keys()
    assert exchange_actual["exchange"].keys() == exchange["exchange"].keys()

    async def transfer_result(_body, _request, _uid):
        return {
            "transaction": {"id": "payout-actual", "status": "pending"},
            "fee": 250, "processed_amount": 5000, "total_debit": 5250,
            "recipient_gets": 5000, "operator": "TMoney",
        }

    payout_router = create_router(ctx(DB(), transfer=transfer_result))
    payout_body = SimpleNamespace(
        model_dump=lambda: {
            "amount": 5000, "currency": "XOF", "country": "TG",
            "operator": "tmoney_tg", "recipient": "90000000",
            "reference": "payout-125", "description": "Supplier payout",
            "fee_bearer": "sender",
        },
        amount=5000, currency="XOF", country="TG", operator="tmoney_tg",
        recipient="90000000", reference="payout-125",
        description="Supplier payout", fee_bearer="sender",
    )
    payout_actual = run(route(payout_router, "/v1/payouts", "POST")(
        payout_body, req({"Idempotency-Key": "docs-payout-actual"}),
        {"user_id": "biz", "environment": "live",
         "scopes": ["payouts:write"], "payout_opt_in": True,
         "user": {"id": "biz", "kyc_status": "verified"}},
    ))
    assert payout_actual["status"] == "pending"
    assert payout_actual.keys() == documented[
        ("POST", "/api/integration/v1/payouts")]["response"].keys()


@pytest.mark.parametrize(
    ("action", "flags"),
    [
        ("approve", {"mbiyo_submission_review_required": True}),
        ("reject", {"mbiyo_submission_unknown": True}),
    ],
)
def test_ambiguous_mbiyo_admin_action_requires_outcome_evidence(
        monkeypatch, action, flags):
    tx = _admin_transaction("mbiyo-missing-evidence", {
        "provider_name": "mbiyo",
        **flags,
    })
    db = DB(transactions=Collection([tx]))
    audits, refunds, credits = _stub_admin_side_effects(monkeypatch, db)
    admin = {"id": "admin-1", "username": "operator.one"}

    if action == "approve":
        async def verified_user(user_id):
            return {"id": user_id, "kyc_status": "verified"}

        monkeypatch.setattr(server, "get_user", verified_user)
        call = server.admin_approve_transaction(
            tx["id"], server.AdminConfirmationRequest(confirmation="CONFIRMER"),
            admin=admin, _recent_uid=admin["id"])
    else:
        call = server.admin_reject_transaction(
            tx["id"], server.AdminRejectRequest(confirmation="CONFIRMER"),
            admin=admin, _recent_uid=admin["id"])

    with pytest.raises(HTTPException) as exc:
        run(call)
    assert exc.value.status_code == 422
    saved = run(db.transactions.find_one({"id": tx["id"]}))
    assert saved["status"] == "pending"
    assert "mbiyo_submission_admin_review" not in saved["metadata"]
    assert not audits and not refunds and not credits


@pytest.mark.parametrize(
    ("action", "outcome"),
    [
        ("approve", "provider_confirmed_paid"),
        ("approve", "operator_verified_manual_completion"),
        ("reject", "provider_confirmed_not_paid"),
        ("reject", "provider_confirmed_rejected"),
    ],
)
def test_ambiguous_mbiyo_admin_action_records_attested_evidence(
        monkeypatch, action, outcome):
    tx = _admin_transaction(f"mbiyo-evidenced-{action}-{outcome}", {
        "provider_name": "mbiyo",
        "mbiyo_submission_review_required": True,
        "mbiyo_submission_unknown": True,
    })
    db = DB(transactions=Collection([tx]))
    audits, refunds, credits = _stub_admin_side_effects(monkeypatch, db)
    admin = {"id": "admin-1", "username": "operator.one"}
    body_fields = {
        "confirmation": "CONFIRMER",
        "provider_outcome": outcome,
        "provider_outcome_evidence_reference": f"mbiyo-case-{outcome}",
        "provider_outcome_attested": True,
    }

    if action == "approve":
        async def verified_user(user_id):
            return {"id": user_id, "kyc_status": "verified"}

        monkeypatch.setattr(server, "get_user", verified_user)
        body = server.AdminConfirmationRequest(**body_fields)
        response = run(server.admin_approve_transaction(
            tx["id"], body, admin=admin, _recent_uid=admin["id"]))
        expected_status = "completed"
    else:
        body = server.AdminRejectRequest(**body_fields)
        response = run(server.admin_reject_transaction(
            tx["id"], body, admin=admin, _recent_uid=admin["id"]))
        expected_status = "failed"

    assert response["tx"]["status"] == expected_status
    review = response["tx"]["metadata"]["mbiyo_submission_admin_review"]
    assert review == {
        "action": action,
        "provider_outcome": outcome,
        "evidence_reference": f"mbiyo-case-{outcome}",
        "admin_attested": True,
        "admin_id": admin["id"],
        "admin_username": admin["username"],
        "recorded_at": review["recorded_at"],
    }
    evidence_audit = next(
        event for event in audits
        if event["action"] == f"mbiyo_ambiguous_submission_{action}")
    assert evidence_audit["admin_id"] == admin["id"]
    assert evidence_audit["details"]["provider_outcome"] == outcome
    assert evidence_audit["details"]["evidence_reference"] == (
        f"mbiyo-case-{outcome}")
    if action == "reject":
        assert refunds == [(
            "merchant-1", "balance_xof", 525,
            f"manual-reject:{tx['id']}",
        )]
    else:
        assert not refunds and not credits


@pytest.mark.parametrize("action", ["approve", "reject"])
def test_ordinary_admin_transactions_need_no_mbiyo_evidence(
        monkeypatch, action):
    if action == "approve":
        tx = _admin_transaction(
            "ordinary-deposit-approve", {"amount_net": 490},
            tx_type="deposit", direction="in")
    else:
        tx = _admin_transaction("ordinary-withdrawal-reject", {})
    db = DB(transactions=Collection([tx]))
    audits, refunds, credits = _stub_admin_side_effects(monkeypatch, db)
    admin = {"id": "admin-1", "username": "operator.one"}

    if action == "approve":
        response = run(server.admin_approve_transaction(
            tx["id"], server.AdminConfirmationRequest(confirmation="CONFIRMER"),
            admin=admin, _recent_uid=admin["id"]))
        assert response["tx"]["status"] == "completed"
        assert credits == [(
            "merchant-1", "balance_xof", 490,
            f"manual-approve:{tx['id']}",
        )]
        assert not refunds
    else:
        response = run(server.admin_reject_transaction(
            tx["id"], server.AdminRejectRequest(confirmation="CONFIRMER"),
            admin=admin, _recent_uid=admin["id"]))
        assert response["tx"]["status"] == "failed"
        assert refunds == [(
            "merchant-1", "balance_xof", 525,
            f"manual-reject:{tx['id']}",
        )]
        assert not credits
    assert "mbiyo_submission_admin_review" not in response["tx"]["metadata"]
    assert any(event["action"] == f"tx_{action}" for event in audits)


@pytest.mark.parametrize("legacy_missing_direction", [False, True])
def test_admin_cannot_approve_pending_outgoing_transaction_without_kyc(
        monkeypatch, legacy_missing_direction):
    tx = _admin_transaction("outgoing-unverified", {}, tx_type="withdrawal")
    if legacy_missing_direction:
        tx.pop("direction")
    db = DB(transactions=Collection([tx]))
    audits, refunds, credits = _stub_admin_side_effects(monkeypatch, db)

    async def unverified_user(user_id):
        return {"id": user_id, "kyc_status": "pending"}

    monkeypatch.setattr(server, "get_user", unverified_user)
    with pytest.raises(HTTPException) as exc:
        run(server.admin_approve_transaction(
            tx["id"],
            server.AdminConfirmationRequest(confirmation="CONFIRMER"),
            admin={"id": "admin-1", "username": "operator.one"},
            _recent_uid="admin-1",
        ))

    assert exc.value.status_code == 403
    assert exc.value.detail == server.OUTGOING_KYC_REQUIRED_DETAIL
    saved = run(db.transactions.find_one({"id": tx["id"]}))
    assert saved["status"] == "pending"
    assert not audits and not refunds and not credits