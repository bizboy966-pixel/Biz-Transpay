"""Contract tests for crypto operations in the separate integration API."""
import hashlib
import inspect
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402
from test_integration_api import (  # noqa: E402
    Collection, DB, ctx, req, route, run,
)
from integration_api import create_router  # noqa: E402


DEPOSIT = {
    "amount": 2.5,
    "asset_code": "USDT.TRC20",
    "full_name": "Crypto Buyer",
    "email": "buyer@example.com",
    "refund_address": "TRefundAddress123",
    "reference": "crypto-deposit-ref",
}
PAYOUT = {
    "amount": 1.25,
    "asset_code": "USDT.TRC20",
    "wallet_address": "TWalletAddress123",
    "destination_memo": "memo-1",
    "fee_bearer": "sender",
    "reference": "crypto-payout-ref",
    "description": "Treasury payout",
}


def _credential(user_id="merchant-1", environment="live", scopes=None,
                payout_opt_in=True, kyc_status="verified"):
    result = {
        "user_id": user_id,
        "environment": environment,
        "scopes": list(scopes or ["deposits:write", "payouts:write"]),
        "user": {"id": user_id, "kyc_status": kyc_status},
    }
    if payout_opt_in is not None:
        result["payout_opt_in"] = payout_opt_in
    return result


def _body(endpoint, values):
    body_type = inspect.signature(endpoint).parameters["body"].annotation
    return body_type(**values)


def _router(db, **overrides):
    # Keep crypto business handlers fake: tests exercise the integration claim
    # and routing contract without contacting the configured provider.
    if not hasattr(db, "crypto_deposits"):
        db.crypto_deposits = Collection()

    async def get_crypto_deposit(deposit_id, uid):
        return await db.crypto_deposits.find_one(
            {"id": deposit_id, "user_id": uid})

    async def get_crypto_payout(payout_id, uid):
        return await db.transactions.find_one(
            {"id": payout_id, "user_id": uid})

    defaults = {
        "get_app_features": _crypto_features,
        "crypto_assets": _active_deposit_assets,
        "public_crypto_coins": _payout_coins,
        "CryptoDepositRequest": server.CryptoDepositRequest,
        "_crypto_wallet_spec": _wallet_spec,
        "get_crypto_deposit": get_crypto_deposit,
        "get_crypto_payout": get_crypto_payout,
    }
    defaults.update(overrides)
    return create_router(ctx(db, **defaults))


async def _crypto_features():
    return {
        "wallet_crypto_enabled": True,
        "deposit_crypto_enabled": True,
        "withdrawal_crypto_enabled": True,
    }


async def _active_deposit_assets():
    return [{
        "asset_code": "USDT.TRC20", "coin": "USDT", "network": "TRC20",
        "network_name": "TRON", "minimum": 1, "maximum": 1000,
        "memo_required": False, "fee_pct": 1.5, "fee_fixed": 0,
        "provider_private": "must-not-leak",
    }]


async def _payout_coins(uid):
    return [{
        "coin": "USDT",
        "networks": [{
            "asset_code": "USDT.TRC20", "code": "TRC20", "name": "TRON",
            "min": 1, "max": 1000, "memo_required": False,
            "balance": 42, "fee_pct": 1.5, "fee_fixed": 0,
        }],
    }]


def _wallet_spec(asset_code=None, coin=None, network=None):
    if asset_code is not None and asset_code.upper() != "USDT.TRC20":
        return None
    if coin is not None and (coin.upper(), network.upper()) != ("USDT", "TRC20"):
        return None
    return {
        "id": "USDT.TRC20", "coin": "USDT", "network_code": "TRC20",
    }


def _collection(db, name):
    if not hasattr(db, name):
        setattr(db, name, Collection())
    return getattr(db, name)


def test_crypto_assets_are_active_sanitized_and_direction_aware():
    db = DB()
    endpoint = route(_router(db),
                     "/v1/crypto/assets", "GET")
    deposit_assets = run(endpoint(direction="deposit", credential=_credential()))
    payout_assets = run(endpoint(direction="payout", credential=_credential()))

    assert [asset["asset_code"] for asset in deposit_assets] == ["USDT.TRC20"]
    assert "provider_private" not in deposit_assets[0]
    assert [asset["asset_code"] for asset in payout_assets] == ["USDT.TRC20"]
    assert payout_assets[0]["balance"] == 42


@pytest.mark.parametrize(
    "path,method,body,credential",
    [
        ("/v1/crypto/deposits", "POST", DEPOSIT,
         _credential(environment="test", scopes=["deposits:write"])),
        ("/v1/crypto/payouts", "POST", PAYOUT,
         _credential(environment="test", scopes=["payouts:write"])),
    ],
)
def test_test_environment_rejects_crypto_writes_before_claim_or_handler(
        path, method, body, credential):
    db = DB()
    calls = []

    async def handler(*args, **kwargs):
        calls.append((args, kwargs))
        return {"id": "provider-operation", "status": "pending"}

    endpoint = route(_router(
        db, create_crypto_deposit=handler, crypto_deposit=handler,
        transfer=handler,
    ), path, method)
    with pytest.raises(HTTPException) as exc:
        run(endpoint(_body(endpoint, body), req({"Idempotency-Key": "crypto-test-key"}),
                     credential))

    assert exc.value.status_code == 503
    assert calls == []
    assert db.integration_operations.docs == []
    assert db.integration_idempotency.docs == []


@pytest.mark.parametrize(
    "path,body,scope,handler_name",
    [
        ("/v1/crypto/deposits", DEPOSIT, "deposits:write",
         "create_crypto_deposit"),
        ("/v1/crypto/payouts", PAYOUT, "payouts:write", "transfer"),
    ],
)
def test_crypto_amount_precision_rejected_before_claim(path, body, scope,
                                                        handler_name):
    db = DB()
    calls = []

    async def handler(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("invalid precision must fail before business handler")

    endpoint = route(_router(db, **{handler_name: handler}), path, "POST")
    invalid_body = _body(endpoint, {**body, "amount": 1.0000001})

    with pytest.raises(HTTPException) as exc:
        run(endpoint(
            invalid_body, req({"Idempotency-Key": f"precision-{scope}"}),
            _credential(scopes=[scope]),
        ))

    assert exc.value.status_code == 400
    assert calls == []
    assert db.integration_idempotency.docs == []
    assert db.integration_operations.docs == []


@pytest.mark.parametrize(
    "path,body,feature,handler_name",
    [
        ("/v1/crypto/deposits", DEPOSIT, "deposit_crypto_enabled",
         "create_crypto_deposit"),
        ("/v1/crypto/payouts", PAYOUT, "withdrawal_crypto_enabled",
         "transfer"),
    ],
)
def test_explicitly_disabled_crypto_feature_rejects_before_claim(
        path, body, feature, handler_name):
    db = DB()
    calls = []

    async def features():
        return {
            "wallet_crypto_enabled": True,
            "deposit_crypto_enabled": feature != "deposit_crypto_enabled",
            "withdrawal_crypto_enabled": feature != "withdrawal_crypto_enabled",
        }

    async def handler(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("disabled crypto must fail before handler")

    endpoint = route(_router(
        db, get_app_features=features, **{handler_name: handler},
    ), path, "POST")
    scope = "deposits:write" if path.endswith("deposits") else "payouts:write"
    with pytest.raises(HTTPException) as exc:
        run(endpoint(
            _body(endpoint, body),
            req({"Idempotency-Key": f"disabled-{feature}"}),
            _credential(scopes=[scope]),
        ))

    assert exc.value.status_code == 403
    assert calls == []
    assert db.integration_idempotency.docs == []
    assert db.integration_operations.docs == []


@pytest.mark.parametrize("path,body,kind", [
    ("/v1/crypto/deposits", DEPOSIT, "deposit"),
    ("/v1/crypto/payouts", PAYOUT, "payout"),
])
def test_crypto_idempotency_replays_and_rejects_changed_payload(path, body, kind):
    db = DB()
    calls = []

    async def deposit_handler(model, *args, **kwargs):
        calls.append(model)
        return {
            "id": "crypto-deposit-1", "status": "pending",
            "deposit_address": "TDepositAddress",
        }

    async def payout_handler(model, *args, **kwargs):
        calls.append(model)
        return {
            "transaction": {"id": "crypto-payout-1", "status": "pending"},
            "fee": 0.01, "total_debit": model.amount + 0.01,
        }

    endpoint = route(_router(
        db, create_crypto_deposit=deposit_handler,
        crypto_deposit=deposit_handler, transfer=payout_handler,
    ), path, "POST")
    key = f"crypto-{kind}-idem-1"
    credential = _credential()
    first = run(endpoint(_body(endpoint, body),
                         req({"Idempotency-Key": key}), credential))
    replay = run(endpoint(_body(endpoint, body),
                          req({"Idempotency-Key": key}), credential))

    assert replay == first
    assert len(calls) == 1
    assert len(db.integration_idempotency.docs) == 1

    changed = {**body, "amount": body["amount"] + 1}
    with pytest.raises(HTTPException) as exc:
        run(endpoint(_body(endpoint, changed),
                     req({"Idempotency-Key": key}), credential))
    assert exc.value.status_code == 409
    assert len(calls) == 1


def test_crypto_payout_requires_opt_in_as_well_as_scope():
    db = DB()
    calls = []

    async def transfer(*args, **kwargs):
        calls.append(args)
        return {"transaction": {"id": "must-not-run", "status": "pending"}}

    endpoint = route(_router(db, transfer=transfer),
                     "/v1/crypto/payouts", "POST")
    with pytest.raises(HTTPException) as exc:
        run(endpoint(
            _body(endpoint, PAYOUT),
            req({"Idempotency-Key": "crypto-payout-opt-in"}),
            _credential(scopes=["payouts:write"], payout_opt_in=False),
        ))
    assert exc.value.status_code == 403
    assert calls == []
    assert db.integration_idempotency.docs == []


def test_crypto_payout_rejects_unverified_kyc_before_idempotency_claim():
    db = DB()
    calls = []

    async def transfer(*args, **kwargs):
        calls.append(args)
        return {"transaction": {"id": "must-not-run", "status": "pending"}}

    endpoint = route(_router(db, transfer=transfer),
                     "/v1/crypto/payouts", "POST")
    with pytest.raises(HTTPException) as exc:
        run(endpoint(
            _body(endpoint, PAYOUT),
            req({"Idempotency-Key": "crypto-payout-unverified"}),
            _credential(kyc_status="rejected"),
        ))

    assert exc.value.status_code == 403
    assert exc.value.detail == server.OUTGOING_KYC_REQUIRED_DETAIL
    assert calls == []
    assert db.integration_operations.docs == []
    assert db.integration_idempotency.docs == []


def test_crypto_payout_maps_exact_asset_and_network_to_transfer_request():
    db = DB()
    seen = []

    async def transfer(model, request, uid):
        seen.append((model, request, uid))
        return {"transaction": {"id": "crypto-payout-1", "status": "pending"}}

    endpoint = route(_router(db, transfer=transfer),
                     "/v1/crypto/payouts", "POST")
    request = req({"Idempotency-Key": "crypto-payout-map-1"})
    result = run(endpoint(_body(endpoint, PAYOUT), request, _credential()))
    model, passed_request, uid = seen[0]

    assert result["id"] == "crypto-payout-1"
    assert uid == "merchant-1"
    assert passed_request is request
    assert isinstance(model, server.TransferRequest)
    assert model.transfer_type == "biz_to_crypto"
    assert model.crypto == "USDT"
    assert model.network == "TRC20"
    assert model.asset_code == "USDT.TRC20"
    assert model.wallet_address == PAYOUT["wallet_address"]
    assert model.destination_memo == PAYOUT["destination_memo"]
    assert model.amount == PAYOUT["amount"]
    assert model.fee_bearer == PAYOUT["fee_bearer"]


def test_crypto_idempotency_isolated_by_owner_and_environment():
    db = DB()
    calls = []

    async def deposit_handler(model, *args, **kwargs):
        calls.append(model)
        return {"id": f"deposit-{len(calls)}", "status": "pending"}

    endpoint = route(_router(
        db, create_crypto_deposit=deposit_handler,
        crypto_deposit=deposit_handler,
    ), "/v1/crypto/deposits", "POST")
    body = _body(endpoint, DEPOSIT)
    key = "shared-crypto-key"
    results = []
    for credential in (
        _credential("merchant-1", "live", ["deposits:write"]),
        _credential("merchant-2", "live", ["deposits:write"]),
        _credential("merchant-1", "live", ["deposits:write"]),
    ):
        results.append(run(endpoint(
            body, req({"Idempotency-Key": key}), credential)))

    assert results[0] == results[2]
    assert results[1] != results[0]
    assert len(calls) == 2
    assert len(db.integration_idempotency.docs) == 2
    assert {(doc["user_id"], doc["environment"])
            for doc in db.integration_idempotency.docs} == {
                ("merchant-1", "live"), ("merchant-2", "live")}


def test_crypto_status_reads_are_owner_environment_scoped_and_emit_transition():
    db = DB(integration_operations=Collection([{
        "id": "claim-1:crypto_deposit", "user_id": "merchant-1",
        "environment": "live", "kind": "crypto_deposit",
        "business_id": "crypto-deposit-1", "status": "pending",
    }]))
    _collection(db, "crypto_deposits").docs.append({
        "id": "crypto-deposit-1", "user_id": "merchant-1",
        "status": "confirmed", "asset_code": "USDT.TRC20",
    })
    router = _router(db)
    endpoint = route(router, "/v1/crypto/deposits/{deposit_id}", "GET")
    list_endpoint = route(router, "/v1/crypto/deposits", "GET")
    result = run(endpoint("crypto-deposit-1", _credential()))

    assert result["status"] == "confirmed"
    assert db.integration_operations.docs[0]["status"] == "confirmed"
    assert len(db.integration_webhook_events.docs) == 1
    assert run(list_endpoint(limit=100, credential=_credential())) == [
        db.integration_operations.docs[0],
    ]
    assert run(list_endpoint(
        limit=100, credential=_credential("other-owner", "live"))) == []

    with pytest.raises(HTTPException) as exc:
        run(endpoint("crypto-deposit-1",
                     _credential("other-owner", "live")))
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        run(endpoint("crypto-deposit-1",
                     _credential("merchant-1", "test")))
    assert exc.value.status_code == 404


def test_crypto_pending_to_confirmed_transition_is_deduplicated():
    db = DB(integration_operations=Collection([{
        "id": "claim-2:crypto_deposit", "user_id": "merchant-1",
        "environment": "live", "kind": "crypto_deposit",
        "business_id": "crypto-deposit-2", "status": "pending",
    }]))
    deposit = {
        "id": "crypto-deposit-2", "user_id": "merchant-1", "status": "pending",
    }
    _collection(db, "crypto_deposits").docs.append(deposit)
    endpoint = route(_router(db), "/v1/crypto/deposits/{deposit_id}", "GET")
    credential = _credential()

    run(endpoint("crypto-deposit-2", credential))
    deposit["status"] = "confirmed"
    run(endpoint("crypto-deposit-2", credential))
    run(endpoint("crypto-deposit-2", credential))

    assert db.integration_operations.docs[0]["status"] == "confirmed"
    assert len(db.integration_webhook_events.docs) == 1
    assert db.integration_webhook_events.docs[0]["event_type"] == "crypto_deposit.success"


def test_crypto_payout_get_and_list_are_scoped_by_owner_and_environment():
    db = DB(integration_operations=Collection([
        {
            "id": "op-live-payout", "user_id": "merchant-1",
            "environment": "live", "kind": "crypto_payout",
            "business_id": "crypto-payout-live", "status": "pending",
        },
        {
            "id": "op-test-payout", "user_id": "merchant-1",
            "environment": "test", "kind": "crypto_payout",
            "business_id": "crypto-payout-test", "status": "pending",
        },
        {
            "id": "op-other-payout", "user_id": "merchant-2",
            "environment": "live", "kind": "crypto_payout",
            "business_id": "crypto-payout-other", "status": "pending",
        },
    ]))
    db.transactions.docs.append({
        "id": "crypto-payout-live", "user_id": "merchant-1",
        "status": "pending", "amount": PAYOUT["amount"], "currency": "USDT",
        "counterparty": PAYOUT["wallet_address"],
        "metadata": {
            "transfer_type": "biz_to_crypto", "crypto": "USDT",
            "network": "TRC20", "asset_code": "USDT.TRC20",
            "wallet_address": PAYOUT["wallet_address"],
            "private_provider_payload": "never-return",
        },
    })
    get_endpoint = route(
        _router(db), "/v1/crypto/payouts/{payout_id}", "GET")
    list_endpoint = route(
        _router(db), "/v1/crypto/payouts", "GET")
    credential = _credential()

    result = run(get_endpoint("crypto-payout-live", credential))
    listed = run(list_endpoint(limit=100, credential=credential))

    assert result["asset_code"] == "USDT.TRC20"
    assert "private_provider_payload" not in result
    assert [operation["business_id"] for operation in listed] == [
        "crypto-payout-live",
    ]
    for other_credential in (
            _credential("merchant-2", "live"),
            _credential("merchant-1", "test")):
        assert run(list_endpoint(limit=100, credential=other_credential)) == [
            operation for operation in db.integration_operations.docs
            if operation["user_id"] == other_credential["user_id"]
            and operation["environment"] == other_credential["environment"]
            and operation["kind"] == "crypto_payout"
        ]
        with pytest.raises(HTTPException) as exc:
            run(get_endpoint("crypto-payout-live", other_credential))
        assert exc.value.status_code == 404


def test_crypto_payout_accepts_active_provider_asset_alias():
    db = DB()
    calls = []
    alias = "USDT.TRON-ALIAS"

    async def public_coins(uid):
        return [{
            "coin": "USDT",
            "networks": [{
                "asset_code": alias, "code": "TRC20", "name": "TRON",
                "min": 1, "max": 1000, "memo_required": False,
                "balance": 42, "fee_pct": 1.5, "fee_fixed": 0,
            }],
        }]

    async def transfer(model, request, uid):
        calls.append((model, request, uid))
        return {"transaction": {"id": "alias-payout", "status": "pending"}}

    endpoint = route(_router(
        db, public_crypto_coins=public_coins, transfer=transfer,
    ), "/v1/crypto/payouts", "POST")
    body = _body(endpoint, {**PAYOUT, "asset_code": alias})
    result = run(endpoint(
        body, req({"Idempotency-Key": "crypto-alias-payout-1"}),
        _credential(scopes=["payouts:write"]),
    ))

    model = calls[0][0]
    assert result["id"] == "alias-payout"
    assert model.transfer_type == "biz_to_crypto"
    assert model.crypto == "USDT"
    assert model.network == "TRC20"
    assert model.asset_code == alias
    assert model.currency == "USDT"


def test_crypto_receiver_fee_rejects_net_with_excess_precision_before_claim():
    db = DB()
    fee_calls = []
    payout = {**PAYOUT, "amount": 1.234567, "fee_bearer": "receiver"}

    async def fee_components(coin, amount, asset_id=None):
        fee_calls.append((coin, amount, asset_id))
        return {"fee": 0.0000001}

    endpoint = route(_router(
        db, _crypto_withdrawal_fee_components=fee_components,
    ), "/v1/crypto/payouts", "POST")
    with pytest.raises(HTTPException) as exc:
        run(endpoint(
            _body(endpoint, payout),
            req({"Idempotency-Key": "receiver-net-precision"}),
            _credential(scopes=["payouts:write"]),
        ))

    assert exc.value.status_code == 400
    assert fee_calls == [("USDT", 1.234567, "USDT.TRC20")]
    assert db.integration_idempotency.docs == []
    assert db.integration_operations.docs == []


def test_confirmed_deposit_claim_queues_success_webhook():
    db = DB()
    calls = []
    deposit_doc = {
        "id": "confirmed-crypto-deposit", "user_id": "merchant-1",
        "status": "confirmed", "amount": DEPOSIT["amount"],
        "asset_code": DEPOSIT["asset_code"], "coin": "USDT",
        "network": "TRC20", "deposit_address": "TDepositAddress",
        "deposit_secret": "never-expose",
    }

    async def create_crypto_deposit(model, uid):
        calls.append((model, uid))
        db.crypto_deposits.docs.append(dict(deposit_doc))
        return dict(deposit_doc)

    endpoint = route(_router(db, create_crypto_deposit=create_crypto_deposit),
                     "/v1/crypto/deposits", "POST")
    result = run(endpoint(
        _body(endpoint, DEPOSIT),
        req({"Idempotency-Key": "crypto-confirmed-webhook"}),
        _credential(scopes=["deposits:write"]),
    ))

    assert result["status"] == "confirmed"
    assert "deposit_secret" not in result["deposit"]
    assert len(calls) == 1
    assert len(db.integration_webhook_events.docs) == 1
    event = db.integration_webhook_events.docs[0]
    assert event["event_type"] == "crypto_deposit.success"
    assert event["data"] == {
        "id": "confirmed-crypto-deposit", "status": "confirmed",
    }


def test_recovery_uses_persisted_crypto_deposit_without_resubmitting():
    db = DB()
    calls = []

    async def create_crypto_deposit(*args):
        calls.append(args)
        raise AssertionError("persisted operation must be recovered")

    endpoint = route(_router(db, create_crypto_deposit=create_crypto_deposit),
                     "/v1/crypto/deposits", "POST")
    body = _body(endpoint, DEPOSIT)
    credential = _credential(scopes=["deposits:write"])
    key = "crypto-deposit-recover"
    _seed_recoverable_claim(db, body.model_dump(mode="json"), credential, key,
                            "crypto_deposit")
    claim_id = hashlib.sha256(
        f"{credential['user_id']}:{credential['environment']}:{key}".encode()
    ).hexdigest()
    db.crypto_deposits.docs.append({
        "id": "recovered-crypto-deposit", "user_id": credential["user_id"],
        "idempotency_key": f"btpi_{claim_id[:64]}",
        "status": "pending", "amount": DEPOSIT["amount"],
        "asset_code": DEPOSIT["asset_code"], "coin": "USDT",
        "network": "TRC20", "deposit_address": "TRecoveredAddress",
        "amount_to_send": DEPOSIT["amount"],
    })

    response = run(endpoint(body, req({"Idempotency-Key": key}), credential))

    assert response["id"] == "recovered-crypto-deposit"
    assert response["deposit"]["deposit_address"] == "TRecoveredAddress"
    assert calls == []
    assert len(db.integration_operations.docs) == 1
    assert db.integration_operations.docs[0]["kind"] == "crypto_deposit"


@pytest.mark.parametrize("status", ["provider_unknown", "creating"])
def test_5xx_crypto_deposit_recovers_local_pending_row_and_remains_discoverable(status):
    db = DB()
    calls = []

    async def create_crypto_deposit(model, uid):
        calls.append((model, uid))
        db.crypto_deposits.docs.append({
            "id": f"uncertain-{status}", "user_id": uid,
            "idempotency_key": model.idempotency_key, "status": status,
            "amount": model.amount, "asset_code": model.asset_code,
            "coin": "USDT", "network": "TRC20",
            "deposit_address": None,
        })
        raise HTTPException(502, "provider outcome unknown")

    router = _router(db, create_crypto_deposit=create_crypto_deposit)
    endpoint = route(router, "/v1/crypto/deposits", "POST")
    get_endpoint = route(router, "/v1/crypto/deposits/{deposit_id}", "GET")
    credential = _credential(scopes=["deposits:write"])
    key = f"deposit-provider-unknown-{status}"
    request = req({"Idempotency-Key": key})

    first = run(endpoint(_body(endpoint, DEPOSIT), request, credential))
    replay = run(endpoint(_body(endpoint, DEPOSIT), request, credential))
    by_id = run(get_endpoint(first["id"], credential))

    assert first["id"] == f"uncertain-{status}"
    assert first["status"] == status
    assert first["deposit"]["pending_manual"] is True
    assert first["deposit"]["deposit_address"] is None
    assert replay == first
    assert by_id["id"] == first["id"]
    assert by_id["status"] == status
    assert by_id["pending_manual"] is True
    assert len(calls) == 1
    assert db.integration_operations.docs[0]["reference"] == DEPOSIT["reference"]


def test_recovery_uses_persisted_crypto_payout_without_resubmitting():
    db = DB()
    calls = []

    async def transfer(*args):
        calls.append(args)
        raise AssertionError("persisted operation must be recovered")

    endpoint = route(_router(db, transfer=transfer),
                     "/v1/crypto/payouts", "POST")
    body = _body(endpoint, PAYOUT)
    credential = _credential(scopes=["payouts:write"], payout_opt_in=True)
    key = "crypto-payout-recover"
    _seed_recoverable_claim(db, body.model_dump(mode="json"), credential, key,
                            "crypto_payout")
    claim_id = hashlib.sha256(
        f"{credential['user_id']}:{credential['environment']}:{key}".encode()
    ).hexdigest()
    db.transactions.docs.append({
        "id": "recovered-crypto-payout", "user_id": credential["user_id"],
        "status": "pending", "amount": PAYOUT["amount"], "currency": "USDT",
        "counterparty": PAYOUT["wallet_address"],
        "metadata": {
            "idempotency_key": f"btpi_{claim_id[:64]}",
            "transfer_type": "biz_to_crypto", "crypto": "USDT",
            "network": "TRC20", "asset_code": PAYOUT["asset_code"],
            "wallet_address": PAYOUT["wallet_address"],
        },
    })

    response = run(endpoint(body, req({"Idempotency-Key": key}), credential))

    assert response["id"] == "recovered-crypto-payout"
    assert response["payout"]["asset_code"] == "USDT.TRC20"
    assert calls == []
    assert len(db.integration_operations.docs) == 1
    assert db.integration_operations.docs[0]["kind"] == "crypto_payout"


def _seed_recoverable_claim(db, payload, credential, key, action):
    claim_id = hashlib.sha256(
        f"{credential['user_id']}:{credential['environment']}:{key}".encode()
    ).hexdigest()
    fingerprint = hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":"), default=str,
    ).encode()).hexdigest()
    db.integration_idempotency.docs.append({
        "id": claim_id, "user_id": credential["user_id"],
        "environment": credential["environment"], "action": action,
        "fingerprint": fingerprint, "response": None,
    })


def test_existing_mobile_money_payout_route_remains_mobile_money():
    db = DB()
    seen = []

    async def transfer(model, request, uid):
        seen.append(model)
        return {"transaction": {"id": "mobile-payout", "status": "pending"}}

    endpoint = route(_router(db, transfer=transfer), "/v1/payouts", "POST")
    body = _body(endpoint, {
        "amount": 1000, "currency": "XOF", "country": "TG",
        "operator": "tmoney_tg", "recipient": "90000000",
    })
    run(endpoint(body, req({"Idempotency-Key": "mobile-payout-unchanged"}),
                 _credential(scopes=["payouts:write"])))

    assert seen[0].transfer_type == "biz_to_mobile"
    assert seen[0].crypto is None
    assert seen[0].network is None