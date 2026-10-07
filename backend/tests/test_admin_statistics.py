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
