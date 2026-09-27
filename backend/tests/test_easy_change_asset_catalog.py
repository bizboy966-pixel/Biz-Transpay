import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import izipay
import server


def _provider_asset(spec, asset_code=None, **overrides):
    asset = {
        "assetCode": asset_code or spec["id"],
        "coinCode": spec["coin"],
        "network": spec["network_aliases"][0],
        "isActive": True,
    }
    asset.update(overrides)
    return asset


def test_catalog_is_limited_to_the_16_requested_assets():
    assert len(server.EASY_CHANGE_ASSET_SPECS) == 16
    provider_assets = [
        _provider_asset(spec) for spec in server.EASY_CHANGE_ASSET_SPECS
    ]
    provider_assets.extend([
        {"assetCode": "USDT.DOGE", "coinCode": "USDT", "network": "DOGE",
         "isActive": True},
        {"assetCode": "DOGE.DOGE", "coinCode": "DOGE", "network": "DOGE",
         "isActive": True},
    ])

    catalog = server._easypay_catalog_map(provider_assets)

    assert set(catalog) == {
        "USDC.POLYGON", "USDC.SOL", "USDC.BEP20", "USDC.ERC20",
        "USDT.POLYGON", "USDT.BEP20", "USDT.SOL", "USDT.TRC20",
        "USDT.TON", "USDT.ERC20", "BNB.BNB", "BTC.BTC", "SOL.SOL",
        "TON.TON", "TRX.TRX", "ETH.ETH",
    }


def test_provider_codes_resolve_by_coin_and_network_not_display_ticker():
    provider_asset = {
        "assetCode": "USDT.TRX",
        "coinCode": "USDT",
        "network": "TRX",
        "isActive": True,
    }

    spec = server._easypay_provider_asset_spec(provider_asset)
    resolved_spec, resolved_asset = server._easypay_resolve_asset(
        [provider_asset], coin="USDT", network="TRC20")

    assert spec["id"] == "USDT.TRC20"
    assert resolved_spec == spec
    assert resolved_asset == provider_asset
    assert server._easypay_provider_asset_spec({
        "assetCode": "USDT", "coinCode": "USDT", "isActive": True,
    }) is None


def test_native_provider_code_without_network_suffix_is_supported():
    provider_asset = {"assetCode": "BTC", "coinCode": "BTC", "isActive": True}

    spec, asset = server._easypay_resolve_asset(
        [provider_asset], asset_code="BTC")

    assert spec["id"] == "BTC.BTC"
    assert asset == provider_asset


def test_asset_fee_overrides_and_activation_are_scoped_by_catalog_id():
    section = {
        "fees": {"USDT": 4, "USDT.TRC20": 2.5},
        "fees_gateway": {"USDT": 3, "USDT.TRC20": 1.5},
        "fees_platform": {"USDT": 1, "USDT.TRC20": 1},
        "fees_gateway_fixed": {"USDT": 0.2, "USDT.TRC20": 0.03},
        "disabled_assets": ["USDT.TRC20"],
    }
    spec = server._EASY_CHANGE_ASSET_BY_ID["USDT.TRC20"]

    assert server._crypto_fee_split_pct(section, "USDT", spec["id"]) == (1.5, 1.0)
    assert server._easypay_fixed_fee(section, "fees_gateway_fixed", spec) == 0.03
    assert not server._easypay_asset_enabled(section, spec)
    assert server._crypto_fee_split_pct(section, "USDT") == (3.0, 1.0)


def test_wallet_fields_are_network_scoped_and_leave_legacy_usdt_unassigned():
    trc20 = server._crypto_wallet_field("USDT.TRC20")
    bep20 = server._crypto_wallet_field("USDT.BEP20")
    assert trc20 != bep20
    assert "." not in trc20 and "." not in bep20

    user = {
        "balance_usdt": 91.5,
        trc20: 2.25,
        bep20: 7.0,
    }
    public_wallets = {
        wallet["id"]: wallet for wallet in server._public_crypto_wallets(user)
    }
    balances = server._crypto_wallet_balances(user)

    assert user["balance_usdt"] == 91.5
    assert public_wallets["USDT.TRC20"]["balance"] == 2.25
    assert public_wallets["USDT.BEP20"]["balance"] == 7.0
    assert balances["USDT.TRC20"] == 2.25
    assert balances["USDT.BEP20"] == 7.0
    assert server._transaction_wallet_field("USDT", {}) == "balance_usdt"
    assert server._transaction_wallet_field(
        "USDT.TRC20", {"catalog_asset_id": "USDT.TRC20"}) == trc20
    assert server._transaction_wallet_field(
        "USDT.UNKNOWN", {"catalog_asset_id": "USDT.UNKNOWN"}) is None


def test_exchange_cross_rates_resolve_crypto_network_wallets(monkeypatch):
    assets = {
        "BTC.BTC": {
            "code": "BTC.BTC", "coin": "BTC", "network": "BTC",
            "wallet_field": server._crypto_wallet_field("BTC.BTC"),
            "usdt_rate": 50000.0,
        },
        "BNB.BNB": {
            "code": "BNB.BNB", "coin": "BNB", "network": "BNB",
            "wallet_field": server._crypto_wallet_field("BNB.BNB"),
            "usdt_rate": 500.0,
        },
    }

    async def active_assets():
        return assets

    monkeypatch.setattr(server, "_active_exchange_crypto_assets", active_assets)
    cfg = {
        "conversion_rates": {"USDT_XOF": 0.0015},
        "conversion_pairs_enabled": {},
    }

    bnb_to_btc = asyncio.run(server._exchange_rate_context(
        cfg, "BNB.BNB", "BTC.BTC"))
    btc_to_xof = asyncio.run(server._exchange_rate_context(
        cfg, "BTC.BTC", "XOF"))

    assert bnb_to_btc["rate"] == 0.01
    assert bnb_to_btc["from"]["wallet_field"] == assets["BNB.BNB"]["wallet_field"]
    assert bnb_to_btc["to"]["wallet_field"] == assets["BTC.BTC"]["wallet_field"]
    assert btc_to_xof["rate"] == 75.0


def test_exchange_catalog_returns_only_active_network_wallets(monkeypatch):
    assets = {
        "BTC.BTC": {
            "code": "BTC.BTC", "coin": "BTC", "network": "BTC",
            "network_name": "Bitcoin", "wallet_field": server._crypto_wallet_field("BTC.BTC"),
            "usdt_rate": 50000.0,
        },
        "USDT.TRC20": {
            "code": "USDT.TRC20", "coin": "USDT", "network": "TRC20",
            "network_name": "Tron", "wallet_field": server._crypto_wallet_field("USDT.TRC20"),
            "usdt_rate": 1.0,
        },
    }

    async def active_assets():
        return assets

    async def user_by_id(user_id):
        assert user_id == "user-1"
        return {
            server._crypto_wallet_field("BTC.BTC"): 0.25,
            server._crypto_wallet_field("USDT.TRC20"): 8.0,
            "balance_usdt": 900.0,
        }

    monkeypatch.setattr(server, "_active_exchange_crypto_assets", active_assets)
    monkeypatch.setattr(server, "get_user", user_by_id)

    catalog = asyncio.run(server.public_conversion_crypto_wallets("user-1"))

    assert [wallet["id"] for wallet in catalog] == ["BTC.BTC", "USDT.TRC20"]
    assert [wallet["balance"] for wallet in catalog] == [0.25, 8.0]
    assert all("wallet_field" not in wallet for wallet in catalog)
    assert all(wallet["id"] != "USDT" for wallet in catalog)


def test_exchange_rejects_unassigned_legacy_usdt():
    with pytest.raises(server.HTTPException) as exc:
        asyncio.run(server._exchange_rate_context(
            {"conversion_rates": {"USDT_XOF": 600}},
            "USDT",
            "XOF",
        ))

    assert exc.value.status_code == 400


def test_payout_sends_destination_memo_fee_bearer_and_idempotency(monkeypatch):
    captured = {}

    async def fake_post(path, body, idempotency_key=None):
        captured.update({
            "path": path,
            "body": body,
            "idempotency_key": idempotency_key,
        })
        return {"id": "payout-1"}

    monkeypatch.setattr(izipay, "_post", fake_post)
    result = asyncio.run(izipay.create_payout(
        amount="1.250000",
        destination_address="T" + "1" * 33,
        merchant_reference="tx-test",
        asset_code="USDT.TRC20",
        destination_memo="account-42",
        fee_bearer="merchant",
        idempotency_key="crypto-transfer-test",
    ))

    assert result["id"] == "payout-1"
    assert captured["path"] == "/v1/payouts"
    assert captured["body"]["assetCode"] == "USDT.TRC20"
    assert captured["body"]["destinationMemo"] == "account-42"
    assert captured["body"]["feeBearer"] == "merchant"
    assert captured["idempotency_key"] == "crypto-transfer-test"