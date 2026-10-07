"""Signed callbacks and responsive verification; no real provider requests."""
import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlencode

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def callback_request(payload, encoding):
    if encoding == "brackets":
        body = urlencode({
            "data[hash]": payload["hash"],
            "data[status]": payload["status"],
            "data[response_code]": payload["response_code"],
            "data[invoice][token]": payload["invoice"]["token"],
            "data[invoice][total_amount]": 500,
        }).encode()
        content_type = "application/x-www-form-urlencoded"
    else:
        body = json.dumps({"data": payload}).encode()
        content_type = "application/json"

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": "/api/webhooks/paydunya",
        "query_string": b"", "headers": [(b"content-type", content_type.encode())],
    }, receive)


@pytest.mark.parametrize("encoding", ["brackets", "json"])
@pytest.mark.parametrize("valid_hash", [True, False])
def test_callback_verifies_invoice_before_credit_and_does_not_double_credit(
        monkeypatch, encoding, valid_hash):
    async def scenario():
        digest = hashlib.sha512(b"test-master").hexdigest()
        payload = {"hash": digest if valid_hash else "invalid", "status": "completed",
                   "response_code": "00", "invoice": {"token": "test-invoice", "total_amount": 500}}
        document = {
            "id": "test-deposit", "user_id": "test-user", "provider": "paydunya",
            "paydunya_flow": "softpay_direct", "endpoint_slug": "moov-burkina",
            "paydunya_token": "test-invoice", "charged_amount": 500,
            "currency": "XOF", "status": "pending",
        }
        deposits = SimpleNamespace(find_one=AsyncMock(return_value=document),
                                   update_one=AsyncMock())
        events = SimpleNamespace(find_one=AsyncMock(return_value=None), create_index=AsyncMock(),
                                 insert_one=AsyncMock(), update_one=AsyncMock())
        monkeypatch.setattr(server, "db", SimpleNamespace(momo_deposits=deposits, webhook_events=events))
        monkeypatch.setattr(server, "get_paydunya_config", AsyncMock(return_value={
            "_credentials": {"master_key": "test-master"},
        }))
        confirm = AsyncMock(return_value={**payload, "hash": digest})
        monkeypatch.setattr(server.paydunya, "confirm_invoice", confirm)

        async def credit(_):
            document["status"] = "approved"

        credit_mock = AsyncMock(side_effect=credit)
        monkeypatch.setattr(server, "_credit_momo_deposit", credit_mock)
        if not valid_hash:
            with pytest.raises(HTTPException) as caught:
                await server.paydunya_webhook(callback_request(payload, encoding))
            assert caught.value.status_code == 400
            confirm.assert_not_awaited()
            credit_mock.assert_not_awaited()
            return
        assert await server.paydunya_webhook(callback_request(payload, encoding)) == {"received": True}
        assert document["status"] == "approved"
        assert await server.paydunya_webhook(callback_request(payload, encoding)) == {"received": True}
        confirm.assert_awaited_once()
        credit_mock.assert_awaited_once()
        assert events.update_one.await_args.args[1]["$set"]["processed"] is True
        assert deposits.find_one.await_args_list[0].args[0]["paydunya_token"] == "test-invoice"

    asyncio.run(scenario())


def test_status_timeout_preserves_background_verification_and_owner_scope(monkeypatch):
    async def scenario():
        release = asyncio.Event()
        document = {"id": "test-deposit", "user_id": "test-user", "provider": "paydunya",
                    "status": "pending", "amount": 500, "currency": "XOF"}

        async def find_one(query, projection=None):
            return document if query.get("user_id") == "test-user" else None

        monkeypatch.setattr(server, "db", SimpleNamespace(
            momo_deposits=SimpleNamespace(find_one=find_one)))
        monkeypatch.setattr(server, "MOMO_STATUS_WAIT_SECONDS", 0.01)

        async def verify(_):
            await release.wait()
            document["status"] = "approved"
            return True

        verified = AsyncMock(side_effect=verify)
        monkeypatch.setattr(server, "_verify_paydunya_deposit", verified)
        with pytest.raises(HTTPException) as caught:
            await server.get_momo_deposit("test-deposit", "other-user")
        assert caught.value.status_code == 404
        verified.assert_not_awaited()
        # The browser and integration API invoke this same owner-scoped handler.
        first, second = await asyncio.gather(
            server.get_momo_deposit("test-deposit", "test-user"),
            server.get_momo_deposit("test-deposit", "test-user"),
        )
        assert first["status"] == second["status"] == "pending"
        verified.assert_awaited_once()
        task = server._paydunya_confirmation_tasks["test-deposit"]
        assert not task.cancelled() and not task.done()
        release.set()
        assert await task is True
        assert document["status"] == "approved"

    asyncio.run(scenario())


def test_worker_bounds_parallelism_and_isolates_one_failed_verification(monkeypatch):
    async def scenario():
        active = peak = 0
        visited = []

        async def verify(identifier):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            visited.append(identifier)
            if identifier == "0":
                raise RuntimeError("Mock provider failure")
            return False

        monkeypatch.setattr(server, "_reconcile_momo_deposit", verify)
        await server._reconcile_momo_batch([
            {"id": str(i), "provider": "paydunya"} for i in range(8)])
        assert peak == 4
        assert len(visited) == 8

    asyncio.run(scenario())


def test_form_decoder_rejects_conflicting_fields():
    with pytest.raises(ValueError):
        server.paydunya.parse_webhook({
            "data[invoice]": "wrong", "data[invoice][token]": "test-token",
        })
