"""Moov Burkina SoftPay uses USSD, not a promised notification."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def test_moov_burkina_instructions_are_post_submission_ussd():
    flow = server.paydunya.payment_flow({"endpoint_slug": "moov-burkina"})
    assert flow["kind"] == "ussd_confirmation"
    assert flow["ussd_code"] == "*555*6#"
    assert flow["before_submit"] is False
    assert flow["otp_required"] is False
    assert "notification" not in " ".join(flow["steps"])
    assert server.paydunya.payment_flow({"endpoint_slug": "moov-togo"})["kind"] == "phone_confirmation"
    assert server.paydunya.payment_flow({"endpoint_slug": "moov-ci"})["kind"] == "phone_confirmation"


@pytest.mark.parametrize("outcome", ["accepted", "rejected", "insufficient"])
def test_direct_deposit_sends_documented_payload_and_checks_rejection(monkeypatch, outcome):
    accepted = outcome == "accepted"
    config = {
        "mode": "live", "enabled": True,
        "modes": {"softpay_direct": {"enabled": True}},
        "catalog": [{
            "country": "BF", "code": "moov_bf", "currency": "XOF",
            "endpoint_slug": "moov-burkina", "active": True,
            "min": 100, "max": 100000,
        }],
    }
    collection = SimpleNamespace(
        find_one=AsyncMock(return_value=None), insert_one=AsyncMock(),
        update_one=AsyncMock(), create_index=AsyncMock(),
    )
    monkeypatch.setattr(server, "db", SimpleNamespace(momo_deposits=collection))
    monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value=config))
    monkeypatch.setattr(server.paydunya, "create_invoice", AsyncMock(
        return_value={"token": "test-invoice"}))
    provider_request = AsyncMock(return_value={
        "success": accepted,
        "message": ("Veuillez compléter le paiement en composant le *555*6#."
                    if accepted else "Paiement refusé"),
    })
    if outcome == "insufficient":
        provider_request.side_effect = server.paydunya.PayDunyaError(
            403, "FAILED: Solde client insuffisant")
    monkeypatch.setattr(server.paydunya, "_request", provider_request)
    payload = server.MobileMoneyDepositRequest(
        amount=500, currency="XOF", country="BF", operator="moov_bf",
        phone_number="51765664", full_name="Test Buyer", email="buyer@example.test",
    )
    request = Request({
        "type": "http", "method": "POST", "scheme": "https",
        "path": "/api/deposits/mobile-money", "query_string": b"",
        "headers": [(b"host", b"example.test")], "server": ("example.test", 443),
    })
    if accepted:
        result = asyncio.run(server.create_mobile_money_deposit(payload, request, "test-user"))
        assert result["status"] == "pending"
        assert result["payment_flow"]["ussd_code"] == "*555*6#"
        assert "*555*6#" in result["message"]
        assert "notification" not in result["message"]
        assert collection.insert_one.await_args.args[0]["payment_flow"] == result["payment_flow"]
    else:
        with pytest.raises(HTTPException) as caught:
            asyncio.run(server.create_mobile_money_deposit(payload, request, "test-user"))
        assert caught.value.status_code == 400
        if outcome == "insufficient":
            assert "solde Mobile Money du payeur est insuffisant" in caught.value.detail
            assert "mal configuré" not in caught.value.detail
        assert collection.update_one.await_args.args[1]["$set"]["status"] == "failed"
        assert collection.update_one.await_args.args[1]["$set"]["prompt_sent"] is False
    method, path, _, body = provider_request.await_args.args
    assert (method, path) == ("POST", "/api/v1/softpay/moov-burkina")
    assert body == {
        "moov_burkina_faso_fullName": "Test Buyer",
        "moov_burkina_faso_email": "buyer@example.test",
        "moov_burkina_faso_phone_number": "51765664",
        "moov_burkina_faso_payment_token": "test-invoice",
    }


def test_existing_pending_direct_deposit_gets_corrected_instructions():
    result = server._public_momo_deposit({
        "id": "test-deposit", "status": "pending", "provider": "paydunya",
        "paydunya_flow": "softpay_direct", "endpoint_slug": "moov-burkina",
        "payment_flow": {"kind": "phone_confirmation", "steps": ["Validez la notification."]},
    })
    assert result["status"] == "pending"
    assert result["payment_flow"]["ussd_code"] == "*555*6#"


@pytest.mark.parametrize(("status", "message", "expected"), [
    (403, "FAILED: Solde client insuffisant", "solde Mobile Money du payeur est insuffisant"),
    (400, "Solde client insuffisant", "solde Mobile Money du payeur est insuffisant"),
    (403, "FAILED: SOLDE  CLIENT\nINSUFFISANT", "solde Mobile Money du payeur est insuffisant"),
    (403, "Forbidden", "temporairement mal configuré"),
    (401, "Unauthorized", "temporairement mal configuré"),
    (503, "PayDunya credentials are not configured", "temporairement mal configuré"),
    (502, "PayDunya unreachable", "momentanément indisponible"),
])
def test_provider_business_refusal_is_not_a_credential_error(status, message, expected):
    result = server._paydunya_operation_error(server.paydunya.PayDunyaError(status, message))
    assert expected in result
    assert "FAILED" not in result
