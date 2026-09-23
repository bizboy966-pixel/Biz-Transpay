"""CSRF boundary tests for anonymous payment-link mutations."""

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