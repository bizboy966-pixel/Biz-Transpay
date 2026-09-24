"""Regression tests for the anonymous, provider-neutral developer docs."""

import asyncio
import sys
from functools import wraps
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def run_async(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return wrapper


@run_async
async def test_public_docs_catalog_separates_eligibility_and_live_routes(monkeypatch):
    async def value(payload):
        return payload

    paydunya_config = {
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {
            "softpay_direct": {"enabled": True},
            "psr": {"enabled": True},
            "par_redirect": {"enabled": True},
        },
        "catalog": [{
            "country": "TG", "country_label": "Togo",
            "code": "tmoney_tg", "name": "T-Money",
            "currency": "XOF", "min": 100, "max": 500000,
            "active": True,
        }],
    }
    mbiyo_operator = {
        "country": "GH", "country_label": "Ghana",
        "code": "mbiyo_mtn_gh", "network": "mtn",
        "name": "MTN Mobile Money", "currency": "GHS",
        "min": 0.01, "max": 0, "active": True,
    }
    mbiyo_config = {
        "enabled": True,
        "secret_key_encrypted": "configured",
        "catalog": [mbiyo_operator],
    }
    transfer_config = {
        "mobile_money": {
            "enabled": True,
            "operators": [{
                "country": "TG", "country_label": "Togo",
                "code": "t-money-togo", "withdraw_mode": "t-money-togo",
                "name": "T-Money", "currency": "XOF",
                "min": 100, "max": 500000, "active": True,
            }],
        },
        "paydunya": {"enabled": True},
        "mbiyo": {"enabled": True, "operators": [mbiyo_operator]},
    }

    monkeypatch.setattr(server, "get_paydunya_config",
                        lambda: value(paydunya_config))
    monkeypatch.setattr(server, "get_mbiyo_config",
                        lambda: value(mbiyo_config))
    monkeypatch.setattr(server, "get_transfer_config",
                        lambda: value(transfer_config))

    catalog = await server._public_documentation_catalog_data()

    assert catalog["payin"]["eligible"]
    assert catalog["payin"]["available"]
    assert catalog["payout"]["eligible"]
    assert catalog["payout"]["available"]
    assert any(country["country"] == "CD"
               for country in catalog["payin"]["eligible"])
    assert {country["country"] for country in catalog["payin"]["available"]} == {
        "GH", "TG",
    }
    assert {country["country"] for country in catalog["payout"]["available"]} == {
        "GH", "TG",
    }
    for direction in ("payin", "payout"):
        for status in ("eligible", "available"):
            for country in catalog[direction][status]:
                for route in country["routes"]:
                    assert "provider" not in route
                    assert "secret" not in route
                    assert "fee_pct" not in route
                    assert route["operator_code"]
                    assert route["currency"]


@run_async
async def test_public_pdf_is_generated_without_a_session(monkeypatch):
    empty_catalog = {
        "payin": {"eligible": [], "available": []},
        "payout": {"eligible": [], "available": []},
    }
    monkeypatch.setattr(server, "_public_documentation_catalog_data",
                        lambda: asyncio.sleep(0, result=empty_catalog))

    response = await server.download_api_docs_pdf()

    assert response.media_type == "application/pdf"
    assert response.body.startswith(b"%PDF-")
    routes = {
        route.path: route for route in server.api.routes
        if getattr(route, "path", None) in {
            "/api/documentation.pdf", "/api/documentation/catalog",
        }
    }
    assert set(routes) == {
        "/api/documentation.pdf", "/api/documentation/catalog",
    }
    for route in routes.values():
        assert not any(
            dependency.call is server.get_current_user_id
            for dependency in route.dependant.dependencies
        )