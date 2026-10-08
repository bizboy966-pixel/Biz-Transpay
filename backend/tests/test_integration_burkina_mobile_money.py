"""Burkina merchant API contracts: isolated store, mocked provider requests."""
import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import server
from integration_api import create_router
from integration_mobile_money import operator_catalog
from test_integration_api import DB, ctx, route
from test_integration_payout_lifecycle import WalletCollection, request


def credential():
    return {"user_id": "test-merchant", "environment": "live",
            "scopes": ["deposits:write"], "user": {"kyc_status": "verified"}}


def configure_deposits(monkeypatch):
    operators = [
        {**row, "active": True, "platform_fee_fixed": 20}
        for row in server.paydunya.default_catalog()
        if row["country"] == "BF"
    ]
    config = {"mode": "live", "enabled": True,
              "master_key_encrypted": "test-only", "private_key_encrypted": "test-only",
              "token_encrypted": "test-only",
              "modes": {"softpay_direct": {"enabled": True}}, "catalog": operators}
    db = DB(momo_deposits=WalletCollection())
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value=config))
    monkeypatch.setattr(server, "_resolve_deposit_provider", AsyncMock(return_value="paydunya"))
    monkeypatch.setattr(server, "_idempotency_claim", AsyncMock(return_value=None))
    monkeypatch.setattr(server, "_idempotency_store", AsyncMock())
    monkeypatch.setattr(server, "_idempotency_release", AsyncMock())
    monkeypatch.setattr(server, "_paydunya_callback_base", lambda _: "https://callbacks.example.test")
    invoice = AsyncMock(return_value={"token": "test-invoice"})
    provider = AsyncMock(return_value={"success": True, "message": "Accepted"})
    monkeypatch.setattr(server.paydunya, "create_invoice", invoice)
    monkeypatch.setattr(server.paydunya, "_request", provider)
    router = create_router(ctx(db))
    return db, router, invoice, provider


@pytest.mark.parametrize("operator", ["moov_bf", "orange_bf"])
def test_api_payin_uses_documented_payload_preserves_pending_and_replays(monkeypatch, operator):
    async def scenario():
        db, router, invoice, provider = configure_deposits(monkeypatch)
        create = route(router, "/v1/deposits", "POST")
        body = create.__annotations__["body"](
            amount=500, currency="XOF", country="BF", operator=operator,
            phone_number="70000000", full_name="Client exemple",
            email="buyer@example.com", otp="12345" if operator == "orange_bf" else None,
        )
        initial = await create(body, request("burkina-payin"), credential())
        assert initial["status"] == "pending"
        assert initial["deposit"]["charged_amount"] == 500
        assert db.momo_deposits.docs[0]["wallet_credit_amount"] == 480
        assert (await create(body, request("burkina-payin"), credential())) == initial
        invoice.assert_awaited_once()
        provider.assert_awaited_once()
        method, path, _, payload = provider.await_args.args
        assert method == "POST"
        if operator == "orange_bf":
            assert path == "/api/v1/softpay/orange-money-burkina"
            assert payload == {
                "name_bf": "Client exemple", "email_bf": "buyer@example.com",
                "phone_bf": "70000000", "otp_code": "12345", "payment_token": "test-invoice",
            }
            assert initial["deposit"]["payment_flow"]["ussd_code"] == "*144*4*6*500#"
        else:
            assert path == "/api/v1/softpay/moov-burkina"
            assert payload == {
                "moov_burkina_faso_fullName": "Client exemple",
                "moov_burkina_faso_email": "buyer@example.com",
                "moov_burkina_faso_phone_number": "70000000",
                "moov_burkina_faso_payment_token": "test-invoice",
            }
            assert initial["deposit"]["payment_flow"]["ussd_code"] == "*555*6#"
            assert not initial["deposit"]["payment_flow"]["otp_required"]
        assert db.integration_operations.docs[0]["business_id"] == initial["id"]
        assert db.momo_deposits.docs[0]["status"] == "pending"

    asyncio.run(scenario())


def test_orange_otp_challenge_can_be_corrected_without_poisoning_idempotency(monkeypatch):
    async def scenario():
        db, router, invoice, provider = configure_deposits(monkeypatch)
        create = route(router, "/v1/deposits", "POST")
        body = create.__annotations__["body"](
            amount=500, currency="XOF", country="BF", operator="orange_bf",
            phone_number="70000000", full_name="Client exemple", email="buyer@example.com",
        )
        with pytest.raises(HTTPException) as error:
            await create(body, request("orange-challenge"), credential())
        assert error.value.status_code == 400
        assert error.value.detail["code"] == "OTP_REQUIRED"
        assert error.value.detail["payment_flow"]["ussd_code"] == "*144*4*6*500#"
        invoice.assert_not_awaited()
        provider.assert_not_awaited()
        assert not db.integration_idempotency.docs
        assert not db.momo_deposits.docs
        body.otp = "12345"
        result = await create(body, request("orange-challenge"), credential())
        assert result["status"] == "pending"
        assert await create(body, request("orange-challenge"), credential()) == result
        invoice.assert_awaited_once()

    asyncio.run(scenario())


@pytest.mark.parametrize("persisted", [False, True])
def test_uncertain_or_persisted_deposit_never_releases_claim(monkeypatch, persisted):
    async def scenario():
        db = DB()

        async def reject(body, _, uid):
            if persisted:
                await db.momo_deposits.insert_one({
                    "id": "existing-payment", "user_id": uid, "status": "pending",
                    "idempotency_key": body.idempotency_key,
                })
                raise HTTPException(400, {"code": "OTP_REQUIRED"})
            raise HTTPException(502, "Provider response unavailable")

        handler = AsyncMock(side_effect=reject)
        router = create_router(ctx(db, start_mobile_money_deposit=handler))
        create = route(router, "/v1/deposits", "POST")
        body = create.__annotations__["body"](
            amount=500, currency="XOF", country="BF", operator="orange_bf",
            phone_number="70000000", full_name="Client exemple", email="buyer@example.com",
        )
        with pytest.raises(HTTPException):
            await create(body, request("uncertain-payment"), credential())
        assert len(db.integration_idempotency.docs) == 1
        body.otp = "12345"
        with pytest.raises(HTTPException) as conflict:
            await create(body, request("uncertain-payment"), credential())
        assert conflict.value.status_code == 409
        handler.assert_awaited_once()

    asyncio.run(scenario())


@pytest.mark.parametrize("direction", ["deposit", "payout"])
@pytest.mark.parametrize("enabled", [True, False])
def test_catalog_is_direction_specific_and_omits_private_routing(direction, enabled):
    async def scenario():
        rows = [{
            "country": "BF", "country_label": "Burkina Faso",
            "code": "orange_bf" if direction == "deposit" else "orange-money-burkina",
            "name": "Orange Burkina", "currency": "XOF", "min": 100, "max": None,
            "provider": "private-provider", "withdraw_mode": "private-mode",
            "_credentials": {"private_key": "test-only"},
            "payment_flow": server.paydunya.payment_flow({"endpoint_slug": "orange-money-burkina"}),
        }]
        context = {
            "deposits_config_public": AsyncMock(return_value={
                "mobile_money_enabled": enabled,
                "catalog": [{"country": "BF", "operators": rows}],
            }),
            "transfer_config": AsyncMock(return_value={
                "mobile_money": {"enabled": enabled, "operators": rows},
            }),
        }
        result = await operator_catalog(context, direction, "test-merchant")
        assert result["direction"] == direction
        assert result["enabled"] == enabled
        assert result["availability_source"] == "serving_environment_configuration"
        if not enabled:
            assert result["operators"] == []
            return
        public = result["operators"][0]
        assert public["code"] == rows[0]["code"]
        assert not {"provider", "withdraw_mode", "_credentials"} & public.keys()
        if direction == "deposit":
            assert public["payment_flow"]["before_submit"]
            assert public["payment_flow"]["ussd_template"] == "*144*4*6*{amount}#"
        else:
            assert "payment_flow" not in public

    asyncio.run(scenario())


def test_discovery_route_accepts_api_keys_including_read_only_test_environment():
    async def scenario():
        catalog = AsyncMock(return_value={"mobile_money_enabled": False, "catalog": []})
        router = create_router(ctx(DB(), deposits_config_public=catalog))
        endpoint = route(router, "/v1/mobile-money/operators", "GET")
        result = await endpoint("deposit", {"user_id": "test-merchant", "environment": "test"})
        assert not result["enabled"]
        catalog.assert_awaited_once_with(surface="dashboard")

    asyncio.run(scenario())


def test_documentation_describes_both_burkina_directions_and_confirmations():
    async def scenario():
        payload = await route(create_router(ctx(DB())), "/documentation", "GET")()
        sections = {row["id"]: row for row in payload["sections"]}
        assert "*555*6#" in sections["burkina-moov-deposits"]["description"]
        assert "otp" in sections["burkina-orange-deposits"]["description"]
        assert "frais inclus" in sections["burkina-orange-deposits"]["description"]
        examples = sections["burkina-payouts"]["examples"]["curl"]
        assert "moov-burkina-faso" in examples
        assert "orange-money-burkina" in examples
        assert "payouts:write" in sections["burkina-payouts"]["description"]
        assert "pending" in sections["burkina-payouts"]["description"]

    asyncio.run(scenario())
