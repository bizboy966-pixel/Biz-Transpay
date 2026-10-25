"""Offline admin balance routing tests. No real users or providers are mutated."""
import asyncio
import copy
from types import SimpleNamespace

import pytest
import server


def install(monkeypatch):
    user = {
        "id": "user-1", "username": "client", "balance_xof": 1000,
        "balance_xaf": 500, "balance_usdt": 99,
        server._crypto_wallet_field("USDT.BEP20"): 10,
        server._crypto_wallet_field("USDT.TRC20"): 20,
        server._crypto_wallet_field("BTC.BTC"): .001,
    }
    records, operations = [], {}

    async def find_one(query, projection=None):
        return copy.deepcopy(user) if query.get("id") == user["id"] else None

    async def assets():
        return {asset_id: {"coin": server._crypto_wallet_spec(asset_id=asset_id)["coin"]}
                for asset_id in ("USDT.BEP20", "USDT.TRC20", "BTC.BTC")}

    async def apply(uid, increments, op, direction, **kwargs):
        signature = (uid, increments, direction)
        if op in operations:
            return {"state": "already" if operations[op] == signature else "idempotency_conflict"}
        field = kwargs["primary_field"]
        if kwargs.get("required_balance_amount", 0) > user.get(field, 0):
            return {"state": "insufficient"}
        operations[op] = signature
        user[field] = user.get(field, 0) + increments[field]
        return {"state": "applied"}

    async def record(*args, **kwargs):
        records.append((args, kwargs))

    async def audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(
        users=SimpleNamespace(find_one=find_one)))
    monkeypatch.setattr(server, "_active_exchange_crypto_assets", assets)
    monkeypatch.setattr(server, "_apply_wallet_operation_once", apply)
    monkeypatch.setattr(server, "record_tx", record)
    monkeypatch.setattr(server, "audit", audit)
    return user, records


def action(currency="USDT", asset_id="USDT.BEP20", amount=5, action_id="action-123"):
    return server.AdminBalanceAction(
        currency=currency, asset_id=asset_id, amount=amount,
        confirmation="CONFIRMER", action_id=action_id)


ADMIN = {"id": "admin-1", "username": "admin"}


def test_admin_network_credit_is_exact_and_replay_safe(monkeypatch):
    user, records = install(monkeypatch)
    request = action()
    assert asyncio.run(server.admin_credit("user-1", request, ADMIN, "admin-1"))["applied"]
    assert not asyncio.run(server.admin_credit("user-1", request, ADMIN, "admin-1"))["applied"]
    assert user[server._crypto_wallet_field("USDT.BEP20")] == 15
    assert user[server._crypto_wallet_field("USDT.TRC20")] == 20
    assert user["balance_usdt"] == 99
    assert records[0][0][4] == "USDT.BEP20"
    assert records[0][1]["metadata"]["network"] == "BEP20"
    with pytest.raises(server.HTTPException) as exc:
        asyncio.run(server.admin_credit(
            "user-1", action(asset_id="USDT.TRC20"), ADMIN, "admin-1"))
    assert exc.value.status_code == 409
    assert user[server._crypto_wallet_field("USDT.TRC20")] == 20


@pytest.mark.parametrize("currency,asset,amount,field", [
    ("BTC", "BTC.BTC", .002, server._crypto_wallet_field("BTC.BTC")),
    ("XOF", None, 50, "balance_xof"), ("XAF", None, 50, "balance_xaf"),
    ("USDT", None, 3, "balance_usdt"), ("USD", None, 3, "balance_usdt"),
])
def test_other_assets_and_existing_admin_api_contract(monkeypatch, currency, asset, amount, field):
    user, _ = install(monkeypatch)
    before = user[field]
    asyncio.run(server.admin_credit("user-1", action(currency, asset, amount), ADMIN, "admin-1"))
    assert user[field] == pytest.approx(before + amount)


def test_admin_debit_checks_exact_wallet_funds(monkeypatch):
    user, _ = install(monkeypatch)
    with pytest.raises(server.HTTPException) as exc:
        asyncio.run(server.admin_debit("user-1", action(amount=11), ADMIN, "admin-1"))
    assert exc.value.status_code == 400
    assert user[server._crypto_wallet_field("USDT.BEP20")] == 10
    assert user["balance_usdt"] == 99
    asyncio.run(server.admin_debit("user-1", action(amount=4), ADMIN, "admin-1"))
    assert user[server._crypto_wallet_field("USDT.BEP20")] == 6


@pytest.mark.parametrize("currency,asset", [
    ("BTC", "USDT.BEP20"), ("USDT", "USDT.UNKNOWN"),
    ("BTC", None), ("balance_xof", None),
])
def test_invalid_currency_or_network_is_rejected(monkeypatch, currency, asset):
    user, records = install(monkeypatch)
    before = copy.deepcopy(user)
    with pytest.raises(server.HTTPException):
        asyncio.run(server.admin_credit("user-1", action(currency, asset), ADMIN, "admin-1"))
    assert user == before and records == []


def test_admin_wallet_catalog_separates_networks_and_legacy_balance(monkeypatch):
    install(monkeypatch)
    result = asyncio.run(server.admin_user_balance_wallets("user-1", ADMIN))
    wallets = {wallet["id"]: wallet for wallet in result["wallets"]}
    assert set(wallets) == {"XOF", "XAF", "USDT.BEP20", "USDT.TRC20", "BTC.BTC"}
    assert wallets["USDT.BEP20"]["balance"] == 10
    assert wallets["USDT.TRC20"]["balance"] == 20
    assert result["legacy_usdt_balance"] == 99


def test_balance_confirmation_is_still_required(monkeypatch):
    _, records = install(monkeypatch)
    request = action()
    request.confirmation = None
    with pytest.raises(server.HTTPException):
        asyncio.run(server.admin_credit("user-1", request, ADMIN, "admin-1"))
    assert records == []
