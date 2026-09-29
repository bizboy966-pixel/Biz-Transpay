"""Isolated Mbiyo Mobile Money client and catalogue."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

import httpx

BASE_URL = "https://dashboard.mbiyo.africa/api/v1"
COUNTRY_LABELS = {
    "BF": "Burkina Faso", "BJ": "Bénin", "CI": "Côte d'Ivoire",
    "CM": "Cameroun", "CG": "Congo-Brazzaville", "ML": "Mali",
    "SN": "Sénégal", "TG": "Togo", "CD": "Congo-Kinshasa",
    "GM": "Gambie", "GN": "Guinée", "UG": "Ouganda", "TZ": "Tanzanie",
    "KE": "Kenya", "RW": "Rwanda", "GH": "Ghana", "NG": "Nigeria",
    "ZA": "Afrique du Sud", "ZM": "Zambie", "EG": "Égypte",
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
    "CD": ("vodacom", "airtel", "orange", "africell"),
    "GM": ("afrimoney", "qmoney", "wave", "aps"),
    "GN": ("orange", "mtn"), "UG": ("mtn", "airtel"),
    "TZ": ("vodacom", "airtel", "tigo", "halotel"),
    "KE": ("safaricom", "airtel"), "RW": ("mtn", "airtel"),
    "GH": ("mtn", "vodafone", "airtel", "tigo"),
    "NG": ("mtn", "airtel", "glo", "9mobile"),
    "ZA": ("eft",), "ZM": ("mtn", "airtel", "zamtel"), "EG": ("wallet",),
}
NETWORK_LABELS = {
    "orange": "Orange Money",
    "moov": "Moov Money",
    "coris": "Coris Money",
    "mtn": "MTN Mobile Money",
    "celtiis": "Celtiis Cash",
    "wave": "Wave",
    "free": "Free Money",
    "togocom": "TMoney", "vodacom": "Vodacom", "airtel": "Airtel",
    "africell": "Africell", "afrimoney": "Afrimoney", "qmoney": "QMoney",
    "aps": "APS", "safaricom": "Safaricom", "tigo": "Tigo",
    "halotel": "Halotel", "vodafone": "Vodafone", "glo": "Glo",
    "9mobile": "9Mobile", "zamtel": "Zamtel", "eft": "EFT",
    "wallet": "Mobile Wallet",
}
CURRENCIES = {
    "BF": ("XOF",), "BJ": ("XOF",), "CI": ("XOF",), "ML": ("XOF",),
    "SN": ("XOF",), "TG": ("XOF",), "CM": ("XAF",), "CG": ("XAF",),
    "CD": ("CDF", "USD"), "GM": ("GMD",), "GN": ("GNF",), "UG": ("UGX",),
    "TZ": ("TZS",), "KE": ("KES",), "RW": ("RWF",), "GH": ("GHS",),
    "NG": ("NGN",), "ZA": ("ZAR",), "ZM": ("ZMW", "USD"), "EG": ("EGP",),
}
LIMITS = {
    "BF": (500, 1500000), "BJ": (50, 1500000), "CI": (500, 1500000),
    "ML": (500, 1500000), "SN": (500, 1500000), "TG": (500, 1500000),
    "CM": (50, 1500000), "CG": (500, 1500000),
    "CD": (40, 5000000), "GM": (10, 200000), "GN": (500, 1500000),
    "UG": (500, 5000000), "TZ": (500, 5000000), "KE": (10, 70000),
    "RW": (100, 5000000), "GH": (0.01, 0), "NG": (0.01, 0),
    "ZA": (10, 50000), "ZM": (0.01, 0), "EG": (1, 50000),
}
CD_USD_LIMITS = (0.10, 2500)
ROUNDING_COUNTRIES = {"BF", "BJ", "CI", "CM", "GN", "ML", "TG"}


def normalize_amount(country: str, amount: float) -> float:
    value = Decimal(str(amount))
    if str(country).upper() in ROUNDING_COUNTRIES:
        value = (value / Decimal("5")).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * Decimal("5")
    return float(value)


def normalize_phone_number(country: str, phone_number: str) -> str:
    """Normalize Côte d'Ivoire numbers to the international form Mbiyo expects."""
    value = str(phone_number or "").strip()
    if str(country or "").upper() != "CI":
        return value
    if not re.fullmatch(r"[\d\s().+-]+", value):
        raise ValueError("Invalid Côte d'Ivoire mobile money phone number")

    digits = re.sub(r"\D", "", value)
    if digits.startswith("00"):
        digits = digits[2:]
    national_number = digits[3:] if digits.startswith("225") else digits
    if not re.fullmatch(r"\d{10}", national_number):
        raise ValueError("Invalid Côte d'Ivoire mobile money phone number")
    return f"+225{national_number}"


class MbiyoError(Exception):
    def __init__(self, status: int, message: str, raw: Any = None):
        self.status, self.message, self.raw = status, message, raw
        super().__init__(f"[{status}] {message}")


def default_catalog() -> list[dict]:
    rows = []
    for country, networks in NETWORKS.items():
        for currency in CURRENCIES[country]:
            minimum, maximum = LIMITS[country]
            if country == "CD" and currency == "USD":
                minimum, maximum = CD_USD_LIMITS
            for network in networks:
                suffix = f"-{currency.lower()}" if len(CURRENCIES[country]) > 1 else ""
                code_suffix = f"_{currency.lower()}" if len(CURRENCIES[country]) > 1 else ""
                # Gabon is intentionally absent: it is not in the official
                # merchant pay-in table and awaits API support.
                row_id = f"mbiyo-{country.lower()}-{network}{suffix}"
                rows.append({
                    "id": row_id, "provider": "mbiyo", "country": country,
                    "country_label": COUNTRY_LABELS[country],
                    "code": f"mbiyo_{network}_{country.lower()}{code_suffix}",
                    "network": network,
                    "name": (
                        f"{NETWORK_LABELS.get(network, network.upper())} ({currency})"
                        if len(CURRENCIES[country]) > 1
                        else NETWORK_LABELS.get(network, network.upper())
                    ),
                    "currency": currency, "active": True, "archived": False,
                    "hidden": False, "gateway_fee_pct": 0.0,
                    "gateway_fee_fixed": 0.0, "platform_fee_pct": 0.0,
                    "platform_fee_fixed": 0.0, "fee_pct": 0.0,
                    "min": minimum, "max": maximum,
                })
    return rows


def payment_flow(operator: dict, amount: Optional[float] = None) -> dict:
    """Provider-neutral instructions for the documented network flow."""
    country = str(operator.get("country") or "").upper()
    network = str(operator.get("network") or "").lower()
    ussd = {
        ("BF", "orange"): "*144*4*6*MONTANT#",
        ("CI", "orange"): "#144*82#",
        ("ML", "orange"): "#144#77#",
        ("SN", "orange"): "#144#391#",
        ("GN", "orange"): "#144#",
    }.get((country, network))
    if ussd:
        template = ussd
        if country == "BF" and network == "orange" and amount:
            ussd = f"*144*4*6*{int(round(float(amount)))}#"
        return {
            "kind": "ussd",
            "before_submit": True,
            "otp_required": False,
            "ussd_code": ussd,
            "ussd_template": template,
            "steps": [
                (f"Composez {ussd}, choisissez l’option 4 puis l’option 2 avant "
                 "de lancer le paiement." if country == "GN" else
                 f"Composez {ussd} sur votre téléphone avant de lancer le paiement."),
                ("Suivez le menu pour générer la demande."
                 if country == "GN" else
                 "Suivez le menu de votre opérateur pour autoriser la demande."),
                "Revenez ici : la confirmation sera vérifiée automatiquement.",
            ],
            "action_label": "J’ai autorisé la demande, lancer le paiement",
        }
    if country == "GM" and network in {"qmoney", "aps"}:
        return {
            "kind": "otp", "before_submit": False, "otp_required": True,
            "otp_label": "PIN de validation reçu après le lancement",
            "steps": ["Lancez le paiement.", "Saisissez le PIN demandé pour finaliser."],
            "action_label": "Finaliser le paiement",
        }
    return {
        "kind": "phone_confirmation",
        "before_submit": False,
        "otp_required": False,
        "steps": [
            "Lancez le paiement.",
            "Validez la notification reçue sur votre téléphone.",
        ],
        "action_label": "Valider sur mon téléphone",
    }


def default_config() -> dict:
    return {
        "id": "payment_provider_mbiyo", "enabled": True, "mode": "test",
        "setup_version": 3,
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
    """Return a normalized transaction status across Mbiyo response shapes."""
    if not isinstance(payload, dict):
        return ""
    containers = ("data", "result", "payload", "event", "transaction",
                  "transaction_data", "payment")
    candidates = []

    def collect(item: Any) -> None:
        if not isinstance(item, dict):
            return
        for key in containers:
            value = item.get(key)
            if isinstance(value, dict):
                collect(value)
            elif isinstance(value, list):
                for nested in value:
                    collect(nested)
        candidates.append(item)

    collect(payload)
    for item in candidates:
        for key in ("status", "state", "payment_status", "payment_state",
                    "transaction_status", "transaction_state", "status_code"):
            value = item.get(key)
            if value not in (None, "") and not isinstance(value, (dict, list)):
                return re.sub(r"[\s-]+", "_", str(value).strip().lower())
    return ""


SUCCESS_STATUSES = {
    "completed", "complete", "success", "successful", "sent", "paid", "succeeded",
    "approved", "confirmed", "validated", "settled", "successfully_completed",
    "processed", "paid_successfully", "payment_successful",
}
FAILURE_STATUSES = {
    "failed", "failure", "cancelled", "canceled", "rejected", "declined",
    "error", "refunded",
}


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

    async def wallets(self, currency: Optional[str] = None):
        """List the wallets available to the authenticated Mbiyo account.

        ``currency`` is sent only when a non-empty value is supplied.  Mbiyo
        accepts the provider's ISO currency code (for example ``XOF``).
        """
        value = str(currency).strip() if currency is not None else ""
        params = {"currency": value} if value else None
        return await self._request("GET", "/wallets", **({"params": params} if params else {}))

    async def balances(self, currency: Optional[str] = None):
        """Read wallet totals, optionally filtered by currency."""
        value = str(currency).strip() if currency is not None else ""
        params = {"currency": value} if value else None
        return await self._request("GET", "/balances", **({"params": params} if params else {}))

    async def network_balances(
        self,
        currency: Optional[str] = None,
        country_code: Optional[str] = None,
    ):
        """Read Mobile Money network balances.

        Both filters are optional and empty filters are omitted from the
        request so that Mbiyo can apply its default account scope.
        """
        params = {}
        currency_value = str(currency).strip() if currency is not None else ""
        country_value = str(country_code).strip() if country_code is not None else ""
        if currency_value:
            params["currency"] = currency_value
        if country_value:
            params["country_code"] = country_value
        return await self._request(
            "GET",
            "/balance/networks",
            **({"params": params} if params else {}),
        )

    async def balance_networks(
        self,
        currency: Optional[str] = None,
        country_code: Optional[str] = None,
    ):
        """Backward-compatible alias for :meth:`network_balances`."""
        return await self.network_balances(currency=currency, country_code=country_code)
