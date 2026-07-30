"""FedaPay client — Server-side only.

Docs: https://docs.fedapay.com/
Never expose FEDAPAY_SECRET_KEY or FEDAPAY_WEBHOOK_SECRET to the frontend.

Public flow:
    1. create_transaction(...)  → returns FedaPay tx with id + reference
    2. generate_token(tx_id)    → returns {token, url}
    3. send_mobile_money(mode, token, phone, country) → triggers USSD prompt
    4. webhook_verify(raw_body, sig) confirms → we credit the wallet
"""
from __future__ import annotations

import hmac
import hashlib
import json
import logging
import os
from typing import Optional

import httpx
from fastapi import HTTPException

log = logging.getLogger("fedapay")

_SECRET_KEY = os.environ.get("FEDAPAY_SECRET_KEY", "")
_PUBLIC_KEY = os.environ.get("FEDAPAY_PUBLIC_KEY", "")
_WEBHOOK_SECRET = os.environ.get("FEDAPAY_WEBHOOK_SECRET", "")
_BASE_URL = os.environ.get(
    "FEDAPAY_BASE_URL", "https://api.fedapay.com/v1").rstrip("/")


# ---------- Country + Operator catalog ----------
# Country ISO-2 -> [{code, label, mode, kind}]
# `mode` is the FedaPay legacy mode string used for POST /transactions/{mode}
# and POST /payouts (see docs-v1). `kind` is "collect" | "payout" | "both".
OPERATORS: dict[str, list[dict]] = {
    "BJ": [
        {"code": "mtn_bj", "label": "MTN Bénin", "mode": "mtn_open", "kind": "both"},
        {"code": "moov_bj", "label": "Moov Bénin", "mode": "moov", "kind": "both"},
        {"code": "celtiis_bj", "label": "Celtiis Bénin", "mode": "celtiis_bj", "kind": "both"},
    ],
    "CI": [
        {"code": "mtn_ci", "label": "MTN Côte d'Ivoire", "mode": "mtn_ci", "kind": "both"},
        {"code": "moov_ci", "label": "Moov Côte d'Ivoire", "mode": "moov_ci", "kind": "payout"},
        {"code": "orange_ci", "label": "Orange Côte d'Ivoire", "mode": "orange_ci", "kind": "payout"},
        {"code": "wave_ci", "label": "Wave Côte d'Ivoire", "mode": "wave_ci", "kind": "payout"},
    ],
    "TG": [
        {"code": "moov_tg", "label": "Moov Togo", "mode": "moov_tg", "kind": "both"},
        {"code": "togocel_tg", "label": "TogoCom (T-Money)", "mode": "togocel", "kind": "both"},
    ],
    "SN": [
        {"code": "orange_sn", "label": "Orange Sénégal", "mode": "orange_sn", "kind": "both"},
        {"code": "moov_sn", "label": "Moov Sénégal (Free)", "mode": "free_sn", "kind": "payout"},
    ],
    "ML": [
        {"code": "airtel_ml", "label": "Airtel Mali", "mode": "airtel_ml", "kind": "collect"},
    ],
    "NE": [
        {"code": "airtel_ne", "label": "Airtel Niger", "mode": "airtel_ne", "kind": "collect"},
        {"code": "wave_ne", "label": "Wave Niger", "mode": "wave_ne", "kind": "both"},
        {"code": "orange_ne", "label": "Orange Niger", "mode": "orange_ne", "kind": "both"},
    ],
    "BF": [
        {"code": "moov_bf", "label": "Moov Burkina Faso", "mode": "moov_bf", "kind": "both"},
        {"code": "yas_bf", "label": "Mixx by Yas Burkina", "mode": "sbin", "kind": "collect"},
    ],
    "GN": [
        {"code": "mtn_gn", "label": "MTN Guinée", "mode": "mtn_open_gn", "kind": "both"},
        {"code": "moov_gn", "label": "Moov Guinée", "mode": "moov_gn", "kind": "collect"},
        {"code": "wave_gn", "label": "Wave Guinée", "mode": "wave_gn", "kind": "collect"},
        {"code": "orange_gn", "label": "Orange Guinée", "mode": "orange_gn", "kind": "collect"},
    ],
}


COUNTRY_LABELS = {
    "BJ": "Bénin", "CI": "Côte d'Ivoire", "TG": "Togo",
    "SN": "Sénégal", "ML": "Mali", "NE": "Niger",
    "BF": "Burkina Faso", "GN": "Guinée",
}


def is_configured() -> bool:
    return bool(_SECRET_KEY)


def public_key() -> str:
    return _PUBLIC_KEY


def catalog() -> list[dict]:
    """Return the full country/operator catalog for the frontend."""
    out = []
    for iso, ops in OPERATORS.items():
        out.append({
            "country": iso,
            "country_label": COUNTRY_LABELS.get(iso, iso),
            "operators": ops,
        })
    return out


def operator_for(country: str, code: str) -> Optional[dict]:
    for op in OPERATORS.get(country.upper(), []):
        if op["code"] == code:
            return op
    return None


class FedaPayError(Exception):
    def __init__(self, status: int, message: str, raw: Optional[dict] = None):
        self.status = status
        self.message = message
        self.raw = raw or {}
        super().__init__(f"[{status}] {message}")


def _headers() -> dict:
    if not _SECRET_KEY:
        raise HTTPException(500, "FEDAPAY_SECRET_KEY not configured")
    return {
        "Authorization": f"Bearer {_SECRET_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def _request(method: str, path: str,
                   body: Optional[dict] = None) -> dict:
    url = f"{_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.request(method, url, json=body,
                                     headers=_headers())
        except httpx.HTTPError as e:
            log.error("fedapay network error: %s", e)
            raise HTTPException(502, f"FedaPay unreachable: {e}")
    if r.status_code >= 400:
        try:
            data = r.json()
        except Exception:
            data = {"message": r.text}
        msg = (
            data.get("message")
            or (data.get("errors") and str(data["errors"]))
            or "FedaPay error"
        )
        log.warning("fedapay %s %s -> %s: %s", method, path, r.status_code, data)
        raise FedaPayError(r.status_code, str(msg), raw=data if isinstance(data, dict) else {})
    return r.json()


# ---------- Deposit / collect ----------
async def create_transaction(*, amount: int, currency: str,
                              description: str,
                              customer_email: str,
                              customer_firstname: str,
                              customer_lastname: str,
                              customer_phone: str,
                              customer_country: str,
                              callback_url: Optional[str] = None,
                              metadata: Optional[dict] = None) -> dict:
    """Create a FedaPay transaction ready to be paid."""
    body: dict = {
        "amount": int(amount),
        "currency": {"iso": currency.upper()},
        "description": description,
        "callback_url": callback_url or "",
        "customer": {
            "firstname": customer_firstname,
            "lastname": customer_lastname,
            "email": customer_email,
            "phone_number": {
                "number": customer_phone,
                "country": customer_country.lower(),
            },
        },
    }
    if metadata:
        body["custom_metadata"] = metadata
    resp = await _request("POST", "/transactions", body)
    return resp.get("v1/transaction") or resp.get("transaction") or resp


async def generate_token(tx_id: int | str) -> dict:
    """Generate the payment token for a transaction (needed to trigger USSD)."""
    resp = await _request("POST", f"/transactions/{tx_id}/token", {})
    return resp


async def send_mobile_money(mode: str, token: str) -> dict:
    """Trigger the Mobile Money USSD prompt on the customer's phone.

    `mode` is one of the FedaPay legacy mode strings (mtn_open, moov, mtn_ci,
    moov_tg, togocel, wave_ci, orange_ci, orange_sn, free_sn, mtn_open_gn,
    moov_gn, moov_bf, sbin, airtel_ml, airtel_ne, wave_ne, orange_ne, etc.).
    """
    return await _request("POST", f"/transactions/{mode}", {"token": token})


async def get_transaction(tx_id: int | str) -> dict:
    resp = await _request("GET", f"/transactions/{tx_id}")
    return resp.get("v1/transaction") or resp.get("transaction") or resp


# ---------- Payout / withdrawal ----------
async def create_payout(*, amount: int, currency: str,
                        description: str,
                        mode: str,
                        merchant_reference: str,
                        beneficiary_firstname: str,
                        beneficiary_lastname: str,
                        beneficiary_email: Optional[str],
                        beneficiary_phone: str,
                        beneficiary_country: str) -> dict:
    body: dict = {
        "amount": int(amount),
        "currency": {"iso": currency.upper()},
        "description": description,
        "mode": mode,
        "merchant_reference": merchant_reference,
        "customer": {
            "firstname": beneficiary_firstname,
            "lastname": beneficiary_lastname or beneficiary_firstname,
            "phone_number": {
                "number": beneficiary_phone,
                "country": beneficiary_country.lower(),
            },
        },
    }
    if beneficiary_email:
        body["customer"]["email"] = beneficiary_email
    resp = await _request("POST", "/payouts", body)
    return resp.get("v1/payout") or resp.get("payout") or resp


async def start_payout(payout_id: int | str) -> dict:
    """Trigger the payout execution. Sends the funds to the beneficiary."""
    body = {"payouts": [{"id": int(payout_id)}]}
    return await _request("PUT", "/payouts/start", body)


async def get_payout(payout_id: int | str) -> dict:
    resp = await _request("GET", f"/payouts/{payout_id}")
    return resp.get("v1/payout") or resp.get("payout") or resp


# ---------- Webhook verification ----------
def verify_webhook(raw_body: bytes, signature: Optional[str]) -> dict:
    """Verify the HMAC-SHA256 signature of a webhook payload.

    FedaPay sends `X-FEDAPAY-SIGNATURE` computed as HMAC-SHA256(secret, raw_body).
    Returns the parsed event dict on success. Raises HTTPException(400) on
    invalid signature.
    """
    if not _WEBHOOK_SECRET:
        raise HTTPException(500, "FEDAPAY_WEBHOOK_SECRET not configured")
    if not signature:
        raise HTTPException(400, "Missing webhook signature")
    # FedaPay signature format is like: t=<ts>,s=<sig>
    parts = {}
    for chunk in signature.split(","):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    ts = parts.get("t")
    sig = parts.get("s")
    if not sig:
        # Fallback: raw hex signature (older accounts)
        sig = signature.strip()
    payload_for_sig = f"{ts}.{raw_body.decode()}" if ts else raw_body.decode()
    expected = hmac.new(_WEBHOOK_SECRET.encode(),
                        payload_for_sig.encode(),
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(400, "Invalid webhook signature")
    try:
        event = json.loads(raw_body)
    except Exception:
        raise HTTPException(400, "Invalid webhook body")
    return event
