"""Pydantic models for Biz-transPay."""
from pydantic import BaseModel, Field, EmailStr, ConfigDict
from typing import Optional, List, Literal
from datetime import datetime, timezone
import uuid


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def new_id():
    return str(uuid.uuid4())


# ---------- Auth ----------
class RegisterRequest(BaseModel):
    full_name: str = Field(..., min_length=1, max_length=120)
    username: str = Field(..., min_length=6, max_length=50)
    account_type: Literal["personal", "merchant"]
    country: str = Field(..., min_length=2, max_length=3)
    phone: str = Field(..., min_length=3, max_length=40)
    email: EmailStr
    password: str
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


class LoginRequest(BaseModel):
    email: str  # accepts email or username
    password: str
    otp: Optional[str] = None
    mfa_token: Optional[str] = None
    challenge_id: Optional[str] = None
    challenge_solution: Optional[str] = None
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


class ReauthenticationRequest(BaseModel):
    current_password: str
    otp: Optional[str] = None


class TwoFactorCodeRequest(BaseModel):
    code: str
    setup_token: Optional[str] = None


class TwoFactorDisableRequest(BaseModel):
    current_password: str
    code: str


class PasswordRecoveryRequest(BaseModel):
    identifier: str
    recovery_code: str
    new_password: str
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


class PasswordResetRequest(BaseModel):
    email: EmailStr
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


class PasswordResetConfirm(BaseModel):
    token: str = Field(..., min_length=32, max_length=128)
    new_password: str = Field(..., min_length=1, max_length=72)
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


class TransactionEmailSettingsUpdate(BaseModel):
    enabled: bool = False
    withdrawal_otp_enabled: Optional[bool] = None
    sender_email: Optional[EmailStr] = None
    event_types: List[Literal[
        "deposit_confirmed", "withdrawal_success", "payment_final"
    ]] = Field(default_factory=list, max_length=3)
    content_fields: List[Literal[
        "event_status", "amount_currency", "reference", "event_time"
    ]] = Field(default_factory=list, max_length=4)


class TransferOtpCancelRequest(BaseModel):
    challenge_id: str = Field(..., min_length=1, max_length=128)


class UserPublic(BaseModel):
    id: str
    full_name: str
    username: str
    account_type: str
    country: str
    phone: str
    email: str
    kyc_status: str  # not_started | pending | verified | rejected
    balance_xof: float
    balance_xaf: float
    balance_usdt: float = 0.0
    balance_cdf: float = 0.0
    balance_usd: float = 0.0
    balance_gmd: float = 0.0
    balance_gnf: float = 0.0
    balance_ugx: float = 0.0
    balance_tzs: float = 0.0
    balance_kes: float = 0.0
    balance_rwf: float = 0.0
    balance_ghs: float = 0.0
    balance_ngn: float = 0.0
    balance_zar: float = 0.0
    balance_zmw: float = 0.0
    balance_egp: float = 0.0
    created_at: str
    two_fa_enabled: bool = False
    language: str = "fr"
    default_currency: str = "XOF"
    avatar_url: Optional[str] = None
    role: str = "user"
    admin_role: Optional[str] = None
    effective_role: str = "USER"
    permissions: list[str] = Field(default_factory=list)
    is_blocked: bool = False
    is_banned: bool = False
    withdrawals_blocked: bool = False


class AuthResponse(BaseModel):
    token: Optional[str] = None
    user: UserPublic


# ---------- Payment link ----------
class PaymentLinkCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    amount: float = 0  # kept for backward compat; used when amount_type = fixed
    # Universal links no longer force a currency at creation time — the customer
    # picks it (XOF/XAF/USDT) on the checkout page. Field kept optional for
    # legacy inbound payloads and defaults to "UNIVERSAL".
    currency: Literal["XOF", "XAF", "USDT", "UNIVERSAL"] = "UNIVERSAL"
    description: Optional[str] = Field("", max_length=2000)
    expires_at: Optional[str] = None
    single_use: bool = False
    amount_type: Literal["fixed", "free"] = "fixed"
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    fee_bearer: Literal["customer", "owner"] = "customer"
    logo: Optional[str] = Field(None, max_length=3_000_000)  # raster data URL or hosted URL


class PaymentLinkUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=120)
    amount: Optional[float] = None
    currency: Optional[Literal["XOF", "XAF", "USDT", "UNIVERSAL"]] = None
    description: Optional[str] = Field(None, max_length=2000)
    expires_at: Optional[str] = None
    single_use: Optional[bool] = None
    active: Optional[bool] = None
    amount_type: Optional[Literal["fixed", "free"]] = None
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    fee_bearer: Optional[Literal["customer", "owner"]] = None
    logo: Optional[str] = Field(None, max_length=3_000_000)


class PaymentLink(BaseModel):
    id: str
    user_id: str
    slug: str
    title: str
    amount: float
    currency: str
    description: str = ""
    expires_at: Optional[str] = None
    single_use: bool = False
    active: bool = True
    payments_received: int = 0
    total_received: float = 0.0
    created_at: str
    amount_type: str = "fixed"
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    fee_bearer: str = "customer"
    logo: Optional[str] = None


# ---------- Transactions ----------
class Transaction(BaseModel):
    id: str
    user_id: str
    type: Literal["deposit", "transfer", "withdrawal", "payment", "link_payment", "exchange"]
    direction: Literal["in", "out"]
    amount: float
    currency: str
    status: Literal["pending", "completed", "failed", "cancelled"]
    counterparty: Optional[str] = None
    reference: str
    description: Optional[str] = ""
    created_at: str
    metadata: dict = Field(default_factory=dict)


# ---------- Transfer ----------
class TransferRequest(BaseModel):
    transfer_type: Literal["biz_to_biz", "biz_to_mobile", "biz_to_bank", "biz_to_crypto"]
    recipient: str  # username / phone / iban / wallet address / binance id
    recipient_name: Optional[str] = ""
    recipient_phone: Optional[str] = ""  # extra id field for biz_to_biz
    country: Optional[str] = None
    operator: Optional[str] = None
    bank: Optional[str] = None
    fee_bearer: Optional[Literal["sender", "receiver"]] = "sender"
    amount: float
    currency: Literal[
        "XOF", "XAF", "CDF", "USD", "GMD", "GNF", "UGX", "TZS", "KES",
        "RWF", "GHS", "NGN", "ZAR", "ZMW", "EGP", "USDT"
    ]
    description: Optional[str] = ""
    metadata: Optional[dict] = None
    idempotency_key: Optional[str] = None
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)
    withdrawal_otp_challenge_id: Optional[str] = Field(None, min_length=1, max_length=128)
    withdrawal_otp_code: Optional[str] = Field(None, min_length=1, max_length=6)
    # Crypto/Binance fields
    crypto: Optional[str] = None       # e.g. "USDT", "BTC", "ETH"
    network: Optional[str] = None      # e.g. "TRC20", "BEP20", "ERC20", "SOLANA"
    wallet_address: Optional[str] = None


# ---------- Deposit (Stripe) ----------
class DepositRequest(BaseModel):
    amount: float
    currency: Literal["XOF", "XAF"]
    origin_url: str


# ---------- Deposit (Crypto via IzichangePay — direct in-app flow) ----------
class CryptoDepositRequest(BaseModel):
    amount: float                                # in crypto units (e.g. USDT)
    asset_code: str = Field(..., min_length=1)   # e.g. "USDT.TRC20" from /crypto/assets
    full_name: str = Field(..., min_length=1)    # required for KYC/refund
    email: EmailStr
    refund_address: str = Field(..., min_length=1)  # required by izichangepay
    origin_url: str
    idempotency_key: str = Field(..., min_length=8, max_length=120)


# ---------- Payment link crypto (customer-side) ----------
class LinkPayRequest(BaseModel):
    slug: str = Field(..., min_length=1)
    amount: Optional[float] = None  # required for flexible links
    asset_code: str = Field("USDT.TRC20", min_length=1)
    full_name: str = Field(..., min_length=1)
    email: EmailStr
    refund_address: str = Field(..., min_length=1)  # required on-chain address
    origin_url: str
    idempotency_key: str = Field(..., min_length=8, max_length=120)
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


# ---------- Exchange ----------
class ExchangeRequest(BaseModel):
    from_currency: Literal["USDT", "XOF", "XAF"]
    to_currency: Literal["USDT", "XOF", "XAF"]
    amount: float
    idempotency_key: Optional[str] = Field(None, min_length=8, max_length=120)


# ---------- KYC ----------
class KycSubmit(BaseModel):
    full_name: str = Field(..., min_length=1, max_length=120)
    phone: str = Field(..., min_length=3, max_length=40)
    document_type: Literal["cni", "passport", "driver_license"]
    document_number: str = Field(..., min_length=1, max_length=100)
    activity_description: str = Field(..., min_length=1, max_length=500)
    document_front: Optional[str] = Field(None, max_length=4_200_000)  # raster data URL
    document_back: Optional[str] = Field(None, max_length=4_200_000)
    selfie: Optional[str] = Field(None, max_length=4_200_000)


# ---------- Settings ----------
class UpdateProfile(BaseModel):
    full_name: Optional[str] = Field(None, min_length=1, max_length=120)
    phone: Optional[str] = Field(None, min_length=3, max_length=40)
    email: Optional[EmailStr] = None
    language: Optional[str] = None
    default_currency: Optional[Literal["XOF", "XAF"]] = None
    two_fa_enabled: Optional[bool] = None
    avatar_url: Optional[str] = Field(None, max_length=3_000_000)


class ChangePassword(BaseModel):
    current_password: str
    new_password: str
    otp: Optional[str] = None


# ---------- Support ticket ----------
class TicketCreate(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=5000)
    category: Literal["general", "technical", "billing", "kyc"] = "general"


class Ticket(BaseModel):
    id: str
    user_id: str
    subject: str
    message: str
    category: str
    status: Literal["open", "in_progress", "closed"] = "open"
    created_at: str
    replies: List[dict] = Field(default_factory=list)
