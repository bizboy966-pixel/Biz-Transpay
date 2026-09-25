"""Isolated AfribaPAY API client and documented Mobile Money catalogue.

This module deliberately contains no application state.  Credentials are passed
by the caller; the application may store their encrypted counterparts in its
provider settings document.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import math
import time
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx

BASE_URL = "https://api-sandbox.afribapay.com"
PAYOUT_BASE_URL = "https://api-payout-sandbox.afribapay.com"
STATUS_VALUES = {"pending", "success", "failed"}

COUNTRY_LABELS = {
    "BF": "Burkina Faso", "CD": "R.D.C", "CI": "Côte d'Ivoire",
    "CM": "Cameroun", "GA": "Gabon", "GN": "Guinée", "ML": "Mali",
    "NE": "Niger", "SN": "Sénégal", "TG": "Togo", "BJ": "Bénin",
}
COUNTRY_DIAL_CODES = {
    "BF": "226", "CD": "243", "CI": "225", "CM": "237", "GA": "241",
    "GN": "224", "ML": "223", "NE": "227", "SN": "221", "TG": "228",
    "BJ": "229",
}
COUNTRY_CURRENCIES = {
    "BF": ("XOF",), "CD": ("CDF",), "CI": ("XOF",), "CM": ("XAF",),
    "GA": ("XAF",), "GN": ("GNF",), "ML": ("XOF",), "NE": ("XOF",),
    "SN": ("XOF",), "TG": ("XOF",), "BJ": ("XOF",),
}
OPERATORS = {
    "BF": (("moov", "Moov Money", False, ""), ("orange", "Orange Money", True, "*144*4*6*MONTANT#"),
           ("wligdicash", "Wallet LigdiCash", True, "")),
    "CD": tuple((code, name, False, "") for code, name in (
        ("airtel", "Airtel Money"), ("mpesa", "Mpesa Money"),
        ("orange", "Orange Money"), ("afrimoney", "Afri Money"),
        ("vodacom", "Vodacom"))),
    "CI": (("moov", "Moov Money", False, ""), ("mtn", "MTN Money", False, "*133#"),
           ("orange", "Orange Money", True, "#144*82#"), ("wave", "Wave Money", False, "")),
    "CM": (("mtn", "MTN Money", False, "*126#"), ("orange", "Orange Money", False, "#150*50#")),
    "GA": (("airtel", "Airtel Money", False, ""), ("moov", "Moov Money", False, "")),
    "GN": (("mtn", "MTN Money", False, ""), ("orange", "Orange Money", True, "*144*4*2*1#")),
    "ML": (("moov", "Moov Money", False, ""), ("orange", "Orange Money", False, "#144#37#")),
    "NE": (("airtel", "Airtel Money", False, ""),),
    "SN": (("expresso", "E-money", False, ""), ("free", "Free Money", False, ""),
           ("orange", "Orange Money", True, "#144*391#"), ("wave", "Wave Money", False, "")),
    "TG": (("moov", "Moov Money", False, ""), ("tmoney", "T-Money", False, "")),
    "BJ": (("moov", "Moov Money", False, ""), ("mtn", "MTN Money", False, ""),
           ("celtiis", "Celtiis Money", False, ""), ("coris", "Coris Money", False, "")),
}


class AfriPayError(Exception):
    def __init__(self, status: int, message: str, raw: Any = None):
        self.status, self.message, self.raw = status, message, raw
        super().__init__(f"[{status}] {message}")


def _suffix(country: str, currency: str) -> str:
    return f"_{currency.lower()}" if len(COUNTRY_CURRENCIES[country]) > 1 else ""


def default_catalog() -> list[dict]:
    rows = []
    for country, currencies in COUNTRY_CURRENCIES.items():
        for currency in currencies:
            for code, name, otp, ussd in OPERATORS[country]:
                suffix = _suffix(country, currency)
                rows.append({
                    "id": f"afribapay-{country.lower()}-{code}-{currency.lower()}",
                    "provider": "afribapay", "country": country,
                    "country_label": COUNTRY_LABELS[country],
                    "code": f"afribapay_{code}_{country.lower()}{suffix}",
                    "public_code": f"{code}_{country.lower()}{suffix}",
                    "operator": code, "name": f"{name} ({currency})" if suffix else name,
                    "currency": currency, "otp_required": otp, "ussd_code": ussd,
                    "active": True, "archived": False, "hidden": False,
                    "gateway_fee_pct": 0.0, "gateway_fee_fixed": 0.0,
                    "platform_fee_pct": 0.0, "platform_fee_fixed": 0.0,
                    "fee_pct": 0.0, "min": 100, "max": 2000000,
                })
    return rows


def default_payout_catalog() -> list[dict]:
    return [{**row, "min": 100, "max": None} for row in default_catalog()]


def provider_code(country: str, operator: str, currency: str = "") -> str:
    country = country.upper()
    currency = currency.upper()
    if currency and currency not in COUNTRY_CURRENCIES.get(country, ()):
        raise ValueError("Devise AfribaPAY non documentée pour ce pays")
    suffix = _suffix(country, currency) if currency else ""
    return f"afribapay_{operator.lower()}_{country.lower()}{suffix}"


def payment_flow(operator: dict, amount: Optional[float] = None) -> dict:
    code = str(operator.get("operator") or operator.get("network") or
               operator.get("code") or "").lower()
    country = str(operator.get("country") or "").upper()
    otp = bool(operator.get("otp_required"))
    ussd = str(operator.get("ussd_code") or "")
    if code == "wave":
        return {"kind": "redirect", "before_submit": False, "otp_required": False,
                "steps": ["Ouvrez le lien AfribaPAY puis validez dans l'application Wave."]}
    if country == "BF" and code == "wligdicash":
        return {"kind": "wallet_otp", "before_submit": False, "otp_required": True,
                "otp_label": "Code OTP du portefeuille",
                "steps": ["Demandez un OTP via AfribaPAY puis confirmez le paiement."]}
    if otp:
        return {"kind": "otp", "before_submit": True, "otp_required": True,
                "otp_label": "Code OTP généré par le menu USSD",
                "ussd_code": ussd.replace("MONTANT", str(int(amount))) if amount else ussd,
                "ussd_template": ussd, "steps": ["Générez le code avec le menu USSD.",
                                                   "Saisissez le code OTP avant de lancer le paiement."]}
    return {"kind": "phone_confirmation", "before_submit": False, "otp_required": False,
            "steps": ["Lancez le paiement puis validez la notification sur votre téléphone."]}


def default_config() -> dict:
    return {"id": "payment_provider_afribapay", "enabled": False,
            "mode": "sandbox", "sandbox_api_base_url": BASE_URL,
            "sandbox_payout_base_url": PAYOUT_BASE_URL,
            "live_api_base_url": "", "live_payout_base_url": "",
            "catalog": default_catalog()}


def validate_base_url(value: str) -> str:
    """Accept only HTTPS AfribaPAY hosts; provider URLs are admin-controlled."""
    raw = str(value or "").strip()
    try:
        parsed = urlsplit(raw)
        hostname = (parsed.hostname or "").lower().rstrip(".")
    except ValueError as exc:
        raise ValueError("URL AfribaPAY invalide") from exc
    try:
        ipaddress.ip_address(hostname)
        is_ip = True
    except ValueError:
        is_ip = False
    if (parsed.scheme.lower() != "https" or not hostname
            or is_ip
            or (hostname != "afribapay.com"
                and not hostname.endswith(".afribapay.com"))
            or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("URL AfribaPAY invalide : un hôte HTTPS AfribaPAY est requis")
    return f"https://{hostname}"


def encrypt_secret(value: str, session_secret: str) -> str:
    from cryptography.fernet import Fernet

    if not session_secret:
        raise AfriPayError(500, "SESSION_SECRET is required to encrypt AfribaPAY credentials")
    key = base64.urlsafe_b64encode(
        hashlib.sha256(("afribapay:" + session_secret).encode()).digest())
    return Fernet(key).encrypt(value.encode()).decode()


def decrypt_secret(value: str, session_secret: str) -> str:
    from cryptography.fernet import Fernet, InvalidToken

    if not session_secret:
        raise AfriPayError(500, "SESSION_SECRET is required to decrypt AfribaPAY credentials")
    key = base64.urlsafe_b64encode(
        hashlib.sha256(("afribapay:" + session_secret).encode()).digest())
    try:
        return Fernet(key).decrypt(value.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        raise AfriPayError(500, "AfribaPAY credential cannot be decrypted")


def credentials_configured(config: dict) -> bool:
    return bool(config.get("api_user_encrypted")
                and config.get("api_key_encrypted")
                and config.get("merchant_key_encrypted")
                and config.get("agent_id_encrypted"))


def client_from_config(config: dict, timeout: float = 20) -> "AfriPayClient":
    """Build a client from the decrypted operational provider settings.

    Encrypted fields are intentionally not read here: server-side settings
    code must decrypt them before handing the short-lived values to this
    adapter.
    """
    mode = str(config.get("mode") or "sandbox").lower()
    if mode == "live":
        api_base_url = str(config.get("live_api_base_url") or "").strip()
        payout_base_url = str(config.get("live_payout_base_url") or "").strip()
        if not api_base_url or not payout_base_url:
            raise AfriPayError(503, "Les URL de production AfribaPAY doivent être configurées")
    else:
        api_base_url = str(config.get("sandbox_api_base_url") or BASE_URL)
        payout_base_url = str(config.get("sandbox_payout_base_url") or PAYOUT_BASE_URL)
    return AfriPayClient(
        str(config.get("_api_user") or ""),
        str(config.get("_api_key") or ""),
        str(config.get("_merchant_key") or ""),
        api_base_url,
        payout_base_url,
        timeout=timeout,
        agent_id=str(config.get("_agent_id") or ""),
    )


def status_value(payload: dict) -> str:
    data = payload.get("data") if isinstance(payload, dict) else {}
    value = (data.get("status") if isinstance(data, dict) else None)
    if value in (None, "") and isinstance(payload, dict):
        value = payload.get("status")
    return str(value or "").strip().lower()


class AfriPayClient:
    _token_cache: dict[str, tuple[str, float]] = {}

    def __init__(self, api_user: str, api_key: str, merchant_key: str = "",
                 api_base_url: str = BASE_URL, payout_base_url: str = PAYOUT_BASE_URL,
                 timeout: float = 20, agent_id: str = ""):
        self.api_user, self.api_key, self.merchant_key = api_user, api_key, merchant_key
        self.agent_id = agent_id
        self.api_base_url = (api_base_url or BASE_URL).rstrip("/")
        self.payout_base_url = (payout_base_url or PAYOUT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self._token_cache_key = hashlib.sha256(
            f"{self.api_base_url}\0{self.api_user}\0{self.api_key}".encode()
        ).hexdigest()

    async def _raw(self, method: str, url: str, **kwargs) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise AfriPayError(502, "AfribaPAY unreachable") from exc
        try:
            payload = response.json()
        except Exception:
            payload = {"message": response.text}
        if response.status_code >= 400:
            message = payload.get("message") if isinstance(payload, dict) else None
            raise AfriPayError(response.status_code, str(message or "AfribaPAY request failed"), payload)
        return payload if isinstance(payload, dict) else {"data": payload}

    async def token(self) -> str:
        cached = self._token_cache.get(self._token_cache_key)
        if cached and time.monotonic() < cached[1] - 30:
            return cached[0]
        payload = await self._raw("POST", f"{self.api_base_url}/v1/token",
                                  auth=(self.api_user, self.api_key),
                                  headers={"Content-Type": "application/json"})
        data = payload.get("data") or {}
        token = str(data.get("access_token") or "")
        if not token:
            raise AfriPayError(502, "AfribaPAY n'a pas fourni de jeton", payload)
        try:
            expires_in = float(data.get("expires_in") or 90000)
        except (TypeError, ValueError):
            expires_in = 90000
        if not math.isfinite(expires_in) or expires_in <= 0:
            expires_in = 90000
        expires_at = time.monotonic() + expires_in
        self._token_cache[self._token_cache_key] = (token, expires_at)
        return token

    async def _request(self, method: str, path: str, *, payout: bool = False,
                       params: Optional[dict] = None, body: Optional[dict] = None) -> dict:
        token = await self.token()
        return await self._raw(method, f"{self.payout_base_url if payout else self.api_base_url}{path}",
                               params=params, json=body,
                               headers={"Authorization": f"Bearer {token}",
                                        "Content-Type": "application/json",
                                        "Accept": "application/json"})

    async def payin(self, **data):
        if not self.merchant_key:
            raise AfriPayError(503, "AfribaPAY merchant key is not configured")
        data.setdefault("merchant_key", self.merchant_key)
        return await self._request("POST", "/v1/pay/payin", body=data)

    async def payout(self, **data):
        if not self.merchant_key:
            raise AfriPayError(503, "AfribaPAY merchant key is not configured")
        data.setdefault("merchant_key", self.merchant_key)
        return await self._request("POST", "/v1/pay/payout", payout=True, body=data)

    async def request_otp(self, **data):
        if not self.merchant_key:
            raise AfriPayError(503, "AfribaPAY merchant key is not configured")
        data.setdefault("merchant_key", self.merchant_key)
        return await self._request("POST", "/v1/pay/otp", body=data)

    async def status(self, *, order_id: str = "", transaction_id: str = ""):
        if not order_id and not transaction_id:
            raise AfriPayError(400, "Une référence AfribaPAY est requise")
        return await self._request("GET", "/v1/status",
                                   params={"order_id": order_id} if order_id else
                                   {"transaction_id": transaction_id})