"""Fee-inclusive Orange instructions with mocked providers and storage."""

import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def orange_config():
    return {
        "enabled": True,
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "BF", "code": "orange_bf", "currency": "XOF",
            "endpoint_slug": "orange-money-burkina", "active": True,
            "fee_fixed": 20, "min": 100, "max": 100000,
        }],
    }


def request():
    return Request({
        "type": "http", "method": "POST", "scheme": "https",
        "path": "/api/deposits/mobile-money",
        "headers": [(b"host", b"example.test")],
        "query_string": b"", "server": ("example.test", 443),
    })


def assert_otp_instructions(error, expected):
    assert error.status_code == 400
    assert error.detail["code"] == "OTP_REQUIRED"
    flow = error.detail["payment_flow"]
    assert flow["ussd_code"] == f"*144*4*6*{expected}#"
    assert flow["steps"][0] == f"Composez *144*4*6*{expected}# sur votre téléphone."
    assert flow["steps"][1] == "Suivez le menu pour générer le code de paiement."


@pytest.mark.parametrize(("bearer", "expected"), [
    ("client", 520), ("sender", 520), ("merchant", 500), ("receiver", 500),
])
def test_orange_deposit_otp_required_uses_total_to_pay(monkeypatch, bearer, expected):
    monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value=orange_config()))
    create_invoice = AsyncMock()
    monkeypatch.setattr(server.paydunya, "create_invoice", create_invoice)
    payload = server.MobileMoneyDepositRequest(
        amount=500, currency="XOF", country="BF", operator="orange_bf",
        fee_bearer=bearer, phone_number="70000000",
        full_name="Test Buyer", email="buyer@example.test",
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(server.create_mobile_money_deposit(payload, request(), "test-user"))
    assert_otp_instructions(caught.value, expected)
    create_invoice.assert_not_awaited()


@pytest.mark.parametrize(("owner_bearer", "request_bearer", "expected"), [
    ("customer", "merchant", 520),
    ("owner", "client", 500),
])
def test_orange_link_instructions_follow_owner_fee_policy(
        monkeypatch, owner_bearer, request_bearer, expected):
    link = {"id": "test-link", "slug": "test", "active": True,
            "amount_type": "fixed", "amount": 500,
            "currency": "XOF", "fee_bearer": owner_bearer}
    monkeypatch.setattr(server, "db", SimpleNamespace(
        payment_links=SimpleNamespace(find_one=AsyncMock(return_value=link))))
    monkeypatch.setattr(server, "_require_turnstile", AsyncMock())
    monkeypatch.setattr(server, "_ensure_link_can_be_paid", AsyncMock(return_value=500))
    monkeypatch.setattr(server, "_resolve_deposit_provider", AsyncMock(return_value="paydunya"))
    monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value=orange_config()))
    create_invoice = AsyncMock()
    monkeypatch.setattr(server.paydunya, "create_invoice", create_invoice)
    payload = server.LinkPayMoMoRequest(
        slug="test", amount=500, country="BF", operator="orange_bf",
        phone_number="70000000", fee_bearer=request_bearer,
        full_name="Test Buyer", email="buyer@example.test",
    )
    with pytest.raises(HTTPException) as caught:
        asyncio.run(server.start_link_payment_momo(payload, request()))
    assert_otp_instructions(caught.value, expected)
    create_invoice.assert_not_awaited()


@pytest.mark.parametrize(("bearer", "charged", "net"), [
    ("client", 520, 500), ("merchant", 500, 480),
])
@pytest.mark.parametrize("provider", ["paydunya", "mbiyo"])
def test_orange_pending_instructions_match_provider_amount_and_fee_snapshot(
        monkeypatch, provider, bearer, charged, net):
    collection = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(), update_one=AsyncMock(), create_index=AsyncMock(),
    )
    monkeypatch.setattr(server, "db", SimpleNamespace(momo_deposits=collection))
    payload = server.MobileMoneyDepositRequest(
        amount=500, currency="XOF", country="BF", operator="orange_bf",
        fee_bearer=bearer, phone_number="70000000", otp="123456",
        full_name="Test Buyer", email="buyer@example.test",
    )
    if provider == "paydunya":
        monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value=orange_config()))
        submitted = AsyncMock(return_value={"token": "test-invoice"})
        monkeypatch.setattr(server.paydunya, "create_invoice", submitted)
        monkeypatch.setattr(server.paydunya, "softpay_payment", AsyncMock(
            return_value={"response_code": "00", "reference": "test-provider-reference"}))
        result = asyncio.run(server.create_mobile_money_deposit(
            payload, request(), "test-user"))
    else:
        operator = {**orange_config()["catalog"][0], "code": "mbiyo_orange_bf",
                    "network": "orange"}
        monkeypatch.setattr(server, "get_mbiyo_config", AsyncMock(return_value={
            "enabled": True, "_api_key": "test-only-placeholder", "catalog": [operator],
        }))
        submitted = AsyncMock(return_value={
            "transaction_id": "test-provider-transaction", "status": "pending",
        })
        monkeypatch.setattr(server.mbiyo, "MbiyoClient",
                            lambda *args: SimpleNamespace(payin=submitted))
        result = asyncio.run(server._create_mbiyo_deposit(
            payload, request(), "test-user"))
    assert submitted.await_args.kwargs["amount"] == charged
    assert result["charged_amount"] == charged
    assert result["status"] == "pending"
    assert result["payment_flow"]["ussd_code"] == f"*144*4*6*{charged}#"
    assert f"*144*4*6*{charged}#" in result["payment_flow"]["steps"][0]
    saved = collection.insert_one.await_args.args[0]
    assert saved["charged_amount"] == charged
    assert saved["wallet_credit_amount"] == net
