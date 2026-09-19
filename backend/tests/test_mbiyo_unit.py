"""Provider-only Mbiyo tests; no database or external network required."""
import asyncio
import hashlib
import hmac
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mbiyo


def test_catalog_matches_documented_countries_and_provider_prefixed():
    catalog = mbiyo.default_catalog()
    assert {row["country"] for row in catalog} == {
        "BF", "BJ", "CI", "CM", "CG", "ML", "SN", "TG", "CD", "GM",
        "GN", "UG", "TZ", "KE", "RW", "GH", "NG", "ZA", "ZM", "EG",
    }
    assert {row["currency"] for row in catalog} == {
        "XOF", "XAF", "CDF", "USD", "GMD", "GNF", "UGX", "TZS", "KES",
        "RWF", "GHS", "NGN", "ZAR", "ZMW", "EGP",
    }
    assert len({row["id"] for row in catalog}) == len(catalog)
    assert len({row["code"] for row in catalog}) == len(catalog)
    assert all(row["code"].startswith("mbiyo_") for row in catalog)
    by_key = {(r["country"], r["network"], r["currency"]): r for r in catalog}
    assert by_key[("CD", "vodacom", "CDF")]["min"] == 40
    assert by_key[("CD", "vodacom", "USD")]["max"] == 2500
    assert by_key[("GH", "mtn", "GHS")]["max"] == 0


def test_documented_ussd_and_post_init_flows():
    assert mbiyo.payment_flow({"country": "GN", "network": "orange"})["ussd_code"] == "#144#"
    qmoney = mbiyo.payment_flow({"country": "GM", "network": "qmoney"})
    assert qmoney["before_submit"] is False
    assert qmoney["otp_required"] is True
    assert mbiyo.payment_flow({"country": "BF", "network": "orange"}, 1234)["ussd_code"] == "*144*4*6*1234#"


def test_credentials_encrypt_round_trip():
    encrypted = mbiyo.encrypt_secret("merchant-secret", "session-secret")
    assert encrypted != "merchant-secret"
    assert mbiyo.decrypt_secret(encrypted, "session-secret") == "merchant-secret"


def test_webhook_signature_accepts_documented_hmac():
    raw = b'{"transaction_id":"TX-1","status":"successful"}'
    signature = hmac.new(b"webhook-secret", raw, hashlib.sha256).hexdigest()
    assert mbiyo.verify_signature(raw, signature, "webhook-secret")
    assert mbiyo.verify_signature(raw, f"sha256={signature}", "webhook-secret")
    assert not mbiyo.verify_signature(raw + b" ", signature, "webhook-secret")


def test_client_sends_bearer_and_exact_nested_payload(monkeypatch):
    calls = []

    class Response:
        status_code = 200
        text = ""
        def json(self):
            return {"status": "success", "data": {
                "transaction_id": "TX-1", "status": "pending"}}

    class FakeClient:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return None
        async def request(self, method, url, **kwargs):
            calls.append((method, url, kwargs))
            return Response()

    monkeypatch.setattr(mbiyo.httpx, "AsyncClient", FakeClient)
    payload = {
        "amount": 1000, "currency": "XOF",
        "payment_method": "mobile_money", "order_id": "ORDER-1",
        "callback_url": "https://merchant.test/api/webhooks/mbiyo",
        "metadata": {"network": "moov", "phone_number": "90123456",
                     "country_code": "TG"},
    }
    result = asyncio.run(mbiyo.MbiyoClient("secret-key").payin(**payload))
    assert mbiyo.status_value(result) == "pending"
    method, url, request = calls[0]
    assert method == "POST"
    assert url == f"{mbiyo.BASE_URL}/merchant/payin"
    assert request["headers"]["Authorization"] == "Bearer secret-key"
    assert request["json"] == payload


def test_balance_read_methods_use_documented_paths_and_omit_empty_filters(monkeypatch):
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"data": []}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def request(self, method, url, **kwargs):
            calls.append((method, url, kwargs))
            return Response()

    monkeypatch.setattr(mbiyo.httpx, "AsyncClient", FakeClient)
    client = mbiyo.MbiyoClient("secret-key", "https://mbiyo.test/api")
    asyncio.run(client.wallets())
    asyncio.run(client.balances(currency="XOF"))
    asyncio.run(client.network_balances(currency="", country_code="TG"))

    assert [call[:2] for call in calls] == [
        ("GET", "https://mbiyo.test/api/wallets"),
        ("GET", "https://mbiyo.test/api/balances"),
        ("GET", "https://mbiyo.test/api/balance/networks"),
    ]
    assert "params" not in calls[0][2]
    assert calls[1][2]["params"] == {"currency": "XOF"}
    assert calls[2][2]["params"] == {"country_code": "TG"}
