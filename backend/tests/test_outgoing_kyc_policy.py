import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("kyc_status", [None, "not_started", "pending", "rejected"])
def test_transfer_rejects_unverified_kyc_before_challenge_or_debit(
        monkeypatch, kyc_status):
    async def get_user(_uid):
        return {"id": "merchant-1", "kyc_status": kyc_status}

    async def should_not_check_turnstile(*_args, **_kwargs):
        pytest.fail("Turnstile should not run before the KYC gate")

    monkeypatch.setattr(server, "get_user", get_user)
    monkeypatch.setattr(server, "_require_turnstile", should_not_check_turnstile)
    request = SimpleNamespace(state=SimpleNamespace(merchant_api=False))
    body = server.TransferRequest(
        transfer_type="biz_to_biz", recipient="recipient-1",
        amount=100, currency="XOF",
    )

    with pytest.raises(HTTPException) as exc:
        run(server.transfer(body, request, "merchant-1"))

    assert exc.value.status_code == 403
    assert exc.value.detail == server.OUTGOING_KYC_REQUIRED_DETAIL


@pytest.mark.parametrize("kyc_status", [None, "not_started", "pending", "rejected"])
def test_exchange_rejects_unverified_kyc_before_wallet_mutation(
        monkeypatch, kyc_status):
    async def get_user(_uid):
        return {"id": "merchant-1", "kyc_status": kyc_status}

    async def should_not_load_config():
        pytest.fail("Exchange setup should not run before the KYC gate")

    monkeypatch.setattr(server, "get_user", get_user)
    monkeypatch.setattr(server, "get_platform_config", should_not_load_config)

    with pytest.raises(HTTPException) as exc:
        run(server.do_exchange(
            server.ExchangeRequest(
                from_currency="XOF", to_currency="XAF", amount=100,
            ),
            uid="merchant-1",
        ))

    assert exc.value.status_code == 403
    assert exc.value.detail == server.OUTGOING_KYC_REQUIRED_DETAIL