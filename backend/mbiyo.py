"""Isolated Mbiyo Mobile Money client and catalogue."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any, Optional

import httpx

BASE_URL = "https://dashboard.mbiyo.africa/api/v1"
COUNTRY_LABELS = {
    "BF": "Burkina Faso", "BJ": "Bénin", "CI": "Côte d'Ivoire",
    "CM": "Cameroun", "CG": "Congo-Brazzaville", "ML": "Mali",
    "SN": "Sénégal", "TG": "Togo",
}
NETWORKS = {
    "BF": ("orange", "moov", "coris"),
    "BJ": ("mtn", "moov", "celtiis"),
    "CI": ("orange", "mtn", "wave", "moov"),
    "CM": ("orange", "mtn"),
    "CG": ("mtn",),
    "ML": ("orange", "moov"),
    "SN": ("orange", "free", "wave"),
    "TG": ("moov", "togocom"),
}
CURRENCIES = {"BF": "XOF", "BJ": "XOF", "CI": "XOF", "ML": "XOF",
              "SN": "XOF", "TG": "XOF", "CM": "XAF", "CG": "XAF"}
LIMITS = {
    "BF": (500, 1500000), "BJ": (50, 1500000), "CI": (500, 1500000),
    "ML": (500, 1500000), "SN": (500, 1500000), "TG": (500, 1500000),
    "CM": (50, 1500000), "CG": (500, 1500000),
}


class MbiyoError(Exception):
    def __init__(self, status: int, message: str, raw: Any = None):
        self.status, self.message, self.raw = status, message, raw
        super().__init__(f"[{status}] {message}")


def default_catalog() -> list[dict]:
    rows = []
    for country, networks in NETWORKS.items():
        currency = CURRENCIES[country]
        minimum, maximum = LIMITS[country]
        for network in networks:
            rows.append({
                "id": f"mbiyo-{country.lower()}-{network}",
                "provider": "mbiyo", "country": country,
                "country_label": COUNTRY_LABELS[country],
                "code": f"mbiyo_{network}_{country.lower()}",
                "network": network, "name": network.upper(),
                "currency": currency, "active": True, "archived": False,
                "hidden": False, "gateway_fee_pct": 0.0,
                "gateway_fee_fixed": 0.0, "platform_fee_pct": 0.0,
                "platform_fee_fixed": 0.0, "fee_pct": 0.0,
                "min": minimum, "max": maximum,
            })
    return rows


def default_config() -> dict:
    return {
        "id": "payment_provider_mbiyo", "enabled": True, "mode": "test",
        "setup_version": 2,
        "base_url": BASE_URL, "catalog": default_catalog(),
    }


def encrypt_secret(value: str, session_secret: str) -> str:
    from cryptography.fernet import Fernet
    key = base64.urlsafe_b64encode(hashlib.sha256(session_secret.encode()).digest())
    return Fernet(key).encrypt(value.encode()).decode()


def decrypt_secret(value: str, session_secret: str) -> str:
    from cryptography.fernet import Fernet
    key = base64.urlsafe_b64encode(hashlib.sha256(session_secret.encode()).digest())
    return Fernet(key).decrypt(value.encode()).decode()


def verify_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    if not raw_body or not signature or not secret:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    supplied = signature.strip().lower().removeprefix("sha256=")
    return hmac.compare_digest(expected, supplied)


def status_value(payload: dict) -> str:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return str((data or {}).get("status") or payload.get("status") or "").lower()


class MbiyoClient:
    def __init__(self, api_key: str, base_url: str = BASE_URL, timeout: float = 20):
        self.api_key = api_key
        self.base_url = (base_url or BASE_URL).rstrip("/")
        self.timeout = timeout

    async def _request(self, method: str, path: str, **kwargs):
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.update({"Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                        "Accept": "application/json"})
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.request(method, f"{self.base_url}{path}",
                                            headers=headers, **kwargs)
        try:
            payload = response.json()
        except Exception:
            payload = {"message": response.text}
        if response.status_code >= 400:
            message = payload.get("message") if isinstance(payload, dict) else None
            raise MbiyoError(response.status_code, message or "Mbiyo request failed", payload)
        return payload

    async def payin(self, **data):
        return await self._request("POST", "/merchant/payin", json=data)

    async def payout(self, **data):
        return await self._request("POST", "/merchant/payout", json=data)

    async def status(self, transaction_id: str):
        return await self._request("GET", f"/merchant/transactions/{transaction_id}")

    async def finalize(self, transaction_id: str, otp: str):
        return await self._request("POST", f"/merchant/transactions/{transaction_id}/finalize",
                                   json={"otp": otp})

    async def resend_webhook(self, transaction_id: str):
        return await self._request("POST",
                                   f"/merchant/transactions/{transaction_id}/resend-webhook")