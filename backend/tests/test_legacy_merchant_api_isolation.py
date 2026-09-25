"""Route isolation for the retired legacy merchant developer API."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def test_legacy_merchant_api_routes_are_not_registered():
    paths = set(server.app.openapi()["paths"])

    assert not any(
        path == "/api/v1" or path.startswith("/api/v1/")
        for path in paths
    )
    assert not any(
        path == "/api/api-keys" or path.startswith("/api/api-keys/")
        for path in paths
    )
    assert not any(
        path == "/api/merchant/keys"
        or path.startswith("/api/merchant/keys/")
        or path == "/api/merchant/webhooks"
        or path.startswith("/api/merchant/webhooks/")
        for path in paths
    )
    assert not any(
        path == "/api/documentation"
        or path.startswith("/api/documentation/")
        for path in paths
    )
    assert "/api/documentation.pdf" not in paths
    assert not any(
        path == "/api/admin/api-keys"
        or path.startswith("/api/admin/api-keys/")
        for path in paths
    )


def test_integration_and_browser_payment_routes_remain_registered():
    paths = set(server.app.openapi()["paths"])

    assert "/api/integration/v1/deposits" in paths
    assert "/api/integration/documentation" in paths
    assert "/api/deposits/crypto" in paths
    assert "/api/transfers" in paths
    assert "/api/transactions" in paths
    assert "/api/admin/logs" in paths