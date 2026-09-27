import asyncio
import sys
from pathlib import Path

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