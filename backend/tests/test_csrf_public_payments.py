"""Public payment-link boundary tests."""

import asyncio
import sys
from pathlib import Path

from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def _request(path: str) -> Request:
    return Request({
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [
            (b"host", b"biz-transppayy.com"),
            (b"origin", b"https://biz-transppayy.com"),
            (b"cookie", f"{server.SESSION_COOKIE_NAME}=existing-session".encode()),
        ],
        "query_string": b"",
    })


def test_public_mobile_money_link_payment_does_not_require_session_csrf():
    assert server._validate_csrf_request(
        _request("/api/links/pay/mobile-money")
    ) is None


def test_public_crypto_link_payment_does_not_require_session_csrf():
    assert server._validate_csrf_request(
        _request("/api/links/pay")
    ) is None


def test_public_payment_finalization_does_not_require_session_csrf():
    assert server._validate_csrf_request(
        _request("/api/links/payments/payment-1/mobile-money/finalize")
    ) is None


def test_authenticated_non_public_mutation_still_requires_csrf():
    failure = server._validate_csrf_request(_request("/api/transfers"))
    assert failure is not None
    assert failure.status_code == 403


def test_public_mobile_money_status_does_not_expose_provider_checkout_url():
    result = server._public_link_payment_status({
        "id": "payment-1",
        "method": "mobile_money",
        "status": "pending",
        "redirect_url": "https://provider.invalid/checkout",
        "checkout_url": "https://provider.invalid/invoice",
    })
    assert result["checkout_url"] is None
    assert result["redirect_url"] is None


def test_universal_link_resolves_operator_using_operator_currency(monkeypatch):
    async def value(payload):
        return payload

    monkeypatch.setattr(server, "get_paydunya_config", lambda: value({
        "enabled": True,
        "master_key_encrypted": "configured",
        "private_key_encrypted": "configured",
        "token_encrypted": "configured",
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "CM", "code": "mtn_cm", "currency": "XAF",
            "active": True,
        }],
    }))
    monkeypatch.setattr(server, "get_mbiyo_config", lambda: value({
        "enabled": False,
        "catalog": [],
    }))

    result = asyncio.run(server._resolve_deposit_provider(
        "CM", "mtn_cm", "UNIVERSAL", required_mode="softpay_direct"
    ))
    assert result == "paydunya"