import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from starlette.requests import Request

import server


def test_admin_statistics_aggregates_operations_and_keeps_currencies_separate():
    end = datetime(2026, 10, 7, 12, tzinfo=timezone.utc)
    start = end - timedelta(days=7)
    rows = [
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": 500,
            "currency": "XOF", "country_code": "TG",
            "created_at": (end - timedelta(hours=2)).isoformat(),
        }},
        {"transaction_document": {
            "type": "transfer", "direction": "out",
            "metadata": {"transfer_type": "biz_to_mobile", "country": "CI"},
            "status": "completed", "amount": 80, "currency": "XOF",
            "created_at": (end - timedelta(hours=1)).isoformat(),
        }},
        {"transaction_document": {
            "type": "exchange", "status": "pending", "amount": 25,
            "currency": "GHS",
            "created_at": (end - timedelta(minutes=30)).isoformat(),
        }},
        {"transaction_document": {
            "type": "deposit", "status": "failed", "amount": 200,
            "currency": "XOF", "country_code": "BJ",
            "created_at": (end - timedelta(minutes=20)).isoformat(),
        }},
        {"transaction_document": {
            "type": "transfer", "direction": "out",
            "metadata": {"transfer_type": "biz_to_biz"},
            "status": "completed", "amount": 100, "currency": "XOF",
            "created_at": (end - timedelta(minutes=10)).isoformat(),
        }},
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": 999,
            "currency": "XOF",
            "created_at": (start - timedelta(seconds=1)).isoformat(),
        }},
    ]

    result = server._aggregate_admin_statistics(rows, "7d", start, end)

    assert result["summary"]["transaction_count"] == 4
    assert result["summary"]["operations"]["deposits"]["count"] == 2
    assert result["summary"]["operations"]["withdrawals"]["count"] == 1
    assert result["summary"]["operations"]["exchanges"]["count"] == 1
    assert result["summary"]["volume_by_currency"] == [{
        "currency": "XOF",
        "total": 580.0,
        "deposits": 500.0,
        "withdrawals": 80.0,
        "exchanges": 0.0,
    }]
    assert [country["country_code"] for country in result["countries"]] == [
        "BJ", "CI", "TG", "XX",
    ]
    assert next(
        country for country in result["countries"]
        if country["country_code"] == "BJ"
    )["volume_by_currency"] == []
    assert result["timeline"][-1]["transaction_count"] == 4
    assert Decimal(str(result["timeline"][-1]["volume_by_currency"][0]["total"])) \
        == Decimal("580.0")


def test_admin_statistics_provider_totals_identify_missing_providers():
    routes = {"TG": {"mbiyo": {"XOF"}, "afribapay": {"XOF"}}}
    records = {
        "mbiyo": [{
            "country_code": "TG", "country": "Togo", "currency": "XOF",
            "balance": "700",
        }],
        "afribapay": [],
    }

    result = server._build_admin_statistics_provider_liquidity(
        routes, records, "2026-10-07T12:00:00+00:00")

    assert len(result) == 1
    assert result[0]["country"] == "Togo"
    assert result[0]["totals_by_currency"] == [
        {"currency": "XOF", "balance": 700.0},
    ]
    assert result[0]["providers"] == [{
        "provider": "Mbiyo", "currency": "XOF", "balance": 700.0,
        "approximate": False,
    }]
    assert result[0]["missing_providers"] == ["AfribaPay"]
    assert result[0]["complete"] is False


def test_paydunya_country_balance_parser_preserves_country_and_marks_estimates():
    balances = server._paydunya_country_balances({
        "success": True, "Balance TG": "1250.25 XOF",
        "Balance BJ": "749.75 XOF",
    })

    assert [
        (row["country_code"], row["currency"], row["balance"],
         row["approximate"])
        for row in balances
    ] == [
        ("TG", "XOF", Decimal("1250.25"), True),
        ("BJ", "XOF", Decimal("749.75"), True),
    ]


def test_statistics_route_requires_finance_read_permission():
    def build_request(path):
        return Request({
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "query_string": b"period=30d",
            "root_path": "",
            "headers": [],
            "server": ("test", 443),
            "client": ("test", 1),
        })

    assert server._admin_permission_for_request(
        build_request("/api/admin/statistics")) == "finance:read"
    assert server._admin_permission_for_request(
        build_request("/api/admin/statistics/provider-liquidity")) \
        == "finance:read"


def test_statistics_history_endpoint_never_waits_on_live_provider_reads(
        monkeypatch):
    async def empty_history(_start, _end):
        return []

    async def unexpected_provider_read():
        raise AssertionError("provider reads must use the independent route")

    monkeypatch.setattr(
        server, "_admin_statistics_transaction_rows", empty_history)
    monkeypatch.setattr(
        server, "_cached_admin_statistics_provider_liquidity",
        unexpected_provider_read)
    monkeypatch.setattr(
        server, "_ADMIN_STATISTICS_PROVIDER_CACHE",
        {"expires_at": 0.0, "snapshot": []},
    )

    result = asyncio.run(
        server.admin_statistics(period="24h", admin={"role": "admin"}))

    assert result["period"] == "24h"
    assert result["summary"]["transaction_count"] == 0
    assert result["provider_liquidity"] == []


def test_monthly_country_ranking_uses_transaction_count_and_xof_volume(
        monkeypatch):
    monkeypatch.setattr(server, "_ADMIN_STATISTICS_COUNTRY_LABELS_CACHE", {
        "TG": "Togo", "CI": "Côte d’Ivoire",
    })
    rows = [
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": 500,
            "currency": "XOF", "country_code": "TG",
        }},
        {"transaction_document": {
            "type": "transfer", "status": "completed", "amount": 100,
            "currency": "XAF", "country_code": "TG",
            "metadata": {"transfer_type": "biz_to_mobile"},
        }},
        {"transaction_document": {
            "type": "exchange", "status": "pending", "amount": 800,
            "currency": "XOF", "country_code": "TG",
        }},
        {"transaction_document": {
            "type": "payment", "status": "completed", "amount": 1,
            "currency": "USDT", "country_code": "CI",
        }},
        {"transaction_document": {
            "type": "deposit", "status": "failed", "amount": 999,
            "currency": "XOF", "country_code": "CI",
        }},
        {"transaction_document": {
            "type": "transfer", "direction": "in", "status": "completed",
            "amount": 200, "currency": "XOF", "country_code": "TG",
            "metadata": {"transfer_type": "biz_to_biz"},
        }},
    ]
    extra_country_codes = ["AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI"]
    rows.extend({
        "transaction_document": {
            "type": "deposit", "status": "pending", "amount": 1,
            "currency": "XOF", "country_code": extra_country_codes[index],
        },
    } for index in range(9))

    result = server._aggregate_admin_statistics_top_countries(
        rows,
        {"XAF_XOF": 1, "USDT_XOF": 600},
    )

    assert len(result) == 8
    assert result[0] == {
        "country_code": "TG",
        "country": "Togo",
        "transaction_count": 3,
        "volume_xof": 600.0,
        "unconverted_volume_by_currency": [],
    }
    assert result[1]["country_code"] == "CI"
    assert result[1]["transaction_count"] == 2
    assert result[1]["volume_xof"] == 600


def test_monthly_margins_are_split_by_operation_and_payment_channel():
    rows = [
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": 500,
            "currency": "XOF", "metadata": {"platform_fee": 15},
        }},
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": .01,
            "currency": "BTC.BTC",
            "metadata": {
                "coin": "BTC", "platform_fee": .01,
                "platform_fee_usdt": .5,
            },
        }},
        {"transaction_document": {
            "type": "withdrawal", "status": "completed", "amount": 100,
            "currency": "XAF", "metadata": {"platform_fee": 4},
        }},
        {"transaction_document": {
            "type": "transfer", "status": "completed", "amount": 100,
            "currency": "XOF",
            "metadata": {
                "transfer_type": "biz_to_mobile", "platform_fee": 5,
            },
        }},
        {"transaction_document": {
            "type": "transfer", "status": "completed", "amount": .5,
            "currency": "USDT",
            "metadata": {
                "transfer_type": "biz_to_crypto", "platform_fee": .3,
            },
        }},
        {"transaction_document": {
            "type": "link_payment", "status": "paid", "amount": 2,
            "currency": "USDT",
            "metadata": {"coin": "BTC", "platform_fee": .2},
        }},
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": 1,
            "currency": "XAF",
            "metadata": {
                "source": "link_payment", "platform_fee": 3,
            },
        }},
        {"transaction_document": {
            "type": "withdrawal", "status": "completed", "amount": .01,
            "currency": "ETH.ETH",
            "metadata": {
                "coin": "ETH", "platform_fee": .01,
                "platform_fee_usdt": .1,
            },
        }},
        {"transaction_document": {
            "type": "payment", "status": "completed", "amount": 200,
            "currency": "XOF", "metadata": {"platform_fee": 6},
        }},
        {"transaction_document": {
            "type": "payment", "status": "completed", "amount": 1,
            "currency": "USDT", "metadata": {"platform_fee": .4},
        }},
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": 100,
            "currency": "XOF",
            "metadata": {
                "integration_reference": "store-order-1",
                "platform_fee": 7,
            },
        }},
        {"transaction_document": {
            "type": "deposit", "status": "completed", "amount": .02,
            "currency": "ETH.ETH",
            "metadata": {
                "idempotency_key": "btpi_crypto-deposit",
                "coin": "ETH", "platform_fee": .02,
                "platform_fee_usdt": .8,
            },
        }},
        {"transaction_document": {
            "type": "exchange", "status": "completed", "amount": 1,
            "currency": "XAF", "metadata": {"platform_fee": 2},
        }},
        {"transaction_document": {
            "type": "deposit", "status": "failed", "amount": 500,
            "currency": "XOF", "metadata": {"platform_fee": 100},
        }},
    ]

    result = server._aggregate_admin_statistics_margins(rows)
    categories = result["categories"]

    assert categories["deposit_mobile_money"]["amounts"] == [
        {"currency": "XOF", "amount": 15.0},
    ]
    assert categories["deposit_crypto"]["amounts"] == [
        {"currency": "USDT", "amount": .5},
    ]
    assert "withdrawal_mobile_money" not in categories
    assert "withdrawal_crypto" not in categories
    assert categories["transfer_mobile_money"]["amounts"] == [
        {"currency": "XOF", "amount": 5.0},
    ]
    assert categories["transfer_crypto"]["amounts"] == [
        {"currency": "USDT", "amount": .3},
    ]
    assert categories["link_payment_crypto"]["amounts"] == [
        {"currency": "USDT", "amount": .2},
    ]
    assert categories["link_payment_mobile_money"]["amounts"] == [
        {"currency": "XAF", "amount": 3.0},
    ]
    assert categories["api_payment_mobile_money"]["amounts"] == [
        {"currency": "XOF", "amount": 13.0},
    ]
    assert categories["api_payment_crypto"]["amounts"] == [
        {"currency": "USDT", "amount": 1.2},
    ]
    assert categories["conversion"]["amounts"] == [
        {"currency": "XAF", "amount": 2.0},
    ]
    assert result["total_by_currency"] == [
        {"currency": "USDT", "amount": 2.2},
        {"currency": "XAF", "amount": 5.0},
        {"currency": "XOF", "amount": 33.0},
    ]


def test_api_tagged_mobile_money_deposit_is_counted_as_api_margin():
    result = server._aggregate_admin_statistics_margins([{
        "transaction_document": {
            "type": "deposit", "status": "completed", "amount": 500,
            "currency": "XOF",
            "metadata": {
                "payment_source": "integration_api",
                "platform_fee": 8,
            },
        },
    }])

    assert result["categories"]["api_payment_mobile_money"]["amounts"] == [
        {"currency": "XOF", "amount": 8.0},
    ]
    assert result["categories"]["deposit_mobile_money"]["amounts"] == []


def test_legacy_api_deposit_rows_are_reclassified_for_margin_statistics():
    rows = [
        {"transaction_document": {
            "id": "mbiyo-deposit-legacy-api",
            "type": "deposit", "status": "completed", "amount": 500,
            "currency": "XOF", "metadata": {"platform_fee": 6},
        }},
        {"transaction_document": {
            "id": "izipay-deposit-legacy-api",
            "type": "deposit", "status": "completed", "amount": .01,
            "currency": "ETH.ETH",
            "metadata": {
                "operation_id": "izipay:deposit:legacy-crypto-api",
                "platform_fee": .01, "platform_fee_usdt": .4,
            },
        }},
    ]

    server._mark_integration_api_statistics_rows(rows, {
        "transaction_ids": {"mbiyo-deposit-legacy-api"},
        "operation_ids": {"izipay:deposit:legacy-crypto-api"},
    })
    result = server._aggregate_admin_statistics_margins(rows)

    assert result["categories"]["api_payment_mobile_money"]["amounts"] == [
        {"currency": "XOF", "amount": 6.0},
    ]
    assert result["categories"]["api_payment_crypto"]["amounts"] == [
        {"currency": "USDT", "amount": .4},
    ]


def test_customer_wallet_totals_convert_fiat_and_crypto_to_xof():
    btc_field = server._crypto_wallet_field("BTC.BTC")
    totals = {
        "balance_xof": Decimal("10"),
        "balance_xaf": Decimal("20"),
        "balance_usdt": Decimal("1"),
        btc_field: Decimal("0.1"),
    }

    result = server._build_admin_statistics_wallet_balances(
        totals,
        {
            "conversion_rates": {"XAF_XOF": 0.5, "USDT_XOF": 600},
            "crypto_usdt_rates": {"BTC": 50000, "USDT": 1},
        },
        "2026-10-01T00:00:00+00:00",
    )

    assert result["total_xof_equivalent"] == 3000620
    assert result["crypto_xof_equivalent"] == 3000600
    assert result["conversion_complete"] is True
    assert {wallet["currency"]: wallet["xof_equivalent"]
            for wallet in result["wallets"]} == {
        "XOF": 10, "XAF": 10, "USDT": 600, "BTC.BTC": 3000000,
    }


def test_customer_wallet_totals_mark_unpriced_crypto_as_partial():
    eth_field = server._crypto_wallet_field("ETH.ETH")
    result = server._build_admin_statistics_wallet_balances(
        {"balance_xof": 100, eth_field: 1},
        {
            "conversion_rates": {"USDT_XOF": 600},
            "crypto_usdt_rates": {"USDT": 1},
        },
    )

    assert result["total_xof_equivalent"] == 100
    assert result["conversion_complete"] is False
    assert result["missing_rates"] == [{
        "currency": "ETH.ETH", "coin": "ETH", "network": "ETH",
    }]


def test_new_statistics_routes_require_finance_read_permission():
    def build_request(path):
        return Request({
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "server": ("test", 443),
            "client": ("test", 1),
        })

    assert server._admin_permission_for_request(
        build_request("/api/admin/statistics/dashboard")) == "finance:read"
    assert server._admin_permission_for_request(
        build_request("/api/admin/statistics/wallet-balances")) \
        == "finance:read"


def test_monthly_dashboard_route_returns_country_and_margin_sections(
        monkeypatch):
    async def transaction_rows(start, end):
        assert start.day == 1
        assert start <= end
        return [
            {"transaction_document": {
                "type": "deposit", "status": "completed", "amount": 500,
                "currency": "XOF", "country_code": "TG",
                "metadata": {"platform_fee": 5},
            }},
        ]

    async def platform_config():
        return {"conversion_rates": {"USDT_XOF": 600}}

    async def api_payment_markers(**_kwargs):
        return {"transaction_ids": set(), "operation_ids": set()}

    monkeypatch.setattr(
        server, "_admin_statistics_transaction_rows", transaction_rows)
    monkeypatch.setattr(server, "get_platform_config", platform_config)
    monkeypatch.setattr(
        server, "_integration_api_payment_ledger_markers", api_payment_markers)

    result = asyncio.run(
        server.admin_statistics_dashboard(admin={"role": "admin"}))

    assert result["period"] == "month"
    assert result["top_countries"][0]["country_code"] == "TG"
    assert result["top_countries"][0]["volume_xof"] == 500
    assert result["margins"]["categories"]["deposit_mobile_money"]["amounts"] \
        == [{"currency": "XOF", "amount": 5.0}]
