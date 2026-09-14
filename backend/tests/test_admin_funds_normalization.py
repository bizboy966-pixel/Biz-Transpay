"""Normalization tests for Mbiyo's live funds responses."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def test_documented_mbiyo_funds_shapes_are_sanitized_without_leakage():
    wallets = server._sanitize_mbiyo_wallets({
        "data": [{
            "id": "wallet-1",
            "currency_id": "internal-currency-id",
            "amount": "218909.17",
            "human_readable_amount": "2189.09",
            "currency": "XOF",
            "country": "Togo",
            "iso2": "TG",
            "topup": "active",
            "payout": "active",
            "local_swap": "disabled",
            "private_note": "must-not-leak",
        }],
    })
    assert wallets == [{
        "id": "wallet-1",
        "currency": "XOF",
        "country": "Togo",
        "country_code": "TG",
        "balance": "2189.09",
        "raw_amount": "218909.17",
        "topup": True,
        "payout": True,
        "local_swap": False,
    }]

    networks = server._sanitize_mbiyo_networks({
        "status": "success",
        "data": [{
            "network": "togocom",
            "country_code": "TG",
            "currency": "XOF",
            "balance": "500.00",
        }],
    })
    assert networks[0]["network"] == "togocom"
    assert networks[0]["operator"] == "TMoney"
    assert networks[0]["label"] == "TMoney"
    assert networks[0]["balance"] == "500.00"


def test_wallet_totals_use_decimal_and_group_only_by_currency():
    totals = server._mbiyo_wallet_totals({
        "data": [
            {"currency": "XOF", "amount": "0.10", "country": "Togo"},
            {"currency": "XOF", "amount": "0.20", "country": "Bénin"},
            {"currency": "XAF", "amount": "50", "country": "Cameroun"},
        ],
    })
    assert totals == [
        {"currency": "XAF", "balance": "50"},
        {"currency": "XOF", "balance": "0.30"},
    ]


@pytest.mark.parametrize(
    "normalizer,payload",
    [
        (server._sanitize_mbiyo_wallets, {"data": {"currency": "XOF"}}),
        (server._sanitize_mbiyo_networks, {"data": [{"currency": "XOF"}]}),
        (server._sanitize_mbiyo_wallets, {"data": [{
            "id": "wallet-1", "currency": "XOF",
            "human_readable_amount": {"nested": "secret"},
        }]}),
        (server._sanitize_mbiyo_wallets, {"data": [{
            "id": "wallet-1", "currency": "XOF",
            "human_readable_amount": "10", "amount": [],
        }]}),
        (server._sanitize_mbiyo_networks, {"data": [{
            "network": "togocom", "country_code": "TG",
            "currency": "XOF", "balance": "Infinity",
        }]}),
        (server._mbiyo_wallet_totals, {"data": [{"currency": "XOF", "amount": "NaN"}]}),
    ],
)
def test_unknown_or_malformed_financial_shapes_are_rejected(normalizer, payload):
    with pytest.raises(ValueError):
        normalizer(payload)