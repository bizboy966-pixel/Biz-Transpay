"""Real API/business handlers with an isolated store and mocked PayDunya IO."""
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from integration_api import create_router
from test_integration_api import DB, ctx, req, route
from test_provider_flow_regressions import MemoryCollection


class WalletCollection(MemoryCollection):
    """Match Mongo's array membership semantics for exactly-once markers."""
    @classmethod
    def _matches(cls, doc, query):
        for key, expected in query.items():
            actual = cls._value(doc, key)
            if isinstance(actual, list) and isinstance(expected, dict):
                if "$ne" in expected and expected["$ne"] in actual:
                    return False
        return super()._matches(doc, query)

    async def create_index(self, *_args, **_kwargs):
        return "test-index"


def configure(monkeypatch, mode="moov-burkina-faso"):
    user = {"id": "test-merchant", "kyc_status": "verified",
            "full_name": "Test Merchant", "balance_xof": 5000}
    users = WalletCollection()
    users.docs.append(user)
    db = DB(users=users, transactions=WalletCollection())
    monkeypatch.setattr(server, "db", db)
    operator = next(dict(op) for op in server.paydunya.default_withdrawal_catalog()
                    if op["withdraw_mode"] == mode)
    operator.update(active=True, platform_fee_fixed=20)
    async def get_user(uid):
        return await db.users.find_one({"id": uid})
    monkeypatch.setattr(server, "get_user", get_user)
    monkeypatch.setattr(server, "get_transfer_config", AsyncMock(return_value={
        "mobile_money": {"enabled": True, "operators": [operator]},
        "paydunya": {"enabled": True},
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", AsyncMock(return_value={"enabled": False}))
    monkeypatch.setattr(server, "get_afribapay_config", AsyncMock(return_value={"enabled": False}))
    monkeypatch.setattr(server, "get_platform_config", AsyncMock(return_value={
        "auto_withdrawals_disabled": False,
    }))
    monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value={
        "enabled": True, "master_key_encrypted": "test-only",
        "private_key_encrypted": "test-only", "token_encrypted": "test-only",
        "_credentials": {"master_key": "test-only", "private_key": "test-only",
                         "token": "test-only"},
    }))
    notify = AsyncMock()
    monkeypatch.setattr(server, "notify", notify)
    invoice = AsyncMock(return_value={"response_code": "00", "token": "test-payout-token"})
    submit = AsyncMock(return_value={"response_code": "00", "status": "pending"})
    monkeypatch.setattr(server.paydunya, "get_disbursement_invoice", invoice)
    monkeypatch.setattr(server.paydunya, "submit_disbursement_invoice", submit)
    context = ctx(db)
    router = create_router(context)
    monkeypatch.setattr(server, "_notify_integration_business_transition",
                        context["_integration_status_transition"])
    return db, router, invoice, submit, notify


def request(key="test-payout-operation"):
    value = req({"Idempotency-Key": key})
    value.scope.update(scheme="https", server=("merchant.test", 443))
    return value


@pytest.mark.parametrize("outcome", ["pending", "completed", "failed"])
@pytest.mark.parametrize("mode", ["moov-burkina-faso", "orange-money-burkina"])
def test_api_dispatches_real_payout_handler_and_tracks_verified_callback(monkeypatch, outcome, mode):
    async def scenario():
        db, router, invoice, submit, notify = configure(monkeypatch, mode)
        create = route(router, "/v1/payouts", "POST")
        get = route(router, "/v1/payouts/{payout_id}", "GET")
        body_type = create.__annotations__["body"]
        body = body_type(amount=1000, currency="XOF", country="BF",
                          operator=mode, recipient="70000000")
        credential = {"user_id": "test-merchant", "environment": "live",
                      "user": {"kyc_status": "verified"},
                      "scopes": ["payouts:write"], "payout_opt_in": True}
        # Both creation and submission must stay isolated from the network.
        check = AsyncMock()
        monkeypatch.setattr(server.paydunya, "check_disbursement_status", check)
        initial = await create(body, request(), credential)
        assert initial["status"] == "pending"
        assert initial["payout"]["recipient_gets"] == 1000
        assert initial["payout"]["total_debit"] == 1020
        assert db.users.docs[0]["balance_xof"] == 3980
        assert (await create(body, request(), credential)) == initial
        invoice.assert_awaited_once()
        submit.assert_awaited_once()
        assert submit.await_args.kwargs["withdraw_mode"] == mode
        tx = await db.transactions.find_one({"id": initial["id"]})
        check.return_value = {
            "response_code": "00", "status": outcome,
            "invoice_token": "test-payout-token", "amount": 1000,
            "withdraw_mode": mode, "disburse_id": tx["reference"],
        }
        await server.paydunya_disbursement_webhook(request(), ref=tx["reference"])
        await server.paydunya_disbursement_webhook(request(), ref=tx["reference"])
        # Merchant API state changes even when no client polls the status route.
        assert db.integration_operations.docs[0]["status"] == outcome
        viewed = await get(initial["id"], credential)
        assert viewed["status"] == outcome
        assert db.users.docs[0]["balance_xof"] == (5000 if outcome == "failed" else 3980)
        assert db.integration_operations.docs[0]["status"] == outcome
        # Terminal callbacks must not contact the provider or notify twice.
        assert check.await_count == (2 if outcome == "pending" else 1)
        terminal_notifications = [
            call for call in notify.await_args_list
            if len(call.args) > 1 and call.args[1] in ("withdrawal_success", "withdrawal_failed")
        ]
        assert len(terminal_notifications) == (0 if outcome == "pending" else 1)
        with pytest.raises(HTTPException) as denied:
            await get(initial["id"], {**credential, "user_id": "other-merchant"})
        assert denied.value.status_code == 404

    asyncio.run(scenario())


@pytest.mark.parametrize("changed_field", ["invoice_token", "amount", "withdraw_mode", "disburse_id"])
def test_payout_callback_cannot_settle_an_unmatched_provider_result(monkeypatch, changed_field):
    async def scenario():
        db, _, _, _, _ = configure(monkeypatch)
        tx = {
            "id": "test-payout", "reference": "test-reference", "user_id": "test-merchant",
            "type": "transfer", "status": "pending", "amount": 1000, "currency": "XOF",
            "metadata": {
                "provider": "paydunya", "transfer_type": "biz_to_mobile",
                "paydunya_invoice_token": "test-payout-token",
                "paydunya_withdraw_mode": "moov-burkina-faso",
                "recipient_gets": 1000, "total_debit": 1020, "debit_applied": True,
            },
        }
        db.transactions.docs.append(tx)
        db.users.docs[0]["balance_xof"] = 3980
        response = {"response_code": "00", "status": "completed",
                    "invoice_token": "test-payout-token", "amount": 1000,
                    "withdraw_mode": "moov-burkina-faso", "disburse_id": "test-reference"}
        response[changed_field] = 999 if changed_field == "amount" else "incorrect"
        monkeypatch.setattr(server.paydunya, "check_disbursement_status",
                            AsyncMock(return_value=response))
        with pytest.raises(HTTPException) as rejected:
            await server.paydunya_disbursement_webhook(request(), ref="test-reference")
        assert rejected.value.status_code == 503
        assert db.transactions.docs[0]["status"] == "pending"
        assert db.users.docs[0]["balance_xof"] == 3980

    asyncio.run(scenario())
