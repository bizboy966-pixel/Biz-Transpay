"""PayDunya SoftPay client and catalog.

This module deliberately contains no application state.  Credentials are
passed by the caller (the admin settings document is encrypted by server.py),
which makes it safe to use in tests and prevents secrets leaking into API
responses.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

import httpx

log = logging.getLogger("paydunya")

COUNTRY_LABELS = {
    "BJ": "Bénin", "BF": "Burkina Faso", "CI": "Côte d'Ivoire",
    "CM": "Cameroun", "GN": "Guinée", "ML": "Mali", "NE": "Niger", "SN": "Sénégal",
    "TG": "Togo",
}

# PayDunya's SoftPay catalogue.  The slug is the provider's documented
# ``operator`` value, not a FedaPay mode.  Togo is enabled by default because
# these are the operators currently used by Biz-transPay.
OPERATORS = [
    ("BJ", "mtn_bj", "MTN Bénin", "mtn-benin", "XOF"),
    ("BJ", "moov_bj", "Moov Bénin", "moov-benin", "XOF"),
    ("BJ", "celtiis_bj", "Celtiis Cash Bénin", "celtiis-cash", "XOF"),
    ("BF", "moov_bf", "Moov Burkina Faso", "moov-burkina", "XOF"),
    ("BF", "orange_bf", "Orange Burkina Faso", "orange-money-burkina", "XOF"),
    ("CI", "mtn_ci", "MTN Côte d'Ivoire", "mtn-ci", "XOF"),
    ("CI", "moov_ci", "Moov Côte d'Ivoire", "moov-ci", "XOF"),
    ("CI", "orange_ci", "Orange Côte d'Ivoire", "orange-money-ci", "XOF"),
    ("CI", "wave_ci", "Wave Côte d'Ivoire", "wave-ci", "XOF"),
    ("CM", "mtn_cm", "MTN Cameroun", "mtn-cameroun", "XAF"),
    ("ML", "orange_ml", "Orange Mali", "orange-money-mali", "XOF"),
    ("ML", "moov_ml", "Moov Mali", "moov-mali", "XOF"),
    ("SN", "orange_sn", "Orange Sénégal", "new-orange-money-senegal", "XOF"),
    ("SN", "free_sn", "Free Money Sénégal", "free-money-senegal", "XOF"),
    ("SN", "expresso_sn", "Expresso Sénégal", "expresso-senegal", "XOF"),
    ("SN", "wave_sn", "Wave Sénégal", "wave-senegal", "XOF"),
    ("SN", "wizall_sn", "Wizall Sénégal", "wizall-money-senegal", "XOF"),
    ("SN", "djamo_sn", "Djamo Sénégal", "djamo", "XOF"),
    ("CI", "djamo_ci", "Djamo Côte d'Ivoire", "djamo", "XOF"),
    ("TG", "togocel_tg", "TogoCom (T-Money)", "t-money-togo", "XOF"),
    ("TG", "moov_tg", "Moov Togo", "moov-togo", "XOF"),
]

# PayDunya disbursement modes are deliberately separate from the historical
# SoftPay catalogue above.  The value is sent verbatim as ``withdraw_mode``;
# it is not a FedaPay mode and must not be inferred from a frontend label.
WITHDRAWAL_OPERATORS = [
    ("SN", "orange-money-senegal", "Orange Money Sénégal", "XOF"),
    ("SN", "free-money-senegal", "Free Money Sénégal", "XOF"),
    ("SN", "wave-senegal", "Wave Sénégal", "XOF"),
    ("BJ", "mtn-benin", "MTN Bénin", "XOF"),
    ("BJ", "moov-benin", "Moov Bénin", "XOF"),
    ("BJ", "celtiis-cash", "Celtiis Cash", "XOF"),
    ("CI", "mtn-ci", "MTN Côte d'Ivoire", "XOF"),
    ("CI", "orange-money-ci", "Orange Money Côte d'Ivoire", "XOF"),
    ("CI", "moov-ci", "Moov Côte d'Ivoire", "XOF"),
    ("CI", "wave-ci", "Wave Côte d'Ivoire", "XOF"),
    ("TG", "t-money-togo", "T-Money Togo", "XOF"),
    ("TG", "moov-togo", "Moov Togo", "XOF"),
    ("ML", "orange-money-mali", "Orange Money Mali", "XOF"),
    ("BF", "orange-money-burkina", "Orange Money Burkina Faso", "XOF"),
    ("BF", "moov-burkina-faso", "Moov Burkina Faso", "XOF"),
    ("CM", "mtn-cameroun", "MTN Cameroun", "XAF"),
]
WITHDRAWAL_MODES = tuple(item[1] for item in WITHDRAWAL_OPERATORS)
COUNTRY_DIAL_CODES = {
    "BJ": "229", "BF": "226", "CI": "225", "CM": "237",
    "ML": "223", "SN": "221", "TG": "228",
}


class PayDunyaError(Exception):
    def __init__(self, status: int, message: str, raw: Optional[dict] = None):
        self.status, self.message, self.raw = status, message, raw or {}
        super().__init__(f"[{status}] {message}")


def payment_flow(operator: dict, amount: Optional[float] = None) -> dict:
    """Return provider-neutral customer instructions for a SoftPay operator."""
    slug = str(operator.get("endpoint_slug") or "").lower()
    flow = {
        "kind": "phone_confirmation",
        "before_submit": False,
        "otp_required": False,
        "steps": [
            "Saisissez votre numéro Mobile Money.",
            "Lancez le paiement puis validez la notification sur votre téléphone.",
        ],
        "action_label": "Valider sur mon téléphone",
    }
    if slug == "moov-burkina":
        return {
            "kind": "ussd_confirmation",
            "before_submit": False,
            "otp_required": False,
            "ussd_code": "*555*6#",
            "instructions": (
                "Composez *555*6# depuis le numéro Moov Money utilisé pour ce "
                "dépôt, puis suivez le menu pour confirmer le paiement. "
                "Revenez ici pour suivre sa confirmation."
            ),
            "steps": [
                "Lancez le paiement sur cette page.",
                "Composez *555*6# depuis le numéro Moov Money du dépôt.",
                "Suivez le menu pour confirmer, puis revenez ici pour suivre le paiement.",
            ],
            "action_label": "Confirmer avec le code USSD",
        }
    if slug == "orange-money-ci":
        return {
            "kind": "otp",
            "before_submit": True,
            "otp_required": True,
            "otp_label": "Code généré par le menu USSD",
            "ussd_code": "#144*82#",
            "steps": [
                "Composez #144*82# sur votre téléphone.",
                "Choisissez l'option 2 pour générer le code de paiement.",
                "Copiez le code généré dans le champ OTP, puis lancez le paiement.",
            ],
            "action_label": "J’ai mon code, lancer le paiement",
        }
    if slug == "orange-money-burkina":
        value = int(round(float(amount or 0)))
        code = f"*144*4*6*{value}#" if value else "*144*4*6*MONTANT#"
        return {
            "kind": "otp",
            "before_submit": True,
            "otp_required": True,
            "otp_label": "Code généré par le menu USSD",
            "ussd_code": code,
            "ussd_template": "*144*4*6*{amount}#",
            "steps": [
                f"Composez {code} sur votre téléphone.",
                "Suivez le menu pour générer le code de paiement.",
                "Copiez le code généré dans le champ OTP, puis lancez le paiement.",
            ],
            "action_label": "J’ai mon code, lancer le paiement",
        }
    if slug == "new-orange-money-senegal":
        return {
            "kind": "redirect",
            "before_submit": False,
            "otp_required": False,
            "steps": ["Ouvrez le lien ou le QR code affiché après le lancement.",
                      "Validez le paiement dans votre espace opérateur."],
            "action_label": "Ouvrir le paiement",
        }
    if slug == "wizall-money-senegal":
        return {
            "kind": "otp",
            "before_submit": False,
            "otp_required": True,
            "otp_label": "Code d’autorisation reçu sur votre téléphone",
            "steps": ["Lancez la demande sur votre téléphone.",
                      "Saisissez le code d’autorisation reçu pour finaliser."],
            "action_label": "Finaliser le paiement",
        }
    if slug in {"djamo", "djamo-sn", "djamo-ci"}:
        flow.update({
            "kind": "redirect",
            "steps": ["Ouvrez le lien de confirmation affiché après le lancement.",
                      "Validez le paiement dans l’application ou la page sécurisée."],
            "action_label": "Ouvrir la confirmation",
        })
    return flow


def default_catalog() -> list[dict]:
    return [{
        "country": country,
        "country_label": COUNTRY_LABELS[country],
        "code": code,
        "name": name,
        "currency": currency,
        "endpoint_slug": slug,
        "active": country == "TG",
        "archived": False,
        "hidden": False,
        "gateway_fee_pct": 0.0,
        "gateway_fee_fixed": 0.0,
        "platform_fee_pct": 0.0,
        "platform_fee_fixed": 0.0,
        "fee_pct": 0.0,
        "min": 100 if currency == "XOF" else 1000,
        "max": 500000 if currency == "XOF" else 5000000,
    } for country, code, name, slug, currency in OPERATORS
      if currency in {"XOF", "XAF"}]


def default_withdrawal_catalog() -> list[dict]:
    """Return the server-side PayDunya payout operator catalogue.

    This is intentionally a new catalogue rather than a mutation of the
    pay-in catalogue.  Deployments can therefore change collection operators
    without accidentally changing where withdrawals are sent.
    """
    return [{
        "country": country,
        "country_label": COUNTRY_LABELS[country],
        "code": mode,
        "name": name,
        "currency": currency,
        "withdraw_mode": mode,
        "active": country == "TG",
        "archived": False,
        "hidden": False,
        "gateway_fee_pct": 0.0,
        "gateway_fee_fixed": 0.0,
        "platform_fee_pct": 0.0,
        "platform_fee_fixed": 0.0,
        "fee_pct": 0.0,
        "min": 100 if currency == "XOF" else 1000,
        "max": 500000 if currency == "XOF" else 5000000,
    } for country, mode, name, currency in WITHDRAWAL_OPERATORS]


PAY_IN_MODES = ("softpay_direct", "psr", "par_redirect")


def default_modes() -> dict[str, dict[str, bool]]:
    """Return independent server-side switches for each Pay-in flow.

    Keep the switches nested in the provider setting so adding a new
    PayDunya flow never accidentally enables it for an existing deployment.
    Existing installations pre-dating the switches are handled explicitly by
    ``mode_is_enabled`` (only their historical SoftPay flow remains active).
    """
    return {
        "softpay_direct": {"enabled": True},
        "psr": {"enabled": False},
        "par_redirect": {"enabled": False},
    }


def mode_is_enabled(config: dict, mode: str) -> bool:
    """Whether a Pay-in mode can be used with this provider configuration."""
    if mode not in PAY_IN_MODES or not config.get("enabled", False):
        return False
    modes = config.get("modes")
    # Legacy documents had no mode switches.  Preserve their SoftPay
    # behaviour while requiring explicit switches once `modes` is present.
    if modes is None:
        return mode == "softpay_direct"
    entry = modes.get(mode) if isinstance(modes, dict) else None
    return bool(entry.get("enabled", False)) if isinstance(entry, dict) else bool(entry)


def derive_fernet_key(secret: str) -> bytes:
    if not secret or not str(secret).strip():
        raise PayDunyaError(500, "SESSION_SECRET must be configured")
    return base64.urlsafe_b64encode(hashlib.sha256((secret or "").encode()).digest())


def encrypt_secret(value: str, session_secret: str) -> str:
    from cryptography.fernet import Fernet
    return Fernet(derive_fernet_key(session_secret)).encrypt(value.encode()).decode()


def decrypt_secret(value: str, session_secret: str) -> str:
    from cryptography.fernet import Fernet, InvalidToken
    try:
        return Fernet(derive_fernet_key(session_secret)).decrypt(value.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        raise PayDunyaError(500, "PayDunya credential cannot be decrypted")


def credentials(config: dict, session_secret: str) -> dict:
    out = {}
    if any(config.get(f"{key}_encrypted") for key in
           ("master_key", "public_key", "private_key", "token")):
        derive_fernet_key(session_secret)
    for key in ("master_key", "public_key", "private_key", "token"):
        encrypted = config.get(f"{key}_encrypted")
        if encrypted:
            out[key] = decrypt_secret(encrypted, session_secret)
    return out


def static_hash(master_key: str) -> str:
    return hashlib.sha512((master_key or "").encode()).hexdigest()


def verify_static_hash(provided: str, master_key: str) -> bool:
    return bool(provided) and hmac.compare_digest(
        str(provided).strip().lower(), static_hash(master_key).lower())


def normalize_togo_phone(phone: str) -> str:
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if digits.startswith("228"):
        digits = digits[3:]
    if digits.startswith("00"):
        digits = digits[2:]
        if digits.startswith("228"):
            digits = digits[3:]
    if len(digits) != 8 or not digits.startswith(("7", "9")):
        raise ValueError("Numéro Togo invalide (8 chiffres attendus)")
    return digits


def normalize_softpay_phone(phone: str, country: str, endpoint_slug: str) -> str:
    """Normalize Burkina SoftPay MSISDNs to PayDunya's documented local form."""
    country = str(country or "").strip().upper()
    endpoint_slug = str(endpoint_slug or "").strip().lower()
    if country != "BF" or endpoint_slug not in {
            "moov-burkina", "orange-money-burkina"}:
        return phone
    digits = "".join(ch for ch in str(phone or "") if ch in "0123456789")
    if digits.startswith("00"):
        digits = digits[2:]
    dial_code = COUNTRY_DIAL_CODES["BF"]
    if digits.startswith(dial_code):
        digits = digits[len(dial_code):]
    if len(digits) != 8:
        raise ValueError(
            "Le numéro Mobile Money du Burkina Faso doit comporter "
            "8 chiffres locaux, sans le préfixe +226.")
    return digits


def normalize_disbursement_account_alias(phone: str, country: str) -> str:
    """Return the local Mobile Money number expected by PayDunya PUSH."""
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if digits.startswith("00"):
        digits = digits[2:]
    dial = COUNTRY_DIAL_CODES.get((country or "").upper(), "")
    if dial and digits.startswith(dial):
        digits = digits[len(dial):]
    if not 6 <= len(digits) <= 12:
        raise ValueError("Numéro Mobile Money invalide")
    return digits


def calculate_fees(amount: float, operator: dict, bearer: str) -> dict:
    """Return an immutable fee snapshot.

    ``client``/``sender`` means the invoice is grossed up and the wallet
    receives the requested amount. ``receiver``/``merchant`` means the invoice
    stays at the requested amount and the fees are deducted from the wallet
    credit.
    """
    currency = str(operator.get("currency") or "XOF").upper()
    places = Decimal("1") if currency in {"XOF", "XAF", "GNF"} else Decimal("0.01")
    quantize = lambda value: Decimal(str(value)).quantize(places, rounding=ROUND_HALF_UP)
    amount_d = quantize(amount)
    gateway_pct = operator.get("gateway_fee_pct")
    if gateway_pct is None or (
        float(gateway_pct or 0) == 0
        and float(operator.get("platform_fee_pct", 0) or 0) == 0
        and operator.get("fee_pct") is not None
    ):
        gateway_pct = operator.get("fee_pct", 0)
    gateway_fixed = float(operator.get("gateway_fee_fixed", 0) or 0)
    platform_fixed = float(operator.get("platform_fee_fixed", 0) or 0)
    if (gateway_fixed == 0 and platform_fixed == 0
            and operator.get("fee_fixed") is not None):
        gateway_fixed = float(operator.get("fee_fixed", 0) or 0)
    gateway = quantize(
        amount_d * Decimal(str(gateway_pct)) / Decimal("100")
        + Decimal(str(gateway_fixed)))
    platform = quantize(
        amount_d * Decimal(str(operator.get("platform_fee_pct", 0))) / Decimal("100")
        + Decimal(str(platform_fixed)))
    total = quantize(gateway + platform)
    client_pays = bearer in ("client", "sender")
    charged = quantize(amount_d + total) if client_pays else amount_d
    wallet_credit = amount_d if client_pays else quantize(amount_d - total)
    if wallet_credit <= 0:
        raise PayDunyaError(
            400, "Les frais doivent être inférieurs au montant du dépôt")
    return {
        "requested_amount": float(amount_d), "charged_amount": float(charged),
        "gateway_fee": float(gateway), "platform_fee": float(platform),
        "total_fee": float(total), "fee_bearer": "client" if client_pays else "merchant",
        "wallet_credit_amount": float(wallet_credit),
    }


def _base_url(mode: str) -> str:
    return ("https://app.paydunya.com" if mode == "live"
            else "https://app.paydunya.com").rstrip("/")


async def _request(method: str, path: str, config: dict, body: Optional[dict] = None) -> dict:
    creds = config.get("_credentials") or {}
    missing = [k for k in ("master_key", "private_key", "token") if not creds.get(k)]
    if missing:
        raise PayDunyaError(503, "PayDunya credentials are not configured")
    headers = {
        "PAYDUNYA-MASTER-KEY": creds["master_key"],
        "PAYDUNYA-PRIVATE-KEY": creds["private_key"],
        "PAYDUNYA-TOKEN": creds["token"],
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.request(method, _base_url(config.get("mode", "test")) + path,
                                            json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise PayDunyaError(502, f"PayDunya unreachable: {exc}")
    try:
        payload = response.json()
    except Exception:
        payload = {"response_text": response.text}
    if response.status_code >= 400:
        raw_message = str(
            payload.get("message") or payload.get("response_text")
            or "PayDunya error"
        )
        if "<html" in raw_message.lower() or len(raw_message) > 300:
            raw_message = f"PayDunya returned HTTP {response.status_code}"
        raise PayDunyaError(response.status_code,
                            raw_message, payload)
    return payload if isinstance(payload, dict) else {"data": payload}


async def get_balance(config: dict) -> dict:
    """Read the configured PayDunya account balances.

    PayDunya documents this endpoint as approximate; callers must label the
    returned values accordingly rather than presenting them as exact funds.
    """
    return await _request("GET", "/api/v2/disburse/check-balance", config)


async def create_invoice(config: dict, *, amount: float, currency: str,
                         token: str, customer: dict, callback_url: str,
                         description: str = "", return_url: str = "",
                         cancel_url: str = "") -> dict:
    actions = {"callback_url": callback_url}
    if return_url:
        actions["return_url"] = return_url
    if cancel_url:
        actions["cancel_url"] = cancel_url
    body = {
        "invoice": {"total_amount": amount, "description": description},
        "store": {"name": config.get("store_name") or "Biz-transPay"},
        "actions": actions,
        # PayDunya's confirmation response does not expose a top-level
        # currency. Custom data is returned under the provider-signed hash, so
        # keep the expected currency and amount there for strict reconciliation.
        "custom_data": {
            "biztranspay_token": token,
            "biztranspay_currency": currency.upper(),
            "biztranspay_amount": str(amount),
        },
        "customer": customer,
    }
    return await _request("POST", "/sandbox-api/v1/checkout-invoice/create"
                          if config.get("mode") != "live"
                          else "/api/v1/checkout-invoice/create", config, body)


def invoice_token(invoice: dict) -> str:
    """Extract a token from all documented PayDunya response envelopes."""
    if not isinstance(invoice, dict):
        return ""
    response = invoice.get("response")
    nested = response if isinstance(response, dict) else {}
    details = invoice.get("invoice")
    details = details if isinstance(details, dict) else {}
    nested_details = nested.get("invoice")
    nested_details = nested_details if isinstance(nested_details, dict) else {}
    return str(invoice.get("token") or invoice.get("invoice_token")
               or nested.get("token") or nested.get("invoice_token")
               or details.get("token") or nested_details.get("token") or "")


def checkout_url(invoice: Any) -> str:
    """Extract a hosted checkout URL from PayDunya's varied envelopes."""
    if isinstance(invoice, dict):
        for key in ("checkout_url", "url", "payment_url", "redirect_url"):
            value = invoice.get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                return value
        for value in invoice.values():
            found = checkout_url(value)
            if found:
                return found
    elif isinstance(invoice, (list, tuple)):
        for value in invoice:
            found = checkout_url(value)
            if found:
                return found
    elif isinstance(invoice, str):
        match = re.search(r"https?://[^\s\"'<>]+", invoice)
        if match:
            return match.group(0).rstrip(".,;)")
    return ""


async def softpay_payment(config: dict, *, invoice_token: str, operator: dict,
                          phone: str, amount: float, currency: str,
                          customer_name: str = "",
                          customer_email: str = "", otp: str = "") -> dict:
    slug = (operator.get("endpoint_slug") or "").lower()
    if config.get("mode") != "live":
        test_customer = config.get("_sandbox_customer") or {}
        missing = [
            key for key in ("phone", "email", "password")
            if not test_customer.get(key)
        ]
        if missing:
            raise PayDunyaError(
                503,
                "PayDunya sandbox test customer is not configured",
            )
        return await _request(
            "POST",
            "/sandbox-api/v1/softpay/checkout/make-payment",
            config,
            {
                "phone_phone": test_customer["phone"],
                "customer_email": test_customer["email"],
                "password": test_customer["password"],
                "invoice_token": invoice_token,
            },
        )
    if slug == "orange-money-ci":
        body = {
            "orange_money_ci_customer_fullname": customer_name,
            "orange_money_ci_email": customer_email,
            "orange_money_ci_phone_number": phone,
            "orange_money_ci_otp": otp,
            "payment_token": invoice_token,
        }
    elif slug == "orange-money-burkina":
        body = {"name_bf": customer_name, "email_bf": customer_email,
                "phone_bf": phone, "otp_code": otp,
                "payment_token": invoice_token}
    elif slug == "new-orange-money-senegal":
        body = {"customer_name": customer_name, "customer_email": customer_email,
                "phone_number": phone, "invoice_token": invoice_token}
    elif slug in {"djamo", "djamo-sn", "djamo-ci"}:
        country = str(operator.get("country") or "").lower()
        body = {"djamo_fullName": customer_name, "djamo_email": customer_email,
                "djamo_phone": phone, "code_country": country,
                "djamo_payment_token": invoice_token}
    elif slug == "wizall-money-senegal":
        body = {"customer_name": customer_name, "customer_email": customer_email,
                "phone_number": phone, "invoice_token": invoice_token}
    elif slug == "t-money-togo":
        body = {"name_t_money": customer_name, "email_t_money": customer_email,
                "phone_t_money": phone, "payment_token": invoice_token}
    elif slug == "moov-togo":
        body = {"moov_togo_customer_fullname": customer_name,
                "moov_togo_email": customer_email,
                "moov_togo_customer_address": "Togo",
                "moov_togo_phone_number": phone, "payment_token": invoice_token}
    elif slug == "free-money-senegal":
        body = {"customer_name": customer_name, "customer_email": customer_email,
                "phone_number": phone, "payment_token": invoice_token}
    elif slug == "expresso-senegal":
        body = {"expresso_sn_fullName": customer_name, "expresso_sn_email": customer_email,
                "expresso_sn_phone": phone, "payment_token": invoice_token}
    elif slug == "wave-senegal":
        body = {"wave_senegal_fullName": customer_name, "wave_senegal_email": customer_email,
                "wave_senegal_phone": phone, "wave_senegal_payment_token": invoice_token}
    elif slug == "celtiis-cash":
        body = {"celtiis_cash_customer_fullname": customer_name,
                "celtiis_cash_customer_email": customer_email,
                "celtiis_cash_phone_number": phone, "payment_token": invoice_token}
    elif slug == "mtn-ci":
        body = {"mtn_ci_customer_fullname": customer_name, "mtn_ci_email": customer_email,
                "mtn_ci_phone_number": phone, "mtn_ci_wallet_provider": "MTNCI",
                "payment_token": invoice_token}
    elif slug == "moov-ci":
        body = {"moov_ci_customer_fullname": customer_name, "moov_ci_email": customer_email,
                "moov_ci_phone_number": phone, "payment_token": invoice_token}
    elif slug == "wave-ci":
        body = {"wave_ci_fullName": customer_name, "wave_ci_email": customer_email,
                "wave_ci_phone": phone, "wave_ci_payment_token": invoice_token}
    elif slug == "moov-burkina":
        body = {"moov_burkina_faso_fullName": customer_name,
                "moov_burkina_faso_email": customer_email,
                "moov_burkina_faso_phone_number": phone,
                "moov_burkina_faso_payment_token": invoice_token}
    elif slug == "moov-benin":
        body = {"moov_benin_customer_fullname": customer_name,
                "moov_benin_email": customer_email,
                "moov_benin_phone_number": phone, "payment_token": invoice_token}
    elif slug == "mtn-benin":
        body = {"mtn_benin_customer_fullname": customer_name,
                "mtn_benin_email": customer_email,
                "mtn_benin_phone_number": phone,
                "mtn_benin_wallet_provider": "MTNBENIN",
                "payment_token": invoice_token}
    elif slug == "orange-money-mali":
        body = {"orange_money_mali_customer_fullname": customer_name,
                "orange_money_mali_email": customer_email,
                "orange_money_mali_phone_number": phone,
                "orange_money_mali_customer_address": "Mali",
                "payment_token": invoice_token}
    elif slug == "moov-mali":
        body = {"moov_ml_customer_fullname": customer_name,
                "moov_ml_email": customer_email, "moov_ml_phone_number": phone,
                "moov_ml_customer_address": "Mali", "payment_token": invoice_token}
    elif slug == "mtn-cameroun":
        body = {"mtn_cameroun_customer_fullname": customer_name,
                "mtn_cameroun_email": customer_email,
                "mtn_cameroun_phone_number": phone,
                "mtn_cameroun_wallet_provider": "MTNCAMEROUN",
                "payment_token": invoice_token}
    else:
        raise PayDunyaError(400, "Opérateur Mobile Money non pris en charge")
    result = await _request("POST", f"/api/v1/softpay/{slug}", config, body)
    if slug == "moov-burkina" and result.get("success") is False:
        raise PayDunyaError(
            400, str(result.get("message") or "La demande Mobile Money a été refusée"),
            result,
        )
    return result


async def wizall_confirm(config: dict, *, authorization_code: str,
                         phone: str, transaction_id: str) -> dict:
    return await _request(
        "POST", "/api/v1/softpay/wizall-money-senegal/confirm", config,
        {"authorization_code": authorization_code, "phone_number": phone,
         "transaction_id": transaction_id},
    )


async def get_disbursement_invoice(config: dict, *, amount: float,
                                   currency: str, withdraw_mode: str,
                                   account_alias: str, callback_url: str,
                                   description: str = "",
                                   reference: str = "") -> dict:
    """Create a PayDunya v2 disbursement invoice.

    Credentials are taken from the same provider configuration as pay-ins.
    No transfer configuration field is read here other than the operator
    mode and the limits/fees already resolved by the caller.
    """
    # PayDunya PUSH v2 expects these fields at the root. Currency,
    # description and merchant reference are not accepted by get-invoice.
    body = {
        "account_alias": account_alias,
        "amount": int(Decimal(str(amount)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)),
        "withdraw_mode": withdraw_mode,
        "callback_url": callback_url,
    }
    response = await _request(
        "POST", "/api/v2/disburse/get-invoice", config, body)
    code = str(response.get("response_code", "")).zfill(2)
    if code != "00":
        message = str(response.get("response_text") or response.get("message")
                      or "PayDunya a refusé la création du retrait")
        if code == "4002":
            message = (
                "L’URL de callback n’est pas accessible par PayDunya. "
                "Utilisez l’application publiée, pas la prévisualisation.")
        raise PayDunyaError(
            400,
            message,
            response,
        )
    return response


async def submit_disbursement_invoice(config: dict, *, invoice_token: str,
                                      withdraw_mode: str,
                                      account_alias: str,
                                      amount: float,
                                      currency: str,
                                      callback_url: str = "",
                                      reference: str = "") -> dict:
    body = {"disburse_invoice": invoice_token}
    if reference:
        body["disburse_id"] = reference
    response = await _request(
        "POST", "/api/v2/disburse/submit-invoice", config, body)
    code = str(response.get("response_code", "")).zfill(2)
    if code != "00":
        raise PayDunyaError(
            400,
            str(response.get("response_text") or response.get("message")
                or "PayDunya a refusé le retrait"),
            response,
        )
    return response


async def check_disbursement_status(config: dict, *, invoice_token: str = "",
                                    provider_id: str = "") -> dict:
    if not invoice_token:
        raise PayDunyaError(400, "Référence PayDunya de retrait manquante")
    body = {"disburse_invoice": invoice_token}
    response = await _request(
        "POST", "/api/v2/disburse/check-status", config, body)
    code = str(response.get("response_code", "")).zfill(2)
    if code != "00":
        raise PayDunyaError(
            400,
            str(response.get("response_text") or response.get("message")
                or "Statut PayDunya indisponible"),
            response,
        )
    return response


# Short aliases make the provider API convenient to use from reconciliation
# jobs while retaining the explicit names above for callers and tests.
create_disbursement_invoice = get_disbursement_invoice
submit_disbursement = submit_disbursement_invoice
check_status = check_disbursement_status
get_disburse_invoice = get_disbursement_invoice
submit_invoice = submit_disbursement_invoice


def disbursement_token(response: dict) -> str:
    """Extract the invoice token from PayDunya's varied response envelopes."""
    if not isinstance(response, dict):
        return ""
    for key in ("token", "invoice_token", "disburse_token", "disbursement_token"):
        if response.get(key):
            return str(response[key])
    for value in response.values():
        if isinstance(value, dict):
            found = disbursement_token(value)
            if found:
                return found
    return ""


def disbursement_provider_id(response: dict) -> str:
    if not isinstance(response, dict):
        return ""
    for key in ("id", "invoice_id", "disburse_id", "disburse_tx_id",
                "disbursement_id", "transaction_id"):
        if response.get(key) is not None:
            return str(response[key])
    for value in response.values():
        if isinstance(value, dict):
            found = disbursement_provider_id(value)
            if found:
                return found
    return ""


async def confirm_invoice(config: dict, token: str) -> dict:
    path = (f"/sandbox-api/v1/checkout-invoice/confirm/{token}"
            if config.get("mode") != "live"
            else f"/api/v1/checkout-invoice/confirm/{token}")
    return await _request("GET", path, config)


def confirmation_valid(response: dict, *, master_key: str, token: str,
                       amount: float, currency: str,
                       deposit_id: str = "") -> bool:
    data = response.get("response") if isinstance(response.get("response"), dict) else response
    invoice = data.get("invoice") if isinstance(data.get("invoice"), dict) else {}
    custom = data.get("custom_data") if isinstance(data.get("custom_data"), dict) else {}
    code_value = (data.get("response_code") if "response_code" in data else
                  data.get("responseCode") if "responseCode" in data else
                  response.get("response_code", ""))
    code = str(code_value).zfill(2)
    status = str(data.get("status") or invoice.get("status") or "").lower()
    returned_token = str(data.get("token") or data.get("invoice_token")
                         or invoice.get("token") or "")
    returned_amount = (
        data.get("amount")
        or data.get("total_amount")
        or invoice.get("total_amount")
        # The confirmation endpoint may omit the duplicated amount while
        # preserving the signed custom data sent with the invoice.
        or custom.get("biztranspay_amount")
    )
    currency_value = (data.get("currency") or invoice.get("currency")
                      or custom.get("biztranspay_currency") or "")
    if isinstance(currency_value, dict):
        currency_value = (currency_value.get("iso")
                          or currency_value.get("code") or "")
    returned_currency = str(currency_value).upper()
    returned_deposit_id = str(custom.get("biztranspay_token") or "")
    supplied_hash = data.get("hash") or invoice.get("hash") or response.get("hash")
    try:
        amount_ok = abs(float(returned_amount) - float(amount)) < 0.005
    except (TypeError, ValueError):
        amount_ok = False
    # PayDunya does not return custom_data consistently from the confirmation
    # endpoint. The invoice token is already bound to the deposit server-side,
    # so an omitted custom identity is compatible; a conflicting identity is
    # still rejected.
    identity_ok = (
        not deposit_id
        or not returned_deposit_id
        or hmac.compare_digest(returned_deposit_id, str(deposit_id))
    )
    # PayDunya checkout invoices are denominated in FCFA and their confirmation
    # endpoint may omit currency. Accept that historical XOF shape only when
    # the provider token, amount, and static hash have passed validation.
    currency_ok = (returned_currency == currency.upper() or
                   (not returned_currency and currency.upper() == "XOF"
                    and bool(deposit_id) and identity_ok))
    return (code == "00" and status in {
                "completed", "paid", "success", "successful"
            } and
            hmac.compare_digest(returned_token, str(token)) and amount_ok and
            currency_ok and identity_ok and
            verify_static_hash(supplied_hash, master_key))


def parse_webhook(form: dict) -> tuple[dict, str]:
    """Parse PayDunya's form webhook and return (payload, static hash)."""
    # PHP-style form encoding preserves bracketed names in Starlette:
    # data[hash], data[invoice][token], etc. Decode the documented envelope
    # before signature validation; never treat a missing signature as valid.
    if "data" not in form:
        nested = {}
        for key, value in form.items():
            if not isinstance(key, str) or not re.fullmatch(r"data(?:\[[^\[\]]+\])+", key):
                continue
            path = re.findall(r"\[([^\[\]]+)\]", key)
            if len(path) > 8 or any(len(part) > 128 for part in path):
                raise ValueError("Invalid PayDunya form nesting")
            node = nested
            for part in path[:-1]:
                if part not in node:
                    node[part] = {}
                if not isinstance(node[part], dict):
                    raise ValueError("Conflicting PayDunya form fields")
                node = node[part]
            if path[-1] in node:
                raise ValueError("Conflicting PayDunya form fields")
            node[path[-1]] = value
        if nested:
            form = {**form, "data": nested}
    supplied = str(form.get("hash") or form.get("HASH") or form.get("signature") or "")
    raw = form.get("data") or form.get("payload") or form.get("response") or form
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {"raw": raw}
    payload = raw if isinstance(raw, dict) else {"data": raw}
    return payload, supplied or str(payload.get("hash") or "")