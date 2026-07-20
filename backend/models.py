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
    full_name: str
    username: str
    account_type: Literal["personal", "merchant"]
    country: str
    phone: str
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: str  # accepts email or username
    password: str


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
    created_at: str
    two_fa_enabled: bool = False
    language: str = "fr"
    default_currency: str = "XOF"


class AuthResponse(BaseModel):
    token: str
    user: UserPublic


# ---------- Payment link ----------
class PaymentLinkCreate(BaseModel):
    title: str
    amount: float
    currency: Literal["XOF", "XAF"]
    description: Optional[str] = ""
    expires_at: Optional[str] = None
    single_use: bool = False


class PaymentLinkUpdate(BaseModel):
    title: Optional[str] = None
    amount: Optional[float] = None
    currency: Optional[Literal["XOF", "XAF"]] = None
    description: Optional[str] = None
    expires_at: Optional[str] = None
    single_use: Optional[bool] = None
    active: Optional[bool] = None


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
    transfer_type: Literal["biz_to_biz", "biz_to_mobile", "biz_to_bank"]
    recipient: str  # username / phone / iban
    recipient_name: Optional[str] = ""
    amount: float
    currency: Literal["XOF", "XAF"]
    description: Optional[str] = ""


# ---------- Deposit (Stripe) ----------
class DepositRequest(BaseModel):
    amount: float
    currency: Literal["XOF", "XAF"]
    origin_url: str


# ---------- Exchange ----------
class ExchangeRequest(BaseModel):
    from_currency: Literal["XOF", "XAF"]
    to_currency: Literal["XOF", "XAF"]
    amount: float


# ---------- KYC ----------
class KycSubmit(BaseModel):
    document_type: Literal["id_card", "passport", "driver_license"]
    document_number: str
    document_front: Optional[str] = None  # base64 or url
    document_back: Optional[str] = None
    selfie: Optional[str] = None
    address_proof: Optional[str] = None
    address: str
    city: str


# ---------- API keys ----------
class ApiKeys(BaseModel):
    public_key: str
    secret_key: str
    webhook_url: Optional[str] = ""
    created_at: str


class WebhookConfig(BaseModel):
    webhook_url: str


# ---------- Settings ----------
class UpdateProfile(BaseModel):
    full_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    language: Optional[str] = None
    default_currency: Optional[Literal["XOF", "XAF"]] = None
    two_fa_enabled: Optional[bool] = None


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


# ---------- Support ticket ----------
class TicketCreate(BaseModel):
    subject: str
    message: str
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
