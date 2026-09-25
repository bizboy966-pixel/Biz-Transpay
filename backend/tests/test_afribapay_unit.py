"""Provider-only AfribaPAY tests; no database or real network is used."""
import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import afribapay


def test_catalogue_contains_only_documented_routes():
    catalog = afribapay.default_catalog()
    assert {row["country"] for row in catalog} == set(afribapay.COUNTRY_LABELS)
    assert len(catalog) == 31
    assert len({(r["country"], r["operator"], r["currency"]) for r in catalog}) == len(catalog)
    assert all(row["min"] == 100 and row["max"] == 2_000_000 for row in catalog)
    assert len([r for r in catalog if r["country"] == "CD" and r["currency"] == "CDF"]) == 5
    assert {row["currency"] for row in catalog if row["country"] == "CD"} == {"CDF"}
    assert afribapay.provider_code("CD", "vodacom", "CDF") == "afribapay_vodacom_cd"
    try:
        afribapay.provider_code("CD", "vodacom", "USD")
        assert False, "USD is not an AfribaPAY-supported DRC currency"
    except ValueError:
        pass


def test_payment_flows():
    assert afribapay.payment_flow({"country": "CI", "operator": "wave"})["kind"] == "redirect"
    flow = afribapay.payment_flow({"country": "BF", "operator": "orange",
                                   "otp_required": True, "ussd_code": "*144*4*6*MONTANT#"}, 1250)
    assert flow["otp_required"] and flow["ussd_code"].endswith("1250#")
    assert afribapay.payment_flow({"country": "BF", "operator": "wligdicash",
                                   "otp_required": True})["kind"] == "wallet_otp"


def test_client_contract_and_token_cache(monkeypatch):
    calls = []
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def request(self, method, url, **kwargs):
            calls.append((method, url, kwargs))
            if url.endswith("/token"):
                return httpx.Response(200, json={"data": {"access_token": "token", "expires_in": 90000}},
                                      request=httpx.Request(method, url))
            return httpx.Response(200, json={"data": {"status": "PENDING", "provider_link": "https://pay.test"}},
                                  request=httpx.Request(method, url))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: FakeClient())
    async def run():
        client = afribapay.AfriPayClient("user", "key", "merchant")
        await client.payin(operator="wave", country="CI", phone_number="0700000000",
                           amount=100, currency="XOF", order_id="o1", merchant_key="merchant")
        result = await client.status(order_id="o1")
        return client, result
    client, result = asyncio.run(run())
    assert result["data"]["status"] == "PENDING"
    assert len([call for call in calls if call[1].endswith("/token")]) == 1
    assert calls[1][0:2] == ("POST", "https://api-sandbox.afribapay.com/v1/pay/payin")
    assert calls[1][2]["headers"]["Authorization"] == "Bearer token"


def test_payout_otp_and_status_endpoints(monkeypatch):
    seen = []
    async def fake_request(method, path, **kwargs):
        seen.append((method, path, kwargs))
        return {"data": {"status": "SUCCESS"}}
    client = afribapay.AfriPayClient("u", "k", "m")
    monkeypatch.setattr(client, "_request", fake_request)
    asyncio.run(client.request_otp(country="BF", operator="wligdicash", phone_number="70000000",
                                   amount=100, currency="XOF", merchant_key="m"))
    asyncio.run(client.payout(country="BJ", operator="mtn", phone_number="97000000",
                              amount=100, currency="XOF", order_id="p1", merchant_key="m"))
    asyncio.run(client.status(transaction_id="tx1"))
    assert [item[1] for item in seen] == ["/v1/pay/otp", "/v1/pay/payout", "/v1/status"]
    assert seen[1][2]["payout"] is True
    assert seen[2][2]["params"] == {"transaction_id": "tx1"}