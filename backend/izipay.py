"""IzichangePay client — Server-side only.
Docs: https://docs.pay.izichange.com/
Never expose IZIPAY_API_KEY or IZIPAY_WEBHOOK_SECRET to the frontend.
"""
import os
import hmac
import hashlib
import json
import uuid
import time
import logging
from typing import Optional, Any

import httpx
from fastapi import HTTPException

log = logging.getLogger("izipay")

_API_KEY = os.environ.get("IZIPAY_API_KEY", "")
_WEBHOOK_SECRET = os.environ.get("IZIPAY_WEBHOOK_SECRET", "")
_BASE_URL = os.environ.get("IZIPAY_BASE_URL", "https://api.pay.izichange.com").rstrip("/")

# Anti-replay: max age (seconds) between webhook timestamp and now
_MAX_WEBHOOK_AGE = 5 * 60  # 5 minutes


class IziPayError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


def _headers(idempotency_key: Optional[str] = None) -> dict:
    if not _API_KEY:
        raise HTTPException(500, "IZIPAY_API_KEY not configured")
    h = {
        "Authorization": f"Bearer {_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if idempotency_key:
        h["Idempotency-Key"] = idempotency_key
    return h


async def _post(path: str, body: dict, idempotency_key: Optional[str] = None) -> dict:
    url = f"{_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.post(url, json=body, headers=_headers(idempotency_key))
        except httpx.HTTPError as e:
            log.error("izipay network error: %s", e)
            raise HTTPException(502, f"IzichangePay unreachable: {e}")
    if r.status_code >= 400:
        try:
            data = r.json()
        except Exception:
            data = {"message": r.text}
        log.warning("izipay error %s: %s", r.status_code, data)
        raise IziPayError(r.status_code, data.get("code", "unknown"), data.get("message", "IzichangePay error"))
    return r.json()


async def _get(path: str) -> dict:
    url = f"{_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get(url, headers=_headers())
        except httpx.HTTPError as e:
            raise HTTPException(502, f"IzichangePay unreachable: {e}")
    if r.status_code >= 400:
        try:
            data = r.json()
        except Exception:
            data = {"message": r.text}
        raise IziPayError(r.status_code, data.get("code", "unknown"), data.get("message", "IzichangePay error"))
    return r.json()


# --------- Public API wrappers ---------

async def create_direct_intent(
    *,
    requested_coin: str,          # e.g. "USDT.TRC20"
    amount: str,                  # decimal string
    first_name: str,
    last_name: str,
    email: str,
    refund_address: str,          # required by IzichangePay
    merchant_reference: str,
    metadata: Optional[dict] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Create a direct crypto payment intent — returns depositAddress, memo,
    amountToSend, expiresAt without any redirect.
    Docs: /v1/payment-intents/direct
    """
    body: dict[str, Any] = {
        "requestedCoin": requested_coin,
        "amount": str(amount),
        "customer": {
            "firstName": first_name,
            "lastName": last_name,
            "email": email,
            "refundAddress": refund_address,
        },
        "merchantReference": merchant_reference,
    }
    if metadata:
        body["metadata"] = metadata
    return await _post("/v1/payment-intents/direct", body,
                       idempotency_key=idempotency_key or f"pid-{uuid.uuid4()}")


# Simple in-memory cache for /v1/assets (invalidated on process restart)
_assets_cache: dict[str, Any] = {"at": 0, "data": None}


async def list_assets(force: bool = False) -> list[dict]:
    """List active crypto assets available on IzichangePay account. Cached 5 min."""
    now = int(time.time())
    if not force and _assets_cache["data"] and (now - _assets_cache["at"]) < 300:
        return _assets_cache["data"]
    data = await _get("/v1/assets")
    if isinstance(data, list):
        _assets_cache["at"] = now
        _assets_cache["data"] = data
    return data


async def create_payment_intent(
    *,
    amount_requested: str,
    currency_requested: str,
    requested_currency_type: str = "fiat",  # "fiat" or "crypto"
    accepted_coins: Optional[list[str]] = None,
    merchant_reference: str,
    return_url: Optional[str] = None,
    metadata: Optional[dict] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Create a payment intent. Returns the hosted paymentUrl + intent id.

    amount_requested: string decimal (e.g. "5000") — never a number, per docs
    currency_requested: XOF, XAF, USDT, etc.
    accepted_coins: e.g. ["USDT.TRC20", "USDT.BEP20"]
    """
    body: dict[str, Any] = {
        "requestedCurrencyType": requested_currency_type,
        "currencyRequested": currency_requested,
        "amountRequested": str(amount_requested),
        "merchantReference": merchant_reference,
    }
    if accepted_coins:
        body["acceptedCoins"] = accepted_coins
    if return_url:
        body["returnUrl"] = return_url
    if metadata:
        body["metadata"] = metadata
    return await _post("/v1/payment-intents", body, idempotency_key=idempotency_key or f"pi-{uuid.uuid4()}")


async def get_payment_intent(intent_id: str) -> dict:
    return await _get(f"/v1/payment-intents/{intent_id}")


async def create_payout(
    *,
    asset_code: str,         # e.g. "USDT.TRC20" — must match /v1/assets
    amount: str,             # decimal string
    destination_address: str,
    merchant_reference: str,
    destination_memo: Optional[str] = None,
    fee_bearer: str = "merchant",
    metadata: Optional[dict] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Send crypto to an external wallet.
    Docs: https://docs.pay.izichange.com/api-reference/v1/payouts
    """
    body: dict[str, Any] = {
        "assetCode": asset_code,
        "amount": str(amount),
        "destinationAddress": destination_address,
        "merchantReference": merchant_reference,
        "feeBearer": fee_bearer,
    }
    if destination_memo:
        body["destinationMemo"] = destination_memo
    # IzichangePay /v1/payouts rejects any extra fields (strict schema).
    # Metadata is kept in our own DB only.
    _ = metadata
    return await _post("/v1/payouts", body, idempotency_key=idempotency_key or f"po-{uuid.uuid4()}")


async def get_payout(payout_id: str) -> dict:
    return await _get(f"/v1/payouts/{payout_id}")


# --------- Webhook verification ---------

def verify_webhook(raw_body: bytes, signature_header: str) -> dict:
    """Verify HMAC-SHA256 signature and anti-replay. Returns parsed event dict.
    Raises HTTPException(400) on invalid signature or replay.
    """
    if not _WEBHOOK_SECRET:
        raise HTTPException(500, "IZIPAY_WEBHOOK_SECRET not configured")
    if not signature_header:
        raise HTTPException(400, "Missing X-IziPay-Signature header")

    # Extract hex signature: "sha256=<hex>"
    sig = signature_header.strip()
    if sig.startswith("sha256="):
        sig = sig[len("sha256="):]

    expected = hmac.new(_WEBHOOK_SECRET.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(400, "Invalid webhook signature")

    # Parse body AFTER signature check
    try:
        event = json.loads(raw_body.decode("utf-8"))
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    # Anti-replay: timestamp field inside signed body
    ts = event.get("timestamp")
    if not isinstance(ts, (int, float)):
        raise HTTPException(400, "Missing timestamp in event body")
    now = int(time.time())
    if abs(now - int(ts)) > _MAX_WEBHOOK_AGE:
        raise HTTPException(400, "Webhook timestamp too old (replay protection)")

    return event


def event_id(event: dict) -> str:
    """Deterministic id for dedup: type:resource:timestamp."""
    data = event.get("data") or {}
    resource = data.get("intentId") or data.get("payoutId") or data.get("id") or "?"
    return f"{event.get('event') or event.get('type') or '?'}:{resource}:{event.get('timestamp')}"


def is_configured() -> bool:
    return bool(_API_KEY and _WEBHOOK_SECRET)
