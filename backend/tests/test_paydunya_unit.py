"""Small provider-only tests; no MongoDB or network is required."""
import hashlib
import asyncio
import sys
from pathlib import Path

import pytest
import httpx
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paydunya
import server
from models import TransferRequest


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
    assert merchant["wallet_credit_amount"] == 955


def test_legacy_fixed_fee_matches_public_preview_semantics():
    fees = paydunya.calculate_fees(
        1000,
        {"currency": "XOF", "fee_pct": 0, "fee_fixed": 25},
        "client",
    )
    assert fees["gateway_fee"] == 25
    assert fees["platform_fee"] == 0
    assert fees["total_fee"] == 25
    assert fees["charged_amount"] == 1025


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


def test_withdrawal_catalog_has_documented_modes_and_togo_defaults():
    catalog = paydunya.default_withdrawal_catalog()
    assert {op["withdraw_mode"] for op in catalog} == {
        "orange-money-senegal", "free-money-senegal", "wave-senegal",
        "mtn-benin", "moov-benin", "celtiis-cash", "mtn-ci",
        "orange-money-ci", "moov-ci", "wave-ci", "t-money-togo",
        "moov-togo", "orange-money-mali", "orange-money-burkina",
        "moov-burkina-faso", "mtn-cameroun",
    }
    assert all(op["active"] is (op["country"] == "TG") for op in catalog)


def test_disbursement_client_calls_v2_endpoints(monkeypatch):
    calls = []

    async def fake_request(method, path, config, body=None):
        calls.append((method, path, body))
        return {"response_code": "00", "disburse_token": "invoice-token"} if path.endswith("get-invoice") else {
            "response_code": "00", "id": "provider-id", "status": "pending"
        }

    monkeypatch.setattr(paydunya, "_request", fake_request)
    config = {"mode": "test"}
    asyncio.run(paydunya.get_disbursement_invoice(
        config, amount=1000, currency="XOF",
        withdraw_mode="t-money-togo", account_alias="90123456",
        callback_url="https://merchant.test/callback", reference="BTP-1"))
    asyncio.run(paydunya.submit_disbursement_invoice(
        config, invoice_token="invoice-token",
        withdraw_mode="t-money-togo", account_alias="90123456",
        amount=1000, currency="XOF", reference="BTP-1"))
    asyncio.run(paydunya.check_disbursement_status(
        config, invoice_token="invoice-token"))
    assert [call[1] for call in calls] == [
        "/api/v2/disburse/get-invoice",
        "/api/v2/disburse/submit-invoice",
        "/api/v2/disburse/check-status",
    ]
    assert calls[0][2] == {
        "account_alias": "90123456", "amount": 1000,
        "withdraw_mode": "t-money-togo",
        "callback_url": "https://merchant.test/callback",
    }
    assert calls[1][2] == {
        "disburse_invoice": "invoice-token", "disburse_id": "BTP-1",
    }
    assert calls[2][2] == {"disburse_invoice": "invoice-token"}
    assert paydunya.disbursement_token({"disburse_token": "invoice-token"}) == "invoice-token"


def test_disbursement_phone_is_sent_without_country_code():
    assert paydunya.normalize_disbursement_account_alias(
        "+228 90 12 34 56", "TG") == "90123456"
    assert paydunya.normalize_disbursement_account_alias(
        "00221 77 111 22 33", "SN") == "771112233"


def test_disbursement_business_error_is_not_reported_as_missing_token(monkeypatch):
    async def fake_request(method, path, config, body=None):
        return {
            "response_code": "4002",
            "response_text": "the callback is not accessible",
        }

    monkeypatch.setattr(paydunya, "_request", fake_request)
    with pytest.raises(paydunya.PayDunyaError) as exc:
        asyncio.run(paydunya.get_disbursement_invoice(
            {}, amount=1000, currency="XOF",
            withdraw_mode="t-money-togo", account_alias="90123456",
            callback_url="https://merchant.test/callback"))
    assert "application publiée" in exc.value.message


def test_callback_base_uses_public_request_host_when_domain_is_unset(monkeypatch):
    monkeypatch.delenv("OFFICIAL_DOMAIN", raising=False)
    monkeypatch.delenv("REPLIT_DEV_DOMAIN", raising=False)
    request = Request({
        "type": "http",
        "scheme": "https",
        "server": ("biz-transppayy.com", 443),
        "path": "/api/transfers",
        "query_string": b"",
        "headers": [(b"host", b"biz-transppayy.com")],
    })

    assert server._paydunya_callback_base(request) == "https://biz-transppayy.com"


def test_transfer_request_preserves_provider_metadata():
    request = TransferRequest(
        transfer_type="biz_to_mobile",
        recipient="90123456",
        country="TG",
        operator="t-money-togo",
        amount=1000,
        currency="XOF",
        idempotency_key="withdrawal-test",
        metadata={
            "source": "merchant_api",
            "merchant_reference": "merchant-ref",
        },
    )
    assert request.metadata == {
        "source": "merchant_api",
        "merchant_reference": "merchant-ref",
    }


def test_xof_fees_are_whole_units():
    result = paydunya.calculate_fees(
        1001, {"currency": "XOF", "gateway_fee_pct": 1.5}, "client")
    assert result["gateway_fee"] == 15
    assert result["charged_amount"] == 1016
    legacy = paydunya.calculate_fees(
        1000, {"currency": "XOF", "fee_pct": 1.5}, "client")
    assert legacy["total_fee"] == 15


def test_merchant_fees_cannot_consume_the_entire_deposit():
    with pytest.raises(paydunya.PayDunyaError):
        paydunya.calculate_fees(
            100, {"currency": "XOF", "gateway_fee_fixed": 100}, "merchant")


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


def test_confirmation_accepts_provider_response_without_custom_data():
    master = "test-master"
    digest = hashlib.sha512(master.encode()).hexdigest()
    response = {
        "response_code": "00",
        "status": "completed",
        "token": "invoice-token",
        "amount": 500,
        "hash": digest,
    }
    assert paydunya.confirmation_valid(
        response,
        master_key=master,
        token="invoice-token",
        amount=500,
        currency="XOF",
        deposit_id="deposit-id",
    )


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


@pytest.mark.parametrize(("slug", "country", "expected"), [
    ("orange-money-ci", "CI", {
        "orange_money_ci_customer_fullname": "A Test",
        "orange_money_ci_email": "a@example.com",
        "orange_money_ci_phone_number": "0700000000",
        "orange_money_ci_otp": "123456", "payment_token": "tok",
    }),
    ("orange-money-burkina", "BF", {
        "name_bf": "A Test", "email_bf": "a@example.com",
        "phone_bf": "0700000000", "otp_code": "123456",
        "payment_token": "tok",
    }),
    ("new-orange-money-senegal", "SN", {
        "customer_name": "A Test", "customer_email": "a@example.com",
        "phone_number": "0700000000", "invoice_token": "tok",
    }),
    ("free-money-senegal", "SN", {
        "customer_name": "A Test", "customer_email": "a@example.com",
        "phone_number": "0700000000", "payment_token": "tok",
    }),
    ("expresso-senegal", "SN", {
        "expresso_sn_fullName": "A Test", "expresso_sn_email": "a@example.com",
        "expresso_sn_phone": "0700000000", "payment_token": "tok",
    }),
    ("wave-senegal", "SN", {
        "wave_senegal_fullName": "A Test", "wave_senegal_email": "a@example.com",
        "wave_senegal_phone": "0700000000", "wave_senegal_payment_token": "tok",
    }),
    ("wizall-money-senegal", "SN", {
        "customer_name": "A Test", "customer_email": "a@example.com",
        "phone_number": "0700000000", "invoice_token": "tok",
    }),
    ("mtn-ci", "CI", {
        "mtn_ci_customer_fullname": "A Test", "mtn_ci_email": "a@example.com",
        "mtn_ci_phone_number": "0700000000", "mtn_ci_wallet_provider": "MTNCI",
        "payment_token": "tok",
    }),
    ("moov-ci", "CI", {
        "moov_ci_customer_fullname": "A Test", "moov_ci_email": "a@example.com",
        "moov_ci_phone_number": "0700000000", "payment_token": "tok",
    }),
    ("wave-ci", "CI", {
        "wave_ci_fullName": "A Test", "wave_ci_email": "a@example.com",
        "wave_ci_phone": "0700000000", "wave_ci_payment_token": "tok",
    }),
    ("moov-burkina", "BF", {
        "moov_burkina_faso_fullName": "A Test",
        "moov_burkina_faso_email": "a@example.com",
        "moov_burkina_faso_phone_number": "0700000000",
        "moov_burkina_faso_payment_token": "tok",
    }),
    ("moov-benin", "BJ", {
        "moov_benin_customer_fullname": "A Test",
        "moov_benin_email": "a@example.com",
        "moov_benin_phone_number": "0700000000", "payment_token": "tok",
    }),
    ("mtn-benin", "BJ", {
        "mtn_benin_customer_fullname": "A Test",
        "mtn_benin_email": "a@example.com",
        "mtn_benin_phone_number": "0700000000",
        "mtn_benin_wallet_provider": "MTNBENIN", "payment_token": "tok",
    }),
    ("celtiis-cash", "BJ", {
        "celtiis_cash_customer_fullname": "A Test",
        "celtiis_cash_customer_email": "a@example.com",
        "celtiis_cash_phone_number": "0700000000", "payment_token": "tok",
    }),
    ("orange-money-mali", "ML", {
        "orange_money_mali_customer_fullname": "A Test",
        "orange_money_mali_email": "a@example.com",
        "orange_money_mali_phone_number": "0700000000",
        "orange_money_mali_customer_address": "Mali", "payment_token": "tok",
    }),
    ("moov-mali", "ML", {
        "moov_ml_customer_fullname": "A Test", "moov_ml_email": "a@example.com",
        "moov_ml_phone_number": "0700000000",
        "moov_ml_customer_address": "Mali", "payment_token": "tok",
    }),
    ("mtn-cameroun", "CM", {
        "mtn_cameroun_customer_fullname": "A Test",
        "mtn_cameroun_email": "a@example.com",
        "mtn_cameroun_phone_number": "0700000000",
        "mtn_cameroun_wallet_provider": "MTNCAMEROUN", "payment_token": "tok",
    }),
    ("djamo", "CI", {
        "djamo_fullName": "A Test", "djamo_email": "a@example.com",
        "djamo_phone": "0700000000", "code_country": "ci",
        "djamo_payment_token": "tok",
    }),
])
def test_softpay_operator_contracts(monkeypatch, slug, country, expected):
    seen = {}

    async def fake_request(method, path, config, body=None):
        seen.update(method=method, path=path, body=body)
        return {"success": True}

    monkeypatch.setattr(paydunya, "_request", fake_request)
    asyncio.run(paydunya.softpay_payment(
        {"mode": "live"}, invoice_token="tok",
        operator={"endpoint_slug": slug, "country": country},
        phone="0700000000", amount=1000, currency="XOF",
        customer_name="A Test", customer_email="a@example.com",
        otp="123456",
    ))
    assert seen["path"] == f"/api/v1/softpay/{slug}"
    assert seen["body"] == expected


def test_orange_and_wizall_payment_flow_contracts():
    ci = paydunya.payment_flow({"endpoint_slug": "orange-money-ci"})
    assert ci["before_submit"] is True
    assert ci["otp_required"] is True
    assert ci["ussd_code"] == "#144*82#"

    bf = paydunya.payment_flow(
        {"endpoint_slug": "orange-money-burkina"}, amount=1250)
    assert bf["ussd_code"] == "*144*4*6*1250#"
    assert bf["ussd_template"] == "*144*4*6*{amount}#"

    wizall = paydunya.payment_flow(
        {"endpoint_slug": "wizall-money-senegal"})
    assert wizall["before_submit"] is False
    assert wizall["otp_required"] is True


def test_wizall_confirm_uses_documented_contract(monkeypatch):
    seen = {}

    async def fake_request(method, path, config, body=None):
        seen.update(method=method, path=path, body=body)
        return {"success": True}

    monkeypatch.setattr(paydunya, "_request", fake_request)
    asyncio.run(paydunya.wizall_confirm(
        {"mode": "live"}, authorization_code="461050",
        phone="771112233", transaction_id="286513913"))
    assert seen == {
        "method": "POST",
        "path": "/api/v1/softpay/wizall-money-senegal/confirm",
        "body": {
            "authorization_code": "461050",
            "phone_number": "771112233",
            "transaction_id": "286513913",
        },
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


def test_checkout_invoice_includes_all_redirect_actions(monkeypatch):
    seen = {}

    async def fake_request(method, path, config, body=None):
        seen.update(method=method, path=path, body=body)
        return {"response_code": "00", "token": "invoice-token"}

    monkeypatch.setattr(paydunya, "_request", fake_request)
    asyncio.run(paydunya.create_invoice(
        {"mode": "live", "store_name": "Biz-transPay"},
        amount=500, currency="XOF", token="deposit-id",
        customer={"firstname": "Test", "lastname": "Client"},
        callback_url="https://merchant.example/api/webhooks/paydunya",
        return_url="https://merchant.example/api/deposits/paydunya/return",
        cancel_url="https://merchant.example/dashboard/deposit?paydunya=cancelled",
    ))
    assert seen["body"]["actions"] == {
        "callback_url": "https://merchant.example/api/webhooks/paydunya",
        "return_url": "https://merchant.example/api/deposits/paydunya/return",
        "cancel_url": "https://merchant.example/dashboard/deposit?paydunya=cancelled",
    }