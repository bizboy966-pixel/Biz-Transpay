"""Small provider-only tests; no MongoDB or network is required."""
import hashlib
import asyncio
import sys
from pathlib import Path

import pytest
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paydunya


def test_fee_snapshot_client_and_merchant():
    operator = {
        "gateway_fee_pct": 2, "gateway_fee_fixed": 10,
        "platform_fee_pct": 1, "platform_fee_fixed": 5,
    }
    client = paydunya.calculate_fees(1000, operator, "client")
    assert client["charged_amount"] == 1045
    assert client["wallet_credit_amount"] == 1000
    merchant = paydunya.calculate_fees(1000, operator, "receiver")
    assert merchant["charged_amount"] == 1000
    assert merchant["total_fee"] == 45


def test_modes_and_hosted_url_are_safe_defaults():
    modes = paydunya.default_modes()
    assert modes["softpay_direct"]["enabled"] is True
    assert modes["psr"]["enabled"] is False
    assert modes["par_redirect"]["enabled"] is False
    assert paydunya.checkout_url(
        {"response": {"response_text": "created https://app.paydunya.com/checkout/tok"}}
    ) == "https://app.paydunya.com/checkout/tok"
    assert all(op["currency"] in {"XOF", "XAF"}
               for op in paydunya.default_catalog())


def test_xof_fees_are_whole_units():
    result = paydunya.calculate_fees(
        1001, {"currency": "XOF", "gateway_fee_pct": 1.5}, "client")
    assert result["gateway_fee"] == 15
    assert result["charged_amount"] == 1016
    legacy = paydunya.calculate_fees(
        1000, {"currency": "XOF", "fee_pct": 1.5}, "client")
    assert legacy["total_fee"] == 15


def test_empty_session_secret_is_rejected():
    with pytest.raises(paydunya.PayDunyaError):
        paydunya.derive_fernet_key("")


def test_togo_phone_and_static_hash():
    assert paydunya.normalize_togo_phone("+228 90 12 34 56") == "90123456"
    master = "test-master"
    digest = hashlib.sha512(master.encode()).hexdigest()
    assert paydunya.verify_static_hash(digest, master)
    assert not paydunya.verify_static_hash("bad", master)


def test_confirmation_rejects_amount_and_accepts_completed():
    master = "test-master"
    token = "invoice-token"
    payload = {
        "response_code": "00", "status": "completed", "token": token,
        "amount": 1000, "currency": "XOF",
        "hash": hashlib.sha512(master.encode()).hexdigest(),
    }
    assert paydunya.confirmation_valid(
        payload, master_key=master, token=token, amount=1000, currency="XOF")
    assert not paydunya.confirmation_valid(
        {**payload, "amount": 999}, master_key=master, token=token,
        amount=1000, currency="XOF")


def test_confirmation_uses_signed_custom_currency_and_legacy_xof_identity():
    master = "test-master"
    digest = hashlib.sha512(master.encode()).hexdigest()
    base = {
        "response_code": "00", "status": "completed", "hash": digest,
        "invoice": {"token": "invoice-token", "total_amount": 500},
    }
    signed = {
        **base,
        "custom_data": {
            "biztranspay_token": "deposit-id",
            "biztranspay_currency": "XOF",
            "biztranspay_amount": "500",
        },
    }
    assert paydunya.confirmation_valid(
        signed, master_key=master, token="invoice-token", amount=500,
        currency="XOF", deposit_id="deposit-id")
    assert not paydunya.confirmation_valid(
        signed, master_key=master, token="invoice-token", amount=500,
        currency="XAF", deposit_id="deposit-id")
    legacy = {
        **base, "custom_data": {"biztranspay_token": "deposit-id"},
    }
    assert paydunya.confirmation_valid(
        legacy, master_key=master, token="invoice-token", amount=500,
        currency="XOF", deposit_id="deposit-id")
    assert not paydunya.confirmation_valid(
        legacy, master_key=master, token="invoice-token", amount=500,
        currency="XOF", deposit_id="another-deposit")


def test_togo_softpay_uses_documented_fields(monkeypatch):
    seen = {}

    async def fake_request(method, path, config, body=None):
        seen.update(method=method, path=path, body=body)
        return {"success": True}

    monkeypatch.setattr(paydunya, "_request", fake_request)
    asyncio.run(paydunya.softpay_payment(
        {"mode": "live"}, invoice_token="tok",
        operator={"endpoint_slug": "t-money-togo"}, phone="90123456",
        amount=1000, currency="XOF", customer_name="A Test",
        customer_email="a@example.com"))
    assert seen["path"] == "/api/v1/softpay/t-money-togo"
    assert seen["body"] == {
        "name_t_money": "A Test", "email_t_money": "a@example.com",
        "phone_t_money": "90123456", "payment_token": "tok",
    }


def test_sandbox_softpay_uses_fictitious_customer(monkeypatch):
    seen = {}

    async def fake_request(method, path, config, body=None):
        seen.update(method=method, path=path, body=body)
        return {"success": True}

    monkeypatch.setattr(paydunya, "_request", fake_request)
    asyncio.run(paydunya.softpay_payment(
        {
            "mode": "test",
            "_sandbox_customer": {
                "phone": "90000000",
                "email": "sandbox@example.com",
                "password": "not-a-real-password",
            },
        },
        invoice_token="tok",
        operator={"endpoint_slug": "t-money-togo"},
        phone="90123456",
        amount=1000,
        currency="XOF",
    ))
    assert seen["path"] == "/sandbox-api/v1/softpay/checkout/make-payment"
    assert seen["body"] == {
        "phone_phone": "90000000",
        "customer_email": "sandbox@example.com",
        "password": "not-a-real-password",
        "invoice_token": "tok",
    }


def test_provider_html_error_is_not_exposed(monkeypatch):
    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def request(self, *args, **kwargs):
            return httpx.Response(
                404,
                text="<html><body>large provider error page</body></html>",
                request=httpx.Request("POST", "https://app.paydunya.com/test"),
            )

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: FakeClient())
    with pytest.raises(paydunya.PayDunyaError) as exc:
        asyncio.run(paydunya._request(
            "POST",
            "/test",
            {
                "mode": "test",
                "_credentials": {
                    "master_key": "m",
                    "private_key": "p",
                    "token": "t",
                },
            },
            {},
        ))
    assert exc.value.message == "PayDunya returned HTTP 404"