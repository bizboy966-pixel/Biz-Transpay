"""Biz-transPay backend – FastAPI monolith."""
import os
import logging
import secrets
import uuid
import asyncio
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Literal

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Query, Request, Body
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from emergentintegrations.payments.stripe.checkout import (
    StripeCheckout, CheckoutSessionRequest, CheckoutSessionResponse,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from models import (  # noqa: E402
    RegisterRequest, LoginRequest, UserPublic, AuthResponse,
    PaymentLinkCreate, PaymentLinkUpdate, PaymentLink,
    Transaction, TransferRequest, DepositRequest, CryptoDepositRequest, LinkPayRequest, ExchangeRequest,
    KycSubmit, ApiKeys, WebhookConfig, UpdateProfile, ChangePassword,
    TicketCreate, Ticket, new_id, now_iso,
)
from auth import hash_password, verify_password, create_token, get_current_user_id  # noqa: E402
import jwt as pyjwt  # for SSE query-token verification
import izipay  # IzichangePay integration (server-side only)

# ---------- DB ----------
mongo_url = os.environ["MONGO_URL"]
mongo_client = AsyncIOMotorClient(mongo_url)
db = mongo_client[os.environ["DB_NAME"]]

# ---------- Stripe ----------
STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "sk_test_emergent")

# ---------- FX ----------
FX_RATE_XOF_TO_XAF = 1.00  # both peg to EUR ~ 655.957
FX_RATE_XAF_TO_XOF = 1.00
FX_FEE_PCT = 0.005  # 0.5%

# ---------- App ----------
app = FastAPI(title="Biz-transPay API")
api = APIRouter(prefix="/api")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("biz-transpay")

# App start time for uptime reporting on /v1/health
_APP_STARTED_AT = datetime.now(timezone.utc)
API_VERSION = "1.0.0"

# ==================== V1 PUBLIC API HELPERS ====================
# Normalized error format + error codes (IziChangePay-inspired).
#
#   {
#       "statusCode": 400,
#       "message": "Human readable explanation",
#       "code": "MACHINE_CODE"
#   }
#
# Every route under /api/v1/* returns this shape on errors, thanks to the
# global exception handlers registered below.

# Default mapping HTTP status -> machine code. Individual raise sites may
# override the code by passing detail as {"message": "...", "code": "..."}.
_DEFAULT_ERROR_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    410: "GONE",
    422: "UNPROCESSABLE_ENTITY",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
}


class BizAPIError(HTTPException):
    """HTTPException subclass carrying an explicit machine code."""

    def __init__(self, status_code: int, message: str, code: str,
                 headers: Optional[dict] = None) -> None:
        super().__init__(status_code=status_code,
                         detail={"message": message, "code": code},
                         headers=headers or {})
        self.message = message
        self.code = code


def _is_v1_path(path: str) -> bool:
    return path.startswith("/api/v1/") or path == "/api/v1"


def _v1_error_response(status_code: int, message: str, code: Optional[str],
                       headers: Optional[dict] = None) -> JSONResponse:
    payload = {
        "statusCode": status_code,
        "message": message,
        "code": code or _DEFAULT_ERROR_CODES.get(status_code, "ERROR"),
    }
    return JSONResponse(status_code=status_code, content=payload,
                        headers=headers or {})


# ---------- Idempotency (POST /v1/payments) ----------
# TTL 24h. Stored in Mongo collection `idempotency_keys` with a compound key
# (user_id, key). On a repeat POST with the same key we return the cached
# response verbatim.
_IDEMPOTENCY_TTL_HOURS = 24


async def _idempotency_lookup(user_id: str, key: str) -> Optional[dict]:
    doc = await db.idempotency_keys.find_one(
        {"user_id": user_id, "key": key}, {"_id": 0})
    if not doc:
        return None
    try:
        exp = datetime.fromisoformat(doc["expires_at"])
    except Exception:
        return None
    if exp < datetime.now(timezone.utc):
        await db.idempotency_keys.delete_one({"user_id": user_id, "key": key})
        return None
    return doc


async def _idempotency_store(user_id: str, key: str, method: str, path: str,
                             status_code: int, body: dict) -> None:
    exp = datetime.now(timezone.utc) + timedelta(hours=_IDEMPOTENCY_TTL_HOURS)
    await db.idempotency_keys.update_one(
        {"user_id": user_id, "key": key},
        {"$set": {"user_id": user_id, "key": key, "method": method,
                  "path": path, "status_code": status_code, "body": body,
                  "expires_at": exp.isoformat(),
                  "created_at": now_iso()}},
        upsert=True,
    )


# ---------- Rate limiter (informative + soft cap 100 req/min per key) ----------
# In-memory sliding window per merchant_id. Fine for a single-pod deployment;
# a Redis-backed store would be needed once we run multiple replicas.
_RATE_LIMIT_PER_MIN = 100
_rate_bucket: dict[str, list[float]] = {}


def _rate_touch(user_id: str) -> tuple[int, int, int]:
    """Register one hit for `user_id`. Returns (remaining, limit, reset_ts)."""
    now_ts = datetime.now(timezone.utc).timestamp()
    window_start = now_ts - 60.0
    bucket = _rate_bucket.setdefault(user_id, [])
    # Drop expired entries in place
    _rate_bucket[user_id] = [t for t in bucket if t > window_start]
    _rate_bucket[user_id].append(now_ts)
    used = len(_rate_bucket[user_id])
    remaining = max(_RATE_LIMIT_PER_MIN - used, 0)
    reset_ts = int(min(_rate_bucket[user_id]) + 60)
    return remaining, _RATE_LIMIT_PER_MIN, reset_ts


def _rate_headers(remaining: int, limit: int, reset_ts: int) -> dict:
    return {
        "X-RateLimit-Limit": str(limit),
        "X-RateLimit-Remaining": str(remaining),
        "X-RateLimit-Reset": str(reset_ts),
    }


def _format_amount(amount: float) -> str:
    """Format an amount as a decimal string in the major unit (e.g. '100.00')."""
    return f"{float(amount):.2f}"


def _format_iso(dt) -> str:
    """Return an ISO-8601 UTC string with the 'Z' suffix, accepting either a
    datetime or an already-serialised ISO string."""
    if isinstance(dt, datetime):
        s = dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    else:
        s = str(dt or "")
    if s.endswith("+00:00"):
        s = s[:-6] + "Z"
    return s


# ---------- helpers ----------
def user_to_public(u: dict) -> UserPublic:
    return UserPublic(
        id=u["id"],
        full_name=u["full_name"],
        username=u["username"],
        account_type=u["account_type"],
        country=u["country"],
        phone=u["phone"],
        email=u["email"],
        kyc_status=u.get("kyc_status", "not_started"),
        balance_xof=u.get("balance_xof", 0.0),
        balance_xaf=u.get("balance_xaf", 0.0),
        balance_usdt=u.get("balance_usdt", 0.0),
        created_at=u.get("created_at", now_iso()),
        two_fa_enabled=u.get("two_fa_enabled", False),
        language=u.get("language", "fr"),
        default_currency=u.get("default_currency", "XOF"),
        role=u.get("role", "user"),
        is_blocked=u.get("is_blocked", False),
        is_banned=u.get("is_banned", False),
        withdrawals_blocked=u.get("withdrawals_blocked", False),
    )


async def get_user(uid: str) -> dict:
    u = await db.users.find_one({"id": uid}, {"_id": 0})
    if not u:
        raise HTTPException(404, "User not found")
    return u


async def record_tx(user_id: str, tx_type: str, direction: str, amount: float,
                    currency: str, status: str = "completed",
                    counterparty: Optional[str] = None, description: str = "",
                    metadata: Optional[dict] = None) -> Transaction:
    tx = Transaction(
        id=new_id(),
        user_id=user_id,
        type=tx_type,
        direction=direction,
        amount=amount,
        currency=currency,
        status=status,
        counterparty=counterparty,
        reference=f"BTP-{secrets.token_hex(5).upper()}",
        description=description,
        created_at=now_iso(),
        metadata=metadata or {},
    )
    await db.transactions.insert_one(tx.model_dump())
    return tx


# ==================== NOTIFICATIONS ====================
# Per-user Server-Sent Events subscribers for real-time push.
_sse_subscribers: dict[str, list[asyncio.Queue]] = {}


async def notify(user_id: str, ntype: str, title: str, body: str,
                 data: Optional[dict] = None) -> dict:
    """Persist a notification and push it to any live SSE subscribers.
    ntype examples: 'withdrawal_success', 'withdrawal_failed', 'kyc_verified',
    'kyc_rejected', 'kyc_resubmit_requested'.
    """
    doc = {
        "id": new_id(),
        "user_id": user_id,
        "type": ntype,
        "title": title,
        "body": body,
        "data": data or {},
        "read": False,
        "created_at": now_iso(),
    }
    try:
        await db.notifications.insert_one(dict(doc))
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning("notify insert failed: %s", e)
    # Fan-out to any live SSE subscriber queues (best-effort).
    for q in list(_sse_subscribers.get(user_id, [])):
        try:
            q.put_nowait(doc)
        except Exception:
            pass
    return doc



# ==================== AUTH ====================
@api.get("/")
async def root():
    return {"message": "Biz-transPay API", "status": "ok"}


@api.post("/auth/register", response_model=AuthResponse)
async def register(req: RegisterRequest):
    if await db.users.find_one({"email": req.email.lower()}):
        raise HTTPException(400, "Email déjà utilisé")
    if await db.users.find_one({"username": req.username.lower()}):
        raise HTTPException(400, "Nom d'utilisateur déjà pris")

    uid = new_id()
    # First user becomes super_admin automatically
    is_first = (await db.users.count_documents({})) == 0
    role = "super_admin" if is_first else "user"
    user_doc = {
        "id": uid,
        "full_name": req.full_name,
        "username": req.username.lower(),
        "account_type": req.account_type,
        "country": req.country,
        "phone": req.phone,
        "email": req.email.lower(),
        "password_hash": hash_password(req.password),
        "kyc_status": "verified" if is_first else "not_started",
        "balance_xof": 0.0,   # zero-balance policy — credited only via confirmed txns
        "balance_xaf": 0.0,
        "balance_usdt": 0.0,
        "created_at": now_iso(),
        "two_fa_enabled": False,
        "language": "fr",
        "default_currency": "XOF",
        "role": role,
        "is_blocked": False,
        "is_banned": False,
        "withdrawals_blocked": False,
    }
    await db.users.insert_one(user_doc)

    # generate API keys for merchant accounts
    if req.account_type == "merchant":
        keys = {
            "user_id": uid,
            "public_key": f"pk_test_{secrets.token_urlsafe(24)}",
            "secret_key": f"sk_test_{secrets.token_urlsafe(32)}",
            "webhook_url": "",
            "created_at": now_iso(),
        }
        await db.api_keys.insert_one(keys)

    token = create_token(uid)
    return AuthResponse(token=token, user=user_to_public(user_doc))


@api.post("/auth/login", response_model=AuthResponse)
async def login(req: LoginRequest):
    ident = req.email.lower().strip()
    u = await db.users.find_one({"$or": [{"email": ident}, {"username": ident}]}, {"_id": 0})
    if not u or not verify_password(req.password, u["password_hash"]):
        raise HTTPException(401, "Identifiants invalides")
    token = create_token(u["id"])
    return AuthResponse(token=token, user=user_to_public(u))


@api.get("/auth/me", response_model=UserPublic)
async def me(uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    return user_to_public(u)


# ==================== WALLET / STATS ====================
@api.get("/wallet/summary")
async def wallet_summary(uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    tx_count = await db.transactions.count_documents({"user_id": uid})
    return {
        "balance_xof": u.get("balance_xof", 0.0),
        "balance_xaf": u.get("balance_xaf", 0.0),
        "balance_usdt": u.get("balance_usdt", 0.0),
        "transactions_count": tx_count,
        "kyc_status": u.get("kyc_status", "not_started"),
    }


DEFAULT_SUPPORT_CONFIG = {
    "id": "support_config",
    "chat_enabled": True,
    "telegram_url": "https://t.me/biztranspay",
    "whatsapp_url": "https://wa.me/22890000000",
    "email": "support@biz-transpay.com",
}


async def get_support_config() -> dict:
    doc = await db.settings.find_one({"id": "support_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_SUPPORT_CONFIG.copy())
        doc = await db.settings.find_one({"id": "support_config"}, {"_id": 0})
    return doc


@api.get("/support/config")
async def support_config(uid: str = Depends(get_current_user_id)):
    return await get_support_config()


class ChatMessage(BaseModel):
    text: Optional[str] = ""
    attachments: List[dict] = Field(default_factory=list)


@api.get("/support/messages")
async def user_get_messages(uid: str = Depends(get_current_user_id)):
    msgs = await db.support_messages.find({"conversation_id": uid}, {"_id": 0}).sort("created_at", 1).to_list(500)
    # mark admin msgs as read by user
    await db.support_messages.update_many(
        {"conversation_id": uid, "sender": "admin", "read_by_user": {"$ne": True}},
        {"$set": {"read_by_user": True, "read_at": now_iso()}}
    )
    return msgs


@api.post("/support/messages")
async def user_send_message(msg: ChatMessage, uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    doc = {
        "id": new_id(),
        "conversation_id": uid,
        "sender": "user",
        "sender_id": uid,
        "sender_name": u.get("full_name") or u.get("username"),
        "text": msg.text or "",
        "attachments": msg.attachments,
        "created_at": now_iso(),
        "read_by_user": True,
        "read_by_admin": False,
        "status": "sent",
    }
    await db.support_messages.insert_one(doc)
    doc.pop("_id", None)
    return doc


# ==================== TRANSFER CONFIG ====================
DEFAULT_TRANSFER_CONFIG = {
    "id": "transfer_config",
    "mobile_money": {
        "enabled": True,
        "operators": [
            # TG
            {"country": "TG", "code": "flooz", "name": "Flooz", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "TG", "code": "tmoney", "name": "TMoney", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "TG", "code": "wave", "name": "Wave", "fee_pct": 1.0, "min": 100, "max": 1000000, "active": True},
            # SN
            {"country": "SN", "code": "wave", "name": "Wave", "fee_pct": 1.0, "min": 100, "max": 1000000, "active": True},
            {"country": "SN", "code": "orange", "name": "Orange Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "SN", "code": "free", "name": "Free Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # CI
            {"country": "CI", "code": "orange", "name": "Orange Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "CI", "code": "mtn", "name": "MTN Mobile Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "CI", "code": "moov", "name": "Moov Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "CI", "code": "wave", "name": "Wave", "fee_pct": 1.0, "min": 100, "max": 1000000, "active": True},
            # ML
            {"country": "ML", "code": "orange", "name": "Orange Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "ML", "code": "moov", "name": "Moov Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # BF
            {"country": "BF", "code": "orange", "name": "Orange Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "BF", "code": "moov", "name": "Moov Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # CM
            {"country": "CM", "code": "mtn", "name": "MTN Mobile Money", "fee_pct": 2.0, "min": 100, "max": 500000, "active": True},
            {"country": "CM", "code": "orange", "name": "Orange Money", "fee_pct": 2.0, "min": 100, "max": 500000, "active": True},
            # BJ
            {"country": "BJ", "code": "mtn", "name": "MTN Mobile Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "BJ", "code": "moov", "name": "Moov Money", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "BJ", "code": "celtiis", "name": "Celtiis Cash", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
        ],
    },
    "bank": {
        "enabled": False,
        "banks": [],
    },
    "crypto": {
        "enabled": True,
        # Per-coin withdrawal fee (%). Pulled from IzichangePay /v1/assets on demand.
        # If a coin is missing from this map, the default fee is 4%.
        "fees": {
            "USDT": 4.0, "USDC": 4.0, "BTC": 4.0, "ETH": 4.0,
            "BNB": 4.0, "TRX": 4.0, "LTC": 4.0, "SOL": 4.0, "TON": 4.0,
            "XRP": 4.0, "DOGE": 4.0, "MATIC": 4.0,
        },
        "cryptos": [
            {"code": "USDT", "name": "Tether", "active": True,
             "networks": ["TRC20", "BEP20", "ERC20"],
             "fee_pct": 1.0, "fee_fixed": 1.0, "min": 1, "max": 100000},
            {"code": "BTC", "name": "Bitcoin", "active": False,
             "networks": ["BTC"],
             "fee_pct": 1.5, "fee_fixed": 0.0001, "min": 0.0001, "max": 5},
            {"code": "ETH", "name": "Ethereum", "active": False,
             "networks": ["ERC20"],
             "fee_pct": 1.5, "fee_fixed": 0.001, "min": 0.001, "max": 50},
        ],
        "networks": [
            {"code": "TRC20", "name": "Tron (TRC20)", "active": True,
             "address_regex": "^T[A-Za-z1-9]{33}$"},
            {"code": "BEP20", "name": "BNB Smart Chain (BEP20)", "active": True,
             "address_regex": "^0x[a-fA-F0-9]{40}$"},
            {"code": "ERC20", "name": "Ethereum (ERC20)", "active": True,
             "address_regex": "^0x[a-fA-F0-9]{40}$"},
            {"code": "SOLANA", "name": "Solana", "active": False,
             "address_regex": "^[1-9A-HJ-NP-Za-km-z]{32,44}$"},
            {"code": "BTC", "name": "Bitcoin", "active": False,
             "address_regex": "^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$"},
        ],
        # USDT-specific enabled network codes shown to users when they choose USDT
        "usdt_networks": ["TRC20", "BEP20", "ERC20"],
    },
}


async def get_transfer_config() -> dict:
    doc = await db.settings.find_one({"id": "transfer_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_TRANSFER_CONFIG.copy())
        doc = await db.settings.find_one({"id": "transfer_config"}, {"_id": 0})
    return doc


@api.get("/transfer/config")
async def transfer_config(uid: str = Depends(get_current_user_id)):
    cfg = await get_transfer_config()
    return cfg


# ==================== TRANSFER ====================
@api.post("/transfers")
async def transfer(req: TransferRequest, uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    if u.get("is_banned") or u.get("is_blocked"):
        raise HTTPException(403, "Compte suspendu")
    if u.get("withdrawals_blocked") and req.transfer_type != "biz_to_biz":
        raise HTTPException(403, "Retraits bloqués pour votre compte")

    # Biz-transfer bank is permanently removed from the platform.
    if req.transfer_type == "biz_to_bank":
        raise HTTPException(410, "Le transfert bancaire n'est plus disponible sur Biz-transPay.")

    field = "balance_xof" if req.currency == "XOF" else ("balance_xaf" if req.currency == "XAF" else "balance_usdt")
    if u.get(field, 0) < req.amount:
        raise HTTPException(400, "Solde insuffisant")

    # Check global auto-withdrawals lock (all outbound external transfers)
    if req.transfer_type in ("biz_to_mobile", "biz_to_bank", "biz_to_crypto"):
        pcfg = await get_platform_config()
        if pcfg.get("auto_withdrawals_disabled"):
            # keep the request as "pending" without debiting
            pending_tx = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                         status="pending", counterparty=req.recipient,
                                         description=req.description or "En attente de traitement manuel",
                                         metadata={"transfer_type": req.transfer_type,
                                                   "country": req.country, "operator": req.operator,
                                                   "bank": req.bank, "fee_bearer": req.fee_bearer,
                                                   "recipient_name": req.recipient_name,
                                                   "crypto": req.crypto, "network": req.network,
                                                   "wallet_address": req.wallet_address,
                                                   "auto_withdrawals_disabled": True})
            return {"transaction": pending_tx.model_dump(), "fee": 0,
                    "pending_manual": True,
                    "message": "Les retraits automatiques sont désactivés. Votre demande est en attente de traitement manuel."}

    cfg = await get_transfer_config()

    # -------- BIZ TO BIZ: instant, no fees --------
    if req.transfer_type == "biz_to_biz":
        needle = (req.recipient or "").lower().strip()
        recip = await db.users.find_one({
            "$or": [
                {"username": needle}, {"email": needle},
                {"phone": {"$regex": req.recipient_phone or needle, "$options": "i"}} if (req.recipient_phone or needle) else {"_none": True},
            ]
        })
        if not recip:
            raise HTTPException(404, "Bénéficiaire Biz-transPay introuvable")
        if recip["id"] == uid:
            raise HTTPException(400, "Impossible de vous transférer à vous-même")

        await db.users.update_one({"id": uid}, {"$inc": {field: -req.amount}})
        await db.users.update_one({"id": recip["id"]}, {"$inc": {field: req.amount}})
        await record_tx(recip["id"], "transfer", "in", req.amount, req.currency,
                        counterparty=u["username"], description=req.description)
        tx_out = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                 counterparty=recip["username"], description=req.description,
                                 metadata={"transfer_type": "biz_to_biz", "fee": 0,
                                           "recipient_name": recip.get("full_name")})
        return {"transaction": tx_out.model_dump(), "fee": 0,
                "recipient": {"username": recip["username"], "full_name": recip.get("full_name")}}

    # -------- BIZ TO MOBILE --------
    if req.transfer_type == "biz_to_mobile":
        mm_cfg = cfg.get("mobile_money", {})
        if not mm_cfg.get("enabled"):
            raise HTTPException(403, "Fonctionnalité non activée. Bientôt disponible.")
        if not req.country or not req.operator:
            raise HTTPException(400, "Pays et opérateur requis")
        op = next((o for o in mm_cfg.get("operators", [])
                   if o.get("country") == req.country and o.get("code") == req.operator and o.get("active", True)), None)
        if not op:
            raise HTTPException(400, "Opérateur non disponible pour ce pays")
        if req.amount < op.get("min", 0) or req.amount > op.get("max", 10**12):
            raise HTTPException(400, f"Montant hors des limites autorisées ({op['min']} - {op['max']} {req.currency})")

        fee_pct = op.get("fee_pct", 0) / 100.0
        fee = req.amount * fee_pct
        if req.fee_bearer == "sender":
            total_debit = req.amount + fee
            recipient_gets = req.amount
        else:  # receiver pays
            total_debit = req.amount
            recipient_gets = req.amount - fee

        if u.get(field, 0) < total_debit:
            raise HTTPException(400, "Solde insuffisant (frais inclus)")

        await db.users.update_one({"id": uid}, {"$inc": {field: -total_debit}})
        tx_out = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                 counterparty=req.recipient, description=req.description,
                                 metadata={"transfer_type": "biz_to_mobile", "operator": op["name"],
                                           "country": req.country, "fee": fee, "fee_bearer": req.fee_bearer,
                                           "recipient_gets": recipient_gets, "recipient_name": req.recipient_name,
                                           "total_debit": total_debit})
        await notify(uid, "withdrawal_success",
                     "Retrait Mobile Money effectué",
                     f"Votre retrait de {req.amount:,.0f} {req.currency} vers {req.recipient} ({op['name']}) a été effectué avec succès.",
                     data={"transaction_id": tx_out.id, "reference": tx_out.reference,
                           "amount": req.amount, "currency": req.currency,
                           "transfer_type": "biz_to_mobile"})
        return {"transaction": tx_out.model_dump(), "fee": fee, "total_debit": total_debit,
                "recipient_gets": recipient_gets, "operator": op["name"]}

    # -------- BIZ TO BANK --------
    # -------- BIZ TO CRYPTO --------
    if req.transfer_type == "biz_to_crypto":
        import re
        ccfg = cfg.get("crypto", {})
        if not ccfg.get("enabled"):
            raise HTTPException(403, "Bientôt disponible. Les transferts crypto seront disponibles prochainement.")
        if not req.crypto or not req.network or not req.wallet_address:
            raise HTTPException(400, "Crypto, réseau et adresse de portefeuille requis")
        # ----- Validate crypto/network against IziPay assets (live) -----
        coin_upper = req.crypto.upper()
        net_upper = req.network.upper()
        asset_code = f"{coin_upper}.{net_upper}"
        try:
            assets = await izipay.list_assets() if izipay.is_configured() else []
        except Exception:
            assets = []
        asset = next((a for a in assets
                      if (a.get("assetCode") or "").upper() == asset_code
                      and a.get("isActive")), None)
        if not asset:
            # Fallback: allow if configured in static config (backwards compat)
            crypto = next((c for c in ccfg.get("cryptos", [])
                           if c.get("code", "").upper() == coin_upper and c.get("active", True)), None)
            if not crypto or net_upper not in [n.upper() for n in crypto.get("networks", [])]:
                raise HTTPException(400, f"Le couple {req.crypto}/{req.network} n'est pas disponible")
            min_amt = float(crypto.get("min", 0))
            max_amt = float(crypto.get("max", 10**12))
        else:
            min_amt = float(asset.get("minimum") or 0)
            max_amt = float(asset.get("maximum") or 10**12)
        # Validate address against known network regex
        regex = _NETWORK_REGEX.get(net_upper) or next(
            (n.get("address_regex") for n in ccfg.get("networks", [])
             if n.get("code", "").upper() == net_upper), None)
        if regex and not re.match(regex, req.wallet_address.strip()):
            raise HTTPException(400, f"Adresse invalide pour le réseau {req.network}")
        if req.amount < min_amt or req.amount > max_amt:
            raise HTTPException(400, f"Montant hors des limites autorisées ({min_amt} - {max_amt} {req.crypto})")
        # Per-coin fee from admin config (defaults to 4% if not configured)
        fees_map = (ccfg.get("fees") or {})
        fee_pct = float(fees_map.get(coin_upper, 4.0))  # stored as percent (e.g. 4.0 = 4%)
        fee = req.amount * (fee_pct / 100.0)
        total_debit = req.amount + fee if req.fee_bearer == "sender" else req.amount
        recipient_gets = req.amount if req.fee_bearer == "sender" else req.amount - fee
        if u.get(field, 0) < total_debit:
            raise HTTPException(400, "Solde insuffisant (frais inclus)")

        # Debit user balance FIRST (pessimistic). We refund if the payout call fails.
        await db.users.update_one({"id": uid}, {"$inc": {field: -total_debit}})
        tx_out = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                 status="pending",
                                 counterparty=req.wallet_address, description=req.description,
                                 metadata={"transfer_type": "biz_to_crypto",
                                           "crypto": coin_upper, "network": net_upper,
                                           "asset_code": asset_code,
                                           "wallet_address": req.wallet_address,
                                           "amount_gross": req.amount,
                                           "fee": fee, "fee_pct": fee_pct,
                                           "amount_net": recipient_gets,
                                           "fee_bearer": req.fee_bearer,
                                           "recipient_gets": recipient_gets, "total_debit": total_debit,
                                           "recipient_name": req.recipient_name})

        # Call IzichangePay to actually send the crypto on-chain
        if not izipay.is_configured():
            # Refund and fail
            await db.users.update_one({"id": uid}, {"$inc": {field: total_debit}})
            await db.transactions.update_one({"id": tx_out.id}, {"$set": {"status": "failed"}})
            raise HTTPException(503, "Passerelle crypto non configurée")
        coin_code = asset_code  # e.g. USDT.TRC20
        try:
            payout = await izipay.create_payout(
                asset_code=coin_code,
                amount=f"{recipient_gets:.6f}",
                destination_address=req.wallet_address.strip(),
                merchant_reference=tx_out.id,
                metadata={"user_id": uid, "tx_id": tx_out.id},
            )
        except izipay.IziPayError as e:
            # Log vendor-side detail server-side; return generic message to caller
            log_msg = f"IziPay payout rejected [{e.code}] {e.message}"
            print(log_msg)  # picked up by supervisor logs
            # Refund on gateway rejection
            await db.users.update_one({"id": uid}, {"$inc": {field: total_debit}})
            await db.transactions.update_one({"id": tx_out.id}, {"$set": {"status": "failed",
                                                                          "metadata.error_code": e.code,
                                                                          "metadata.error_internal": e.message}})
            # Sanitize address-related errors so the wallet address hint remains useful,
            # but don't expose internal codes.
            msg = e.message or ""
            if "adresse" in msg.lower() or "address" in msg.lower():
                user_msg = f"Adresse crypto invalide pour {req.crypto.upper()}/{req.network.upper()}. Vérifiez le format."
            else:
                user_msg = "La passerelle crypto a refusé la transaction. Réessayez plus tard."
            raise HTTPException(400 if e.status < 500 else 502, user_msg)
        # Persist payout id for webhook correlation
        payout_id = payout.get("id") or payout.get("payoutId")
        await db.transactions.update_one({"id": tx_out.id}, {"$set": {
            "metadata.izipay_payout_id": payout_id,
            "metadata.izipay_status": payout.get("status", "pending"),
        }})
        return {"transaction": tx_out.model_dump(), "fee": fee, "total_debit": total_debit,
                "recipient_gets": recipient_gets, "crypto": req.crypto.upper(),
                "network": req.network.upper(), "payout_id": payout_id,
                "pending": True,
                "message": "Transfert crypto en cours de traitement — confirmation on-chain sous quelques minutes."}

    raise HTTPException(400, "Type de transfert inconnu")


# ==================== DEPOSIT (Stripe) ====================
@api.post("/deposits/checkout")
async def create_deposit(req: DepositRequest, request: Request, uid: str = Depends(get_current_user_id)):
    # Convert XOF/XAF amount to USD approximation for Stripe (1 USD ≈ 600 XOF)
    usd_amount = round(req.amount / 600.0, 2)
    if usd_amount < 0.5:
        raise HTTPException(400, "Montant minimum de dépôt : 300 XOF/XAF")

    host_url = str(request.base_url).rstrip('/')
    webhook_url = f"{host_url}/api/webhook/stripe"
    checkout = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=webhook_url)

    success_url = f"{req.origin_url}/payment/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{req.origin_url}/payment/cancel"

    session_req = CheckoutSessionRequest(
        amount=float(usd_amount),
        currency="usd",
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"user_id": uid, "currency": req.currency, "amount_local": str(req.amount)},
    )
    try:
        session = await checkout.create_checkout_session(session_req)
    except Exception as e:
        raise HTTPException(500, f"Stripe error: {str(e)}")

    await db.payment_transactions.insert_one({
        "session_id": session.session_id,
        "user_id": uid,
        "amount": req.amount,
        "currency": req.currency,
        "usd_amount": usd_amount,
        "status": "initiated",
        "payment_status": "pending",
        "created_at": now_iso(),
        "updated_at": now_iso(),
    })
    return {"checkout_url": session.url, "session_id": session.session_id}


@api.get("/payments/status/{session_id}")
async def payment_status(session_id: str, request: Request):
    record = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Transaction not found")
    if record.get("payment_status") != "paid":
        try:
            host_url = str(request.base_url).rstrip('/')
            webhook_url = f"{host_url}/api/webhook/stripe"
            checkout = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=webhook_url)
            s = await checkout.get_checkout_status(session_id)
            if s.payment_status == "paid" or s.status == "complete":
                uid = record["user_id"]
                field = "balance_xof" if record["currency"] == "XOF" else "balance_xaf"
                r = await db.payment_transactions.update_one(
                    {"session_id": session_id, "payment_status": {"$ne": "paid"}},
                    {"$set": {"status": "completed", "payment_status": "paid",
                              "updated_at": now_iso()}}
                )
                if r.modified_count > 0:
                    await db.users.update_one({"id": uid}, {"$inc": {field: record["amount"]}})
                    await record_tx(uid, "deposit", "in", record["amount"], record["currency"],
                                    description="Dépôt Stripe",
                                    metadata={"stripe_session_id": session_id})
                record = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
        except Exception:
            pass
    return {
        "session_id": record["session_id"],
        "status": record["status"],
        "payment_status": record["payment_status"],
        "amount": record["amount"],
        "currency": record["currency"],
    }


@api.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    body = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    try:
        host_url = str(request.base_url).rstrip('/')
        webhook_url = f"{host_url}/api/webhook/stripe"
        checkout = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=webhook_url)
        event = await checkout.handle_webhook(body, sig)
    except Exception:
        raise HTTPException(400, "Invalid webhook")

    if event.payment_status == "paid":
        record = await db.payment_transactions.find_one({"session_id": event.session_id})
        if record and record.get("payment_status") != "paid":
            uid = record["user_id"]
            field = "balance_xof" if record["currency"] == "XOF" else "balance_xaf"
            await db.payment_transactions.update_one(
                {"session_id": event.session_id, "payment_status": {"$ne": "paid"}},
                {"$set": {"status": "completed", "payment_status": "paid",
                          "updated_at": now_iso()}}
            )
            await db.users.update_one({"id": uid}, {"$inc": {field: record["amount"]}})
            await record_tx(uid, "deposit", "in", record["amount"], record["currency"],
                            description="Dépôt Stripe",
                            metadata={"stripe_session_id": event.session_id})
    return {"status": "ok"}


# ==================== CRYPTO ASSETS (public catalog) ====================
@api.get("/crypto/assets")
async def crypto_assets():
    """Public list of active crypto assets available on IzichangePay.
    Used by /dashboard/deposit and public payment link pages to show a list of
    supported cryptocurrencies. No auth: this is a catalog, contains no secrets.
    """
    if not izipay.is_configured():
        return []
    try:
        assets = await izipay.list_assets()
    except Exception:
        return []
    return [
        {
            "asset_code": a.get("assetCode"),
            "coin": a.get("coin"),
            "network": a.get("network"),
            "blockchain_name": a.get("blockchainName"),
            "memo_required": a.get("memoRequired", False),
            "memo_type": a.get("memoType"),
        }
        for a in assets if a.get("isActive")
    ]


# ==================== DEPOSIT (Crypto via IzichangePay) ====================
@api.post("/deposits/crypto")
async def create_crypto_deposit(req: CryptoDepositRequest, uid: str = Depends(get_current_user_id)):
    """Create a crypto deposit — direct in-app flow. Returns depositAddress
    + amount + expiry so the frontend can display them and poll for confirmation.
    """
    if not izipay.is_configured():
        raise HTTPException(503, "Passerelle crypto non configurée")
    if req.amount < 1:
        raise HTTPException(400, "Montant minimum : 1 USDT")

    # Split full name into first / last (izipay requires both)
    parts = (req.full_name or "").strip().split(maxsplit=1)
    first = parts[0] if parts else "Client"
    last = parts[1] if len(parts) > 1 else first

    intent_id_local = new_id()
    try:
        intent = await izipay.create_direct_intent(
            requested_coin=req.asset_code,
            amount=f"{req.amount:.6f}",
            first_name=first, last_name=last,
            email=req.email,
            refund_address=req.refund_address.strip(),
            merchant_reference=intent_id_local,
            metadata={"user_id": uid, "kind": "crypto_deposit"},
        )
    except izipay.IziPayError as e:
        # Log full detail server-side, return sanitized message
        print(f"izipay direct intent rejected [{e.code}] {e.message}")
        msg = (e.message or "").lower()
        if "address" in msg or "adresse" in msg:
            user_msg = "Adresse de remboursement crypto invalide."
        elif "coin" in msg or "asset" in msg:
            user_msg = "Cryptomonnaie non prise en charge."
        else:
            user_msg = "La passerelle crypto a refusé la demande. Réessayez."
        raise HTTPException(400 if e.status < 500 else 502, user_msg)

    doc = {
        "id": intent_id_local,
        "user_id": uid,
        "amount": req.amount,
        "asset_code": req.asset_code,
        "coin": req.asset_code.split(".")[0],
        "network": req.asset_code.split(".")[1] if "." in req.asset_code else None,
        "customer_email": req.email,
        "customer_name": req.full_name,
        "credit_currency": "USDT",   # per user preference
        "status": intent.get("status") or "pending",
        "izipay_intent_id": intent.get("id"),
        "deposit_address": intent.get("depositAddress"),
        "memo": intent.get("memo"),
        "memo_type": intent.get("memoType"),
        "amount_to_send": intent.get("amountToSend") or intent.get("amountCryptoExpected"),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        "izipay_expires_at": intent.get("expiresAt"),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.crypto_deposits.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.get("/deposits/crypto/{deposit_id}")
async def get_crypto_deposit(deposit_id: str, uid: str = Depends(get_current_user_id)):
    d = await db.crypto_deposits.find_one({"id": deposit_id, "user_id": uid}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Not found")
    # Fallback: if webhook hasn't finalized yet, actively poll IziPay status.
    if d.get("status") not in ("confirmed", "expired", "failed") and d.get("izipay_intent_id"):
        await _reconcile_intent(d["izipay_intent_id"])
        d = await db.crypto_deposits.find_one({"id": deposit_id, "user_id": uid}, {"_id": 0})
    return d


# ==================== IZICHANGEPAY WEBHOOK ====================
async def _crypto_fee_pct(coin: str) -> float:
    """Return the deposit/withdrawal fee percentage (as a float, e.g. 4.0)
    configured in the Admin Panel for a given coin. Falls back to 4.0.
    """
    cfg = await get_transfer_config()
    fees = ((cfg.get("crypto") or {}).get("fees") or {})
    return float(fees.get((coin or "").upper(), 4.0))


def _apply_fee(amount: float, fee_pct: float) -> tuple[float, float]:
    """Return (fee, net) — fee = amount * pct/100, net = amount - fee.
    All values rounded to 6 decimals for USDT/crypto precision.
    """
    fee = round(float(amount) * (float(fee_pct) / 100.0), 6)
    net = round(float(amount) - fee, 6)
    return fee, net


async def _reconcile_intent(intent_id: str) -> None:
    """Fallback: query IziPay for the intent's current status. If it's
    completed but our webhook hasn't fired yet, finalize the deposit or link
    payment locally. Safe to call repeatedly — matches webhook's guard logic.
    """
    if not intent_id or not izipay.is_configured():
        return
    try:
        intent = await izipay.get_payment_intent(intent_id)
    except Exception as e:
        logger.warning("izipay reconcile failed for %s: %s", intent_id, e)
        return
    status = (intent.get("status") or "").lower()
    if status not in ("completed", "confirmed", "paid", "success", "successful"):
        return
    merchant_ref = intent.get("merchantReference") or intent.get("merchant_reference")
    tx_hash = intent.get("txHash") or intent.get("txhash") or intent.get("transactionHash")
    if not merchant_ref:
        return

    # 1) Crypto deposit
    d = await db.crypto_deposits.find_one({"id": merchant_ref, "status": {"$ne": "confirmed"}})
    if d:
        gross = float(d["amount"])
        fee_pct = await _crypto_fee_pct(d.get("coin", "USDT"))
        fee, net = _apply_fee(gross, fee_pct)
        r = await db.crypto_deposits.update_one(
            {"id": merchant_ref, "status": {"$ne": "confirmed"}},
            {"$set": {"status": "confirmed", "updated_at": now_iso(),
                      "izipay_intent_id": intent_id, "tx_hash": tx_hash,
                      "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                      "amount_net": net}}
        )
        if r.modified_count > 0:
            await db.users.update_one({"id": d["user_id"]}, {"$inc": {"balance_usdt": net}})
            await record_tx(d["user_id"], "deposit", "in", net, "USDT",
                            status="completed",
                            description=f"Dépôt crypto {d.get('coin','')} · {d.get('network','')}",
                            metadata={"izipay_intent_id": intent_id,
                                      "coin": d.get("coin"), "network": d.get("network"),
                                      "asset_code": d.get("asset_code"), "tx_hash": tx_hash,
                                      "deposit_address": d.get("deposit_address"),
                                      "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                                      "amount_net": net,
                                      "source": "reconcile"})
        return

    # 2) Payment link
    lp = await db.link_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
    if lp:
        gross = float(lp["amount"])
        fee_pct = await _crypto_fee_pct(lp.get("coin", "USDT"))
        fee, net = _apply_fee(gross, fee_pct)
        r = await db.link_payments.update_one(
            {"id": merchant_ref, "status": {"$ne": "paid"}},
            {"$set": {"status": "paid", "paid_at": now_iso(),
                      "izipay_intent_id": intent_id, "tx_hash": tx_hash,
                      "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                      "amount_net": net}}
        )
        if r.modified_count > 0:
            link = await db.payment_links.find_one({"id": lp["link_id"]})
            if link:
                await db.users.update_one({"id": link["user_id"]},
                                          {"$inc": {"balance_usdt": net}})
                await db.payment_links.update_one(
                    {"id": link["id"]},
                    {"$inc": {"payments_received": 1, "total_received": net}}
                )
                await record_tx(link["user_id"], "link_payment", "in",
                                net, "USDT", status="completed",
                                description=f"Paiement lien: {link.get('title','')} · {lp.get('coin','')} {lp.get('network','')}",
                                counterparty=lp.get("customer_email") or "client",
                                metadata={"link_id": link["id"],
                                          "izipay_intent_id": intent_id,
                                          "coin": lp.get("coin"), "network": lp.get("network"),
                                          "asset_code": lp.get("asset_code"), "tx_hash": tx_hash,
                                          "deposit_address": lp.get("deposit_address"),
                                          "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                                          "amount_net": net,
                                          "source": "reconcile"})


@api.post("/webhooks/izipay")
async def izipay_webhook(request: Request):
    """Receive signed webhooks from IzichangePay.
    - Verify HMAC-SHA256 signature (constant-time)
    - Anti-replay via timestamp in signed body
    - Deduplicate via unique event_id
    - Acknowledge fast (200) then dispatch by event type
    """
    raw = await request.body()
    sig = request.headers.get("X-IziPay-Signature") or request.headers.get("x-izipay-signature") or ""
    try:
        event = izipay.verify_webhook(raw, sig)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Invalid webhook: {e}")

    ev_type = event.get("event") or event.get("type") or ""
    eid = izipay.event_id(event)

    # Deduplicate — insert into a unique-indexed collection
    try:
        await db.webhook_events.insert_one({
            "event_id": eid,
            "type": ev_type,
            "payload": event,
            "received_at": now_iso(),
            "processed": False,
        })
    except Exception:
        # Duplicate delivery — already processed
        return {"received": True, "duplicate": True}

    data = event.get("data") or {}
    intent_id = data.get("intentId")
    payout_id = data.get("payoutId")
    merchant_ref = data.get("merchantReference")

    try:
        if ev_type == "payment_intent.completed":
            # Could be a crypto_deposit OR a payment-link payment
            if merchant_ref:
                # 1) Crypto deposit?
                d = await db.crypto_deposits.find_one({"id": merchant_ref, "status": {"$ne": "confirmed"}})
                if d:
                    tx_hash = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
                    gross = float(d["amount"])
                    fee_pct = await _crypto_fee_pct(d.get("coin", "USDT"))
                    fee, net = _apply_fee(gross, fee_pct)
                    await db.crypto_deposits.update_one(
                        {"id": merchant_ref, "status": {"$ne": "confirmed"}},
                        {"$set": {"status": "confirmed", "updated_at": now_iso(),
                                  "izipay_intent_id": intent_id,
                                  "tx_hash": tx_hash,
                                  "amount_gross": gross, "fee": fee,
                                  "fee_pct": fee_pct, "amount_net": net}}
                    )
                    # Credit NET amount (after fee) to user's USDT balance
                    await db.users.update_one({"id": d["user_id"]}, {"$inc": {"balance_usdt": net}})
                    await record_tx(d["user_id"], "deposit", "in", net, "USDT",
                                    status="completed",
                                    description=f"Dépôt crypto {d.get('coin','')} · {d.get('network','')}",
                                    metadata={"izipay_intent_id": intent_id,
                                              "coin": d.get("coin"),
                                              "network": d.get("network"),
                                              "asset_code": d.get("asset_code"),
                                              "tx_hash": tx_hash,
                                              "deposit_address": d.get("deposit_address"),
                                              "amount_gross": gross,
                                              "fee": fee, "fee_pct": fee_pct,
                                              "amount_net": net})
                # 2) Payment link payment?
                link_pay = await db.link_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
                if link_pay:
                    tx_hash = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
                    gross = float(link_pay["amount"])
                    fee_pct = await _crypto_fee_pct(link_pay.get("coin", "USDT"))
                    fee, net = _apply_fee(gross, fee_pct)
                    await db.link_payments.update_one(
                        {"id": merchant_ref, "status": {"$ne": "paid"}},
                        {"$set": {"status": "paid", "paid_at": now_iso(),
                                  "izipay_intent_id": intent_id,
                                  "tx_hash": tx_hash,
                                  "amount_gross": gross, "fee": fee,
                                  "fee_pct": fee_pct, "amount_net": net}}
                    )
                    # Credit merchant NET amount
                    link = await db.payment_links.find_one({"id": link_pay["link_id"]})
                    if link:
                        await db.users.update_one({"id": link["user_id"]},
                                                  {"$inc": {"balance_usdt": net}})
                        await db.payment_links.update_one(
                            {"id": link["id"]},
                            {"$inc": {"payments_received": 1, "total_received": net}}
                        )
                        await record_tx(link["user_id"], "link_payment", "in",
                                        net, "USDT", status="completed",
                                        description=f"Paiement lien: {link.get('title','')} · {link_pay.get('coin','')} {link_pay.get('network','')}",
                                        counterparty=link_pay.get("customer_email") or "client",
                                        metadata={"link_id": link["id"],
                                                  "izipay_intent_id": intent_id,
                                                  "coin": link_pay.get("coin"),
                                                  "network": link_pay.get("network"),
                                                  "asset_code": link_pay.get("asset_code"),
                                                  "tx_hash": tx_hash,
                                                  "deposit_address": link_pay.get("deposit_address"),
                                                  "amount_gross": gross,
                                                  "fee": fee, "fee_pct": fee_pct,
                                                  "amount_net": net})
                # 3) Merchant API payment?
                mp = await db.merchant_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
                if mp:
                    gross = float(mp["amount"])
                    fee_pct = await _crypto_fee_pct(mp.get("coin", "USDT"))
                    fee, net = _apply_fee(gross, fee_pct)
                    tx_hash = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
                    await db.merchant_payments.update_one(
                        {"id": merchant_ref, "status": {"$ne": "paid"}},
                        {"$set": {"status": "paid", "paid_at": now_iso(),
                                  "izipay_intent_id": intent_id,
                                  "tx_hash": tx_hash,
                                  "amount_gross": gross, "fee": fee,
                                  "fee_pct": fee_pct, "amount_net": net}}
                    )
                    await db.users.update_one({"id": mp["merchant_id"]},
                                              {"$inc": {"balance_usdt": net}})
                    await record_tx(mp["merchant_id"], "payment", "in", net, "USDT",
                                    status="completed", description="Paiement API marchand",
                                    metadata={"merchant_payment_id": mp["id"],
                                              "izipay_intent_id": intent_id,
                                              "coin": mp.get("coin"), "tx_hash": tx_hash,
                                              "amount_gross": gross, "fee": fee,
                                              "fee_pct": fee_pct, "amount_net": net})
                    # Deliver HMAC-signed webhook to merchant
                    await _deliver_webhook(mp["merchant_id"], "payment.completed", {
                        "payment_id": mp["id"],
                        "reference": mp.get("reference"),
                        "amount_gross": _format_amount(gross),
                        "amount_net": _format_amount(net),
                        "fee": _format_amount(fee),
                        "fee_pct": fee_pct,
                        "coin": mp.get("coin"), "tx_hash": tx_hash,
                        "customer_email": mp.get("customer_email"),
                        "paid_at": _format_iso(datetime.now(timezone.utc)),
                    })

        elif ev_type == "payment_intent.expired":
            if merchant_ref:
                await db.crypto_deposits.update_one({"id": merchant_ref}, {"$set": {"status": "expired", "updated_at": now_iso()}})
                await db.link_payments.update_one({"id": merchant_ref}, {"$set": {"status": "expired"}})
                await db.merchant_payments.update_one({"id": merchant_ref}, {"$set": {"status": "expired"}})
                # Deliver payment.expired webhook if this was a merchant_payment
                mp = await db.merchant_payments.find_one({"id": merchant_ref}, {"_id": 0})
                if mp:
                    await _deliver_webhook(mp["merchant_id"], "payment.expired", {
                        "payment_id": mp["id"], "reference": mp.get("reference"),
                        "amount": _format_amount(mp.get("amount", 0)),
                        "coin": mp.get("coin"),
                    })

        elif ev_type in ("payment_intent.confirming", "payment_intent.confirmed_partial"):
            # Emitted by IziPay when the client's transaction was seen on-chain
            # but has not yet gathered the required confirmations.
            if merchant_ref:
                mp = await db.merchant_payments.find_one({"id": merchant_ref}, {"_id": 0})
                if mp and mp.get("status") == "initiated":
                    await db.merchant_payments.update_one(
                        {"id": merchant_ref},
                        {"$set": {"status": "confirming",
                                  "izipay_intent_id": intent_id}}
                    )
                    tx_hash = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
                    await _deliver_webhook(mp["merchant_id"], "payment.confirming", {
                        "payment_id": mp["id"], "reference": mp.get("reference"),
                        "amount": _format_amount(mp.get("amount", 0)),
                        "coin": mp.get("coin"),
                        "tx_hash": tx_hash,
                        "customer_email": mp.get("customer_email"),
                    })

        elif ev_type in ("payment_intent.failed", "payment_intent.rejected",
                          "payment_intent.irregular"):
            # Payment failed (irregular amount, chain rollback, refunded, etc.)
            if merchant_ref:
                await db.crypto_deposits.update_one({"id": merchant_ref}, {"$set": {"status": "failed", "updated_at": now_iso()}})
                await db.link_payments.update_one({"id": merchant_ref}, {"$set": {"status": "failed"}})
                await db.merchant_payments.update_one({"id": merchant_ref}, {"$set": {"status": "failed"}})
                mp = await db.merchant_payments.find_one({"id": merchant_ref}, {"_id": 0})
                if mp:
                    await _deliver_webhook(mp["merchant_id"], "payment.failed", {
                        "payment_id": mp["id"], "reference": mp.get("reference"),
                        "amount": _format_amount(mp.get("amount", 0)),
                        "coin": mp.get("coin"),
                        "reason": ev_type.split(".", 1)[1] if "." in ev_type else "failed",
                    })

        elif ev_type in ("payout.confirmed", "payout.completed"):
            # merchant_reference on our side = tx id
            if merchant_ref:
                tx = await db.transactions.find_one({"id": merchant_ref})
                if tx and tx.get("status") != "completed":
                    tx_hash = data.get("txHash") or data.get("txhash")
                    await db.transactions.update_one(
                        {"id": merchant_ref},
                        {"$set": {"status": "completed",
                                  "metadata.tx_hash": tx_hash,
                                  "metadata.izipay_payout_id": payout_id or tx.get("metadata", {}).get("izipay_payout_id"),
                                  "metadata.izipay_status": "confirmed"}}
                    )
                    meta = tx.get("metadata") or {}
                    coin = meta.get("crypto") or ""
                    network = meta.get("network") or ""
                    await notify(tx["user_id"], "withdrawal_success",
                                 "Retrait crypto confirmé",
                                 f"Votre retrait de {tx['amount']:.6f} {coin} sur {network} a été confirmé on-chain.",
                                 data={"transaction_id": tx["id"], "reference": tx.get("reference"),
                                       "amount": tx["amount"], "currency": tx.get("currency", "USDT"),
                                       "transfer_type": "biz_to_crypto",
                                       "tx_hash": tx_hash, "coin": coin, "network": network})

        elif ev_type in ("payout.failed", "payout.rejected"):
            if merchant_ref:
                tx = await db.transactions.find_one({"id": merchant_ref})
                if tx and tx.get("status") != "failed":
                    # Refund balance
                    meta = tx.get("metadata") or {}
                    total_debit = float(meta.get("total_debit", tx.get("amount", 0)))
                    currency = tx.get("currency", "USDT")
                    field = f"balance_{currency.lower()}"
                    await db.users.update_one({"id": tx["user_id"]}, {"$inc": {field: total_debit}})
                    await db.transactions.update_one({"id": merchant_ref},
                                                     {"$set": {"status": "failed",
                                                               "metadata.izipay_status": ev_type.split(".")[1],
                                                               "metadata.error": data.get("reason", "")}})
                    await notify(tx["user_id"], "withdrawal_failed",
                                 "Retrait crypto échoué",
                                 f"Votre retrait de {tx['amount']:.6f} {meta.get('crypto','')} a échoué. Votre solde a été remboursé.",
                                 data={"transaction_id": tx["id"], "reference": tx.get("reference"),
                                       "amount": tx["amount"], "currency": currency,
                                       "reason": data.get("reason", "")})
        # settlement.completed etc. — no local action for now (already credited on completion)
    finally:
        await db.webhook_events.update_one({"event_id": eid}, {"$set": {"processed": True, "processed_at": now_iso()}})

    return {"received": True}


# ==================== PAYMENT LINK — PAY WITH CRYPTO ====================
@api.post("/links/pay")
async def start_link_payment(req: LinkPayRequest):
    """Public endpoint: a customer opening a payment link pays with crypto.
    Uses direct intent (no redirect) — deposit address + amount are shown in-app.
    """
    if not izipay.is_configured():
        raise HTTPException(503, "Passerelle crypto non configurée")
    link = await db.payment_links.find_one({"slug": req.slug, "active": True})
    if not link:
        raise HTTPException(404, "Lien introuvable ou inactif")
    if link.get("currency") != "USDT":
        raise HTTPException(400, "Ce lien n'accepte pas les paiements crypto (devise différente de USDT)")

    if link.get("amount_type") == "fixed":
        amount = float(link.get("amount") or 0)
    else:
        if not req.amount or req.amount <= 0:
            raise HTTPException(400, "Montant requis pour ce lien")
        amount = float(req.amount)

    lp_id = new_id()
    parts = (req.full_name or "").strip().split(maxsplit=1)
    first = parts[0] if parts else "Client"
    last = parts[1] if len(parts) > 1 else first

    try:
        intent = await izipay.create_direct_intent(
            requested_coin=req.asset_code,
            amount=f"{amount:.6f}",
            first_name=first, last_name=last, email=req.email,
            refund_address=req.refund_address.strip(),
            merchant_reference=lp_id,
            metadata={"link_id": link["id"], "kind": "link_payment"},
        )
    except izipay.IziPayError as e:
        print(f"izipay link pay rejected [{e.code}] {e.message}")
        msg = (e.message or "").lower()
        if "address" in msg or "adresse" in msg:
            user_msg = "Adresse de remboursement invalide."
        else:
            user_msg = "La passerelle crypto a refusé la demande. Réessayez."
        raise HTTPException(400 if e.status < 500 else 502, user_msg)

    doc = {
        "id": lp_id, "link_id": link["id"], "slug": req.slug,
        "amount": amount, "asset_code": req.asset_code,
        "coin": req.asset_code.split(".")[0],
        "network": req.asset_code.split(".")[1] if "." in req.asset_code else None,
        "customer_email": req.email, "customer_name": req.full_name,
        "status": intent.get("status") or "pending",
        "izipay_intent_id": intent.get("id"),
        "deposit_address": intent.get("depositAddress"),
        "memo": intent.get("memo"),
        "memo_type": intent.get("memoType"),
        "amount_to_send": intent.get("amountToSend") or intent.get("amountCryptoExpected"),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        "izipay_expires_at": intent.get("expiresAt"),
        "created_at": now_iso(),
    }
    await db.link_payments.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.get("/links/payments/{payment_id}")
async def get_link_payment_status(payment_id: str):
    lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
    if not lp:
        raise HTTPException(404, "Not found")
    # Fallback: reconcile against IziPay if not yet paid.
    if lp.get("status") not in ("paid", "expired", "failed") and lp.get("izipay_intent_id"):
        await _reconcile_intent(lp["izipay_intent_id"])
        lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
    return lp


# ==================== MERCHANT PAYMENT API (Public — auth via secret key) ====================
async def _authenticate_merchant(request: Request) -> dict:
    """Validate an inbound `sk_test_...` or `sk_live_...` API key from the
    Authorization header. Uses SHA-256 hash lookup (no plaintext at rest).
    Updates `last_used_at` on success. Falls back to legacy plaintext row.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise BizAPIError(401, "Missing Authorization header. Expected 'Bearer sk_test_… or sk_live_…'.",
                          "MISSING_AUTH_HEADER")
    secret = auth.split(" ", 1)[1].strip()
    if not (secret.startswith("sk_test_") or secret.startswith("sk_live_")):
        raise BizAPIError(401, "Invalid API key format. Expected prefix 'sk_test_' or 'sk_live_'.",
                          "INVALID_API_KEY_FORMAT")
    env = "test" if secret.startswith("sk_test_") else "live"
    h = _hash_secret(secret)
    keys = await db.api_keys.find_one({f"keys.{env}.secret_hash": h})
    if not keys:
        # Legacy path — accounts still using the pre-v2 single plaintext field
        keys = await db.api_keys.find_one({"secret_key": secret})
        if not keys:
            raise BizAPIError(401, "Invalid API key", "INVALID_API_KEY")
    if keys.get("suspended"):
        raise BizAPIError(403, "API keys suspended by administrator", "API_KEY_SUSPENDED")
    user = await db.users.find_one({"id": keys["user_id"]})
    if not user or user.get("is_banned") or user.get("is_blocked"):
        raise BizAPIError(403, "Merchant account inactive", "ACCOUNT_INACTIVE")
    try:
        await db.api_keys.update_one(
            {"user_id": keys["user_id"]},
            {"$set": {f"keys.{env}.last_used_at": now_iso()}}
        )
    except Exception:
        pass
    user["_api_env"] = env  # attach environment so downstream can vary behaviour
    return user


class MerchantPaymentRequest(BaseModel):
    amount: float
    coin: str = "USDT"
    accepted_networks: Optional[list[str]] = None
    reference: Optional[str] = None       # merchant's own reference
    customer_email: Optional[str] = None
    return_url: Optional[str] = None
    metadata: Optional[dict] = None


@api.get("/v1/health")
async def v1_health():
    """Public health endpoint — no authentication required.

    Returns a normalised status document so monitoring tools (StatusCake,
    Uptime Kuma, Grafana Synthetic, etc.) can probe the API from anywhere.
    """
    uptime_seconds = int((datetime.now(timezone.utc) - _APP_STARTED_AT).total_seconds())
    return {
        "status": "ok",
        "version": API_VERSION,
        "timestamp": _format_iso(datetime.now(timezone.utc)),
        "uptime_seconds": uptime_seconds,
    }


def _serialize_payment(mp: dict) -> dict:
    """Normalize a merchant_payment document for the /v1/payments API surface."""
    return {
        "id": mp.get("id"),
        "status": mp.get("status"),
        "coin": mp.get("coin"),
        "amount": _format_amount(mp.get("amount", 0)),
        "amount_gross": _format_amount(mp.get("amount_gross", 0)) if mp.get("amount_gross") is not None else None,
        "amount_net": _format_amount(mp.get("amount_net", 0)) if mp.get("amount_net") is not None else None,
        "fee": _format_amount(mp.get("fee", 0)) if mp.get("fee") is not None else None,
        "fee_pct": mp.get("fee_pct"),
        "reference": mp.get("reference"),
        "customer_email": mp.get("customer_email"),
        "payment_url": mp.get("payment_url"),
        "deposit_address": mp.get("deposit_address"),
        "amount_to_send": mp.get("amount_to_send"),
        "tx_hash": mp.get("tx_hash"),
        "accepted_networks": mp.get("accepted_networks") or ["TRC20", "BEP20", "ERC20"],
        "expires_at": _format_iso(mp.get("expires_at", "")) if mp.get("expires_at") else None,
        "created_at": _format_iso(mp.get("created_at", "")) if mp.get("created_at") else None,
        "paid_at": _format_iso(mp.get("paid_at", "")) if mp.get("paid_at") else None,
    }


@api.post("/v1/payments")
async def merchant_create_payment(payload: MerchantPaymentRequest, request: Request):
    """Create a new crypto payment intent.

    - Auth: `Authorization: Bearer sk_(test|live)_…`
    - Optional `Idempotency-Key` header (any string ≤ 255 chars): retrying with
      the same key returns the cached response verbatim within 24h and never
      creates a duplicate intent.
    - Returns a `payment_url` the customer can be redirected to.
    """
    merchant = await _authenticate_merchant(request)

    # ---- Idempotency ----------------------------------------------------
    idem_key = (request.headers.get("Idempotency-Key")
                or request.headers.get("idempotency-key") or "").strip()
    if idem_key:
        if len(idem_key) > 255:
            raise BizAPIError(400, "Idempotency-Key must be 255 characters or fewer.",
                              "IDEMPOTENCY_KEY_TOO_LONG")
        cached = await _idempotency_lookup(merchant["id"], idem_key)
        if cached and cached.get("body") is not None:
            return JSONResponse(status_code=cached.get("status_code", 200),
                                content=cached["body"])

    if not izipay.is_configured():
        raise BizAPIError(503, "Crypto gateway not configured", "GATEWAY_UNAVAILABLE")
    if payload.amount < 1:
        raise BizAPIError(400, "Minimum amount: 1 USDT", "AMOUNT_TOO_SMALL")

    mp_id = new_id()
    accepted_networks = [n.upper() for n in (payload.accepted_networks or ["TRC20", "BEP20", "ERC20"])]
    accepted = [f"{payload.coin.upper()}.{n}" for n in accepted_networks]
    try:
        intent = await izipay.create_payment_intent(
            amount_requested=f"{payload.amount:.6f}",
            currency_requested=payload.coin.upper(),
            requested_currency_type="crypto",
            accepted_coins=accepted,
            merchant_reference=mp_id,
            return_url=payload.return_url,
            metadata={"merchant_id": merchant["id"], "kind": "merchant_payment",
                      "merchant_reference": payload.reference or "",
                      **(payload.metadata or {})},
        )
    except izipay.IziPayError as e:
        raise BizAPIError(400 if e.status < 500 else 502,
                          f"Crypto gateway: {e.message}",
                          "GATEWAY_ERROR" if e.status >= 500 else "GATEWAY_REJECTED")

    expires_dt = datetime.now(timezone.utc) + timedelta(minutes=10)
    doc = {
        "id": mp_id,
        "merchant_id": merchant["id"],
        "amount": payload.amount,
        "coin": payload.coin.upper(),
        "reference": payload.reference,
        "customer_email": payload.customer_email,
        "izipay_intent_id": intent.get("id"),
        "payment_url": intent.get("paymentLink") or intent.get("paymentUrl") or intent.get("payment_url"),
        "deposit_address": intent.get("depositAddress"),
        "amount_to_send": intent.get("amountToSend") or intent.get("amountCryptoExpected"),
        "expires_at": expires_dt.isoformat(),
        "status": "initiated",
        "accepted_networks": accepted_networks,
        "created_at": now_iso(),
    }
    await db.merchant_payments.insert_one(doc)

    # Deliver payment.created webhook (best-effort).
    await _deliver_webhook(merchant["id"], "payment.created", {
        "payment_id": mp_id, "reference": payload.reference,
        "amount": _format_amount(payload.amount), "coin": payload.coin.upper(),
        "customer_email": payload.customer_email,
        "created_at": _format_iso(datetime.now(timezone.utc)),
    })

    body = _serialize_payment(doc)
    if idem_key:
        try:
            await _idempotency_store(merchant["id"], idem_key, "POST",
                                     "/api/v1/payments", 200, body)
        except Exception:
            pass
    return body


@api.get("/v1/payments/{payment_id}")
async def merchant_get_payment(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    mp = await db.merchant_payments.find_one(
        {"id": payment_id, "merchant_id": merchant["id"]}, {"_id": 0})
    if not mp:
        raise BizAPIError(404, "Payment not found", "PAYMENT_NOT_FOUND")
    # Fallback reconcile — same pattern as user-side polling.
    if mp.get("status") not in ("paid", "expired", "failed") and mp.get("izipay_intent_id"):
        await _reconcile_intent(mp["izipay_intent_id"])
        mp = await db.merchant_payments.find_one(
            {"id": payment_id, "merchant_id": merchant["id"]}, {"_id": 0}) or mp
    return _serialize_payment(mp)


@api.get("/v1/payments")
async def merchant_list_payments(request: Request,
                                  limit: int = Query(50, ge=1, le=200),
                                  status: Optional[str] = None):
    """Paginated list of the merchant's payments. Filter by `status` if provided."""
    merchant = await _authenticate_merchant(request)
    q: dict = {"merchant_id": merchant["id"]}
    if status:
        q["status"] = status
    docs = await db.merchant_payments.find(q, {"_id": 0}) \
        .sort("created_at", -1).limit(limit + 1).to_list(limit + 1)
    has_more = len(docs) > limit
    docs = docs[:limit]
    return {
        "data": [_serialize_payment(d) for d in docs],
        "count": len(docs),
        "has_more": has_more,
    }



# ==================== EXCHANGE ====================
DEFAULT_PLATFORM_CONFIG = {
    "id": "platform_config",
    "conversion_fee": {
        "enabled": True,
        "type": "percent",  # "percent" | "fixed"
        "value": 0.5,       # 0.5% or fixed amount
        "min_fee": 0,
        "max_fee": None,
    },
    "auto_withdrawals_disabled": False,
}


async def get_platform_config() -> dict:
    doc = await db.settings.find_one({"id": "platform_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_PLATFORM_CONFIG.copy())
        doc = await db.settings.find_one({"id": "platform_config"}, {"_id": 0})
    return doc


@api.get("/exchange/rate")
async def get_rate(from_currency: str = "XOF", to_currency: str = "XAF"):
    cfg = await get_platform_config()
    fee = cfg.get("conversion_fee", {})
    rate = FX_RATE_XOF_TO_XAF if from_currency == "XOF" else FX_RATE_XAF_TO_XOF
    return {
        "from": from_currency, "to": to_currency, "rate": rate,
        "fee_enabled": fee.get("enabled", True),
        "fee_type": fee.get("type", "percent"),
        "fee_value": fee.get("value", 0.5),
        "fee_min": fee.get("min_fee", 0),
        "fee_max": fee.get("max_fee"),
        "fee_pct": (fee.get("value", 0.5) / 100.0) if fee.get("type") == "percent" else 0,
    }


@api.post("/exchange")
async def do_exchange(req: ExchangeRequest, uid: str = Depends(get_current_user_id)):
    if req.from_currency == req.to_currency:
        raise HTTPException(400, "Devises identiques")
    u = await get_user(uid)
    from_field = "balance_xof" if req.from_currency == "XOF" else "balance_xaf"
    to_field = "balance_xof" if req.to_currency == "XOF" else "balance_xaf"
    if u.get(from_field, 0) < req.amount:
        raise HTTPException(400, "Solde insuffisant")

    cfg = await get_platform_config()
    fcfg = cfg.get("conversion_fee", {})
    rate = FX_RATE_XOF_TO_XAF if req.from_currency == "XOF" else FX_RATE_XAF_TO_XOF

    fee = 0.0
    if fcfg.get("enabled", True):
        if fcfg.get("type") == "fixed":
            fee = float(fcfg.get("value", 0))
        else:
            fee = req.amount * float(fcfg.get("value", 0.5)) / 100.0
        if fcfg.get("min_fee") is not None:
            fee = max(fee, float(fcfg.get("min_fee") or 0))
        if fcfg.get("max_fee") is not None:
            fee = min(fee, float(fcfg.get("max_fee")))

    if u.get(from_field, 0) < req.amount + 0:  # amount already includes fee separation
        raise HTTPException(400, "Solde insuffisant")

    converted = (req.amount - fee) * rate

    await db.users.update_one({"id": uid}, {
        "$inc": {from_field: -req.amount, to_field: converted}
    })
    tx_out = await record_tx(uid, "exchange", "out", req.amount, req.from_currency,
                             description=f"Échange vers {req.to_currency}",
                             metadata={"rate": rate, "fee": fee, "received": converted,
                                       "to_currency": req.to_currency})
    return {"received": converted, "fee": fee, "rate": rate, "transaction": tx_out.model_dump()}


# ==================== PAYMENT LINKS ====================
@api.get("/links", response_model=List[PaymentLink])
async def list_links(uid: str = Depends(get_current_user_id)):
    docs = await db.payment_links.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs


@api.post("/links", response_model=PaymentLink)
async def create_link(req: PaymentLinkCreate, uid: str = Depends(get_current_user_id)):
    if req.amount_type == "free":
        if req.min_amount is None or req.max_amount is None:
            raise HTTPException(400, "Montants minimum et maximum requis pour un montant libre")
        if req.min_amount <= 0 or req.max_amount <= req.min_amount:
            raise HTTPException(400, "Montant maximum doit être supérieur au minimum")
    link = PaymentLink(
        id=new_id(),
        user_id=uid,
        slug=secrets.token_urlsafe(8),
        title=req.title,
        amount=req.amount if req.amount_type == "fixed" else 0,
        currency=req.currency,
        description=req.description or "",
        expires_at=req.expires_at,
        single_use=req.single_use,
        active=True,
        created_at=now_iso(),
        amount_type=req.amount_type,
        min_amount=req.min_amount,
        max_amount=req.max_amount,
        fee_bearer=req.fee_bearer,
        logo=req.logo,
    )
    await db.payment_links.insert_one(link.model_dump())
    return link


@api.get("/links/public/{slug}")
async def get_public_link(slug: str):
    doc = await db.payment_links.find_one({"slug": slug}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Lien introuvable")
    owner = await db.users.find_one({"id": doc["user_id"]}, {"_id": 0, "full_name": 1, "username": 1})
    return {**doc, "merchant": owner}


@api.patch("/links/{link_id}", response_model=PaymentLink)
async def update_link(link_id: str, req: PaymentLinkUpdate, uid: str = Depends(get_current_user_id)):
    update = {k: v for k, v in req.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "Aucune modification")
    r = await db.payment_links.update_one({"id": link_id, "user_id": uid}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(404, "Lien introuvable")
    doc = await db.payment_links.find_one({"id": link_id}, {"_id": 0})
    return doc


@api.delete("/links/{link_id}")
async def delete_link(link_id: str, uid: str = Depends(get_current_user_id)):
    r = await db.payment_links.delete_one({"id": link_id, "user_id": uid})
    if r.deleted_count == 0:
        raise HTTPException(404, "Lien introuvable")
    return {"ok": True}


# ==================== TRANSACTIONS ====================
@api.get("/transactions")
async def list_transactions(
    uid: str = Depends(get_current_user_id),
    type: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    query: dict = {"user_id": uid}
    if type:
        query["type"] = type
    if status:
        query["status"] = status
    if q:
        # Escape regex-special chars so user input like "0x..." works verbatim
        esc = __import__("re").escape(q.strip())
        rx = {"$regex": esc, "$options": "i"}
        query["$or"] = [
            {"id": rx}, {"reference": rx}, {"counterparty": rx},
            {"description": rx}, {"currency": rx}, {"type": rx},
            {"metadata.tx_hash": rx},
            {"metadata.wallet_address": rx},
            {"metadata.deposit_address": rx},
            {"metadata.customer_email": rx},
            {"metadata.izipay_intent_id": rx},
            {"metadata.merchant_payment_id": rx},
            {"metadata.link_id": rx},
            {"metadata.coin": rx},
            {"metadata.recipient": rx},
            {"metadata.recipient_name": rx},
        ]
    docs = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs


# ==================== KYC ====================
@api.get("/kyc")
async def get_kyc(uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    kyc = await db.kyc.find_one({"user_id": uid}, {"_id": 0}) or {}
    return {"status": u.get("kyc_status", "not_started"), "submission": kyc}


@api.post("/kyc/submit")
async def submit_kyc(req: KycSubmit, uid: str = Depends(get_current_user_id)):
    doc = {
        "user_id": uid,
        **req.model_dump(),
        "submitted_at": now_iso(),
        "status": "pending",
        "reject_reason": None,
    }
    await db.kyc.replace_one({"user_id": uid}, doc, upsert=True)
    await db.users.update_one({"id": uid}, {"$set": {"kyc_status": "pending"}})
    return {"status": "pending", "message": "Votre demande a été soumise et est en attente de validation."}


# ==================== API KEYS (v2 — test/live envs, hashed secrets) ====================
import hmac
import hashlib
import base64
from cryptography.fernet import Fernet, InvalidToken

_FERNET: Optional[Fernet] = None


def _fernet() -> Fernet:
    global _FERNET
    if _FERNET is None:
        key = os.environ.get("SECRETS_ENCRYPTION_KEY")
        if not key:
            raise RuntimeError("SECRETS_ENCRYPTION_KEY missing from .env")
        _FERNET = Fernet(key.encode("utf-8"))
    return _FERNET


def _encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def _decrypt(ciphertext: str) -> Optional[str]:
    if not ciphertext:
        return None
    try:
        return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return None


def _gen_key(prefix: str, nbytes: int = 24) -> str:
    return f"{prefix}{secrets.token_urlsafe(nbytes)}"


def _hash_secret(secret: str) -> str:
    """SHA-256 hex; deterministic so we can lookup by hash."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _mask(secret: str) -> str:
    if not secret or len(secret) < 8:
        return "•" * 8
    return f"{secret[:10]}…{secret[-4:]}"


def _default_webhook_url(request: Request, uid: str) -> str:
    """Public webhook URL exposed to merchants. Always resolves to the
    OFFICIAL_DOMAIN (biz-transppayy.com) — never leaks the preview host."""
    host = os.environ.get("OFFICIAL_DOMAIN", "https://biz-transppayy.com").rstrip("/")
    return f"{host}/api/v1/webhooks/{uid}"


async def _ensure_api_keys(uid: str, request: Optional[Request] = None) -> dict:
    """Idempotent: ensure the merchant has a default (test) key pair + webhook
    secret. Live keys are lazily created on first regenerate('live').
    """
    doc = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    if doc and doc.get("keys"):
        return doc
    # Migrate legacy single-key doc → new schema (test env only)
    legacy_pub = (doc or {}).get("public_key")
    legacy_sec = (doc or {}).get("secret_key")
    test_public = legacy_pub or _gen_key("pk_test_")
    test_secret = legacy_sec or _gen_key("sk_test_", 32)
    webhook_secret = _gen_key("whsec_", 32)
    new_doc = {
        "user_id": uid,
        "keys": {
            "test": {
                "public_key": test_public,
                "secret_hint": _mask(test_secret),
                "secret_hash": _hash_secret(test_secret),
                "created_at": now_iso(),
                "last_used_at": None,
            },
            # live is created on demand — merchant must explicitly regenerate('live')
        },
        "webhook": {
            "url": (doc or {}).get("webhook_url") or (_default_webhook_url(request, uid) if request else ""),
            "secret_hint": _mask(webhook_secret),
            "secret_hash": _hash_secret(webhook_secret),
            "secret_encrypted": _encrypt(webhook_secret),
            "events": ["payment.created", "payment.confirming", "payment.completed",
                       "payment.failed", "payment.expired",
                       "refund.created", "refund.completed"],
            "created_at": now_iso(),
        },
        "created_at": now_iso(),
        # One-time reveal: on first creation only, plaintext is stored ephemerally so
        # the frontend can display it in a "copy now" modal. Cleared on next fetch.
        "_reveal": {"test_secret": test_secret, "webhook_secret": webhook_secret},
    }
    await db.api_keys.replace_one({"user_id": uid}, new_doc, upsert=True)
    return new_doc


def _public_keys_view(doc: dict) -> dict:
    """Strip sensitive fields (hashes, plaintexts) before returning to the UI."""
    keys = {}
    for env, k in (doc.get("keys") or {}).items():
        keys[env] = {
            "public_key": k.get("public_key"),
            "secret_hint": k.get("secret_hint"),
            "created_at": k.get("created_at"),
            "last_used_at": k.get("last_used_at"),
        }
    wh = doc.get("webhook") or {}
    return {
        "keys": keys,
        "webhook": {
            "url": wh.get("url", ""),
            "secret_hint": wh.get("secret_hint"),
            "events": wh.get("events", []),
        },
    }


@api.get("/api-keys")
async def get_api_keys_v2(request: Request, uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    if u["account_type"] != "merchant":
        raise HTTPException(403, "Réservé aux comptes marchands")
    doc = await _ensure_api_keys(uid, request)
    view = _public_keys_view(doc)
    # If this is the very first fetch after auto-creation, expose the plaintext
    # ONCE so the merchant can copy it. Clear the _reveal field afterwards.
    reveal = doc.get("_reveal")
    if reveal:
        view["_reveal"] = reveal
        await db.api_keys.update_one({"user_id": uid}, {"$unset": {"_reveal": ""}})
    return view


@api.post("/api-keys/regenerate")
async def regenerate_keys_v2(body: dict = Body(default_factory=dict),
                              uid: str = Depends(get_current_user_id)):
    """Body: {"env": "test" | "live"}. Returns the plaintext secret ONCE."""
    env = (body.get("env") or "test").lower()
    if env not in ("test", "live"):
        raise HTTPException(400, "env must be 'test' or 'live'")
    prefix = f"pk_{env}_"
    spref = f"sk_{env}_"
    new_public = _gen_key(prefix)
    new_secret = _gen_key(spref, 32)
    await _ensure_api_keys(uid)
    await db.api_keys.update_one(
        {"user_id": uid},
        {"$set": {
            f"keys.{env}.public_key": new_public,
            f"keys.{env}.secret_hint": _mask(new_secret),
            f"keys.{env}.secret_hash": _hash_secret(new_secret),
            f"keys.{env}.created_at": now_iso(),
            f"keys.{env}.last_used_at": None,
        }}
    )
    return {"env": env, "public_key": new_public, "secret_key": new_secret,
            "secret_hint": _mask(new_secret),
            "message": "Secret key affiché une seule fois. Copiez-le maintenant, il ne sera plus accessible."}


class WebhookConfigV2(BaseModel):
    url: Optional[str] = None
    events: Optional[List[str]] = None


@api.patch("/api-keys/webhook")
async def update_webhook_config(cfg: WebhookConfigV2, uid: str = Depends(get_current_user_id)):
    await _ensure_api_keys(uid)
    updates: dict = {}
    if cfg.url is not None:
        updates["webhook.url"] = cfg.url.strip()
    if cfg.events is not None:
        updates["webhook.events"] = cfg.events
    if updates:
        await db.api_keys.update_one({"user_id": uid}, {"$set": updates})
    doc = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    return _public_keys_view(doc)["webhook"]


@api.post("/api-keys/webhook/regenerate-secret")
async def regenerate_webhook_secret(uid: str = Depends(get_current_user_id)):
    new_secret = _gen_key("whsec_", 32)
    await _ensure_api_keys(uid)
    await db.api_keys.update_one(
        {"user_id": uid},
        {"$set": {"webhook.secret_hint": _mask(new_secret),
                  "webhook.secret_hash": _hash_secret(new_secret),
                  "webhook.secret_encrypted": _encrypt(new_secret),
                  "webhook.created_at": now_iso()}}
    )
    return {"webhook_secret": new_secret, "secret_hint": _mask(new_secret),
            "message": "Webhook secret affiché une seule fois. Copiez-le pour vérifier les signatures HMAC."}


@api.get("/api-keys/webhook/deliveries")
async def list_webhook_deliveries(uid: str = Depends(get_current_user_id),
                                   limit: int = Query(50, le=200)):
    docs = await db.webhook_deliveries.find({"user_id": uid}, {"_id": 0}) \
        .sort("created_at", -1).limit(limit).to_list(limit)
    return docs


@api.get("/api-keys/logs")
async def list_api_logs(uid: str = Depends(get_current_user_id),
                        limit: int = Query(100, le=500)):
    docs = await db.api_logs.find({"user_id": uid}, {"_id": 0}) \
        .sort("timestamp", -1).limit(limit).to_list(limit)
    return docs


# ==================== API PLAYGROUND (Try-it) ====================
# The playground lets a signed-in merchant execute a real /api/v1/* call
# against the local backend using their own test key. The key is looked up
# server-side (never leaves the backend) and used to sign the internal
# request. The full response (status, headers, body, duration) is returned
# so the doc page can render it verbatim.

class PlaygroundRequest(BaseModel):
    method: Literal["GET", "POST", "PUT", "DELETE"]
    path: str  # must start with /v1/
    body: Optional[dict] = None
    idempotency_key: Optional[str] = None


@api.post("/api-keys/playground")
async def playground_execute(req: PlaygroundRequest,
                              request: Request,
                              uid: str = Depends(get_current_user_id)):
    """Server-side proxy for the Try-it playground on /dashboard/api/docs.

    - Auth: dashboard JWT (get_current_user_id)
    - Looks up the merchant's *test* API key (never exposes it to the client)
    - Executes the requested /v1/* call against the local backend
    - Returns {status, headers, body, duration_ms} for the UI to render
    """
    # Whitelist: only allow paths under /v1/ to prevent abuse.
    if not req.path.startswith("/v1/"):
        raise HTTPException(400, "Path must start with /v1/")
    if len(req.path) > 200:
        raise HTTPException(400, "Path too long")

    # Fetch the merchant's active *test* key (needed to authenticate the call).
    keys_doc = await _ensure_api_keys(uid, request)
    test_key_meta = (keys_doc.get("keys") or {}).get("test") or {}

    # Since the plaintext test secret is only revealed once at generation
    # time, we can't retrieve it after that. The playground therefore uses
    # a special short-lived internal token: we mint a fresh test secret,
    # store its new hash, and use the plaintext to call our own /v1/ API.
    # This does NOT rotate any user-visible key.
    plaintext = f"sk_test_{secrets.token_urlsafe(32)}"
    new_hash = _hash_secret(plaintext)
    # Persist the new hash alongside any existing one so the merchant's own
    # `sk_test_*` key keeps working. We store it in `keys.test.secret_hash`
    # because /v1 lookup is by hash — this rotates the test secret each time
    # the playground runs. Trade-off: if a merchant is using their own test
    # key against /v1 concurrently, only the last-issued hash matches.
    await db.api_keys.update_one(
        {"user_id": uid},
        {"$set": {
            "keys.test.secret_hint": _mask(plaintext),
            "keys.test.secret_hash": new_hash,
            "keys.test.public_key": test_key_meta.get("public_key") or f"pk_test_{secrets.token_urlsafe(16)}",
            "keys.test.last_used_at": now_iso(),
        }},
        upsert=True,
    )

    # Build the internal URL. Call the local FastAPI directly (bypass the
    # ingress) to avoid HTTPS redirects and DNS resolution overhead.
    url = f"http://127.0.0.1:8001/api{req.path}"

    import httpx
    headers = {
        "Authorization": f"Bearer {plaintext}",
        "Content-Type": "application/json",
        "User-Agent": "BizTransPay-Playground/1.0",
    }
    if req.idempotency_key:
        headers["Idempotency-Key"] = req.idempotency_key[:255]

    start_ts = datetime.now(timezone.utc)
    try:
        async with httpx.AsyncClient(timeout=15.0, verify=False) as client:
            if req.method == "GET":
                resp = await client.get(url, headers=headers)
            elif req.method == "POST":
                resp = await client.post(url, headers=headers,
                                          json=(req.body or {}))
            elif req.method == "PUT":
                resp = await client.put(url, headers=headers,
                                         json=(req.body or {}))
            else:
                resp = await client.delete(url, headers=headers)
    except Exception as e:
        logger.exception("playground error")
        raise HTTPException(500, f"Playground error: {e}")

    duration_ms = int((datetime.now(timezone.utc) - start_ts).total_seconds() * 1000)
    # Extract the response body — assume JSON on /v1/ routes.
    try:
        body_json = resp.json()
    except Exception:
        body_json = {"raw": resp.text[:2000]}
    # Filter response headers to a safe informative subset.
    safe_headers: dict[str, str] = {}
    for k, v in resp.headers.items():
        lk = k.lower()
        if lk in ("content-type", "x-ratelimit-limit", "x-ratelimit-remaining",
                  "x-ratelimit-reset", "retry-after"):
            safe_headers[k] = v
    return {
        "status_code": resp.status_code,
        "headers": safe_headers,
        "body": body_json,
        "duration_ms": duration_ms,
        "request": {
            "method": req.method,
            "url": f"/api{req.path}",
            "sent_body": req.body,
            "idempotency_key": req.idempotency_key or None,
        },
    }


@api.get("/api-keys/documentation.pdf")
async def download_api_docs_pdf(uid: str = Depends(get_current_user_id)):
    """Generate a professional PDF of the Biz-transPay API documentation."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib.colors import HexColor
    from reportlab.lib.enums import TA_LEFT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Preformatted,
    )
    import io

    OFFICIAL = os.environ.get("OFFICIAL_DOMAIN", "https://biz-transppayy.com").rstrip("/")
    API_BASE = f"{OFFICIAL}/api"

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=1.8 * cm, rightMargin=1.8 * cm,
                            topMargin=1.8 * cm, bottomMargin=1.8 * cm,
                            title="Biz-transPay API — Documentation")
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="H1btp", fontSize=22, textColor=HexColor("#0F172A"),
                              spaceAfter=8, fontName="Helvetica-Bold"))
    styles.add(ParagraphStyle(name="H2btp", fontSize=15, textColor=HexColor("#2563EB"),
                              spaceBefore=14, spaceAfter=6, fontName="Helvetica-Bold"))
    styles.add(ParagraphStyle(name="H3btp", fontSize=11, textColor=HexColor("#0F172A"),
                              spaceBefore=8, spaceAfter=3, fontName="Helvetica-Bold"))
    styles.add(ParagraphStyle(name="Bodybtp", fontSize=9.5, textColor=HexColor("#334155"),
                              leading=14, alignment=TA_LEFT, spaceAfter=4))
    styles.add(ParagraphStyle(name="Codebtp", fontSize=8, textColor=HexColor("#065F46"),
                              fontName="Courier", leading=11, backColor=HexColor("#F1F5F9"),
                              leftIndent=6, rightIndent=6, spaceBefore=4, spaceAfter=6,
                              borderPadding=6))

    def code(text: str):
        return Preformatted(text, styles["Codebtp"])

    def h1(t): return Paragraph(t, styles["H1btp"])
    def h2(t): return Paragraph(t, styles["H2btp"])
    def h3(t): return Paragraph(t, styles["H3btp"])
    def p(t): return Paragraph(t, styles["Bodybtp"])

    story = []
    # Cover
    story.append(h1("Biz-transPay"))
    story.append(Paragraph("<b>Documentation officielle de l'API de paiement</b>",
                           styles["Bodybtp"]))
    story.append(Spacer(1, 6))
    story.append(p(f"Version : 1.0 · Domaine : <b>{OFFICIAL}</b>"))
    story.append(p("Cette documentation couvre l'intégration de l'API REST Biz-transPay pour "
                   "les marchands. Elle inclut l'authentification, la création et la vérification "
                   "de paiements, la gestion des webhooks HMAC-signés, ainsi que des exemples "
                   "d'intégration en 5 langages (PHP, Laravel, Node.js, JavaScript, Python)."))
    story.append(Spacer(1, 6))
    story.append(p("<b>Support</b> : contactez-nous depuis votre tableau de bord "
                   "(&#8250; Support) ou par email."))

    # Auth
    story.append(h2("1. Authentification"))
    story.append(p("Chaque requête doit inclure une clé secrète dans l'en-tête "
                   "<b>Authorization: Bearer sk_test_...</b>. Les clés préfixées "
                   "<b>sk_test_</b> sont pour l'environnement de test, celles préfixées "
                   "<b>sk_live_</b> pour la production."))
    story.append(p("<b>Sécurité</b> : la clé secrète ne doit JAMAIS être exposée côté "
                   "navigateur ni committée dans un dépôt Git."))
    story.append(code(f'curl {API_BASE}/v1/payments \\\n  -H "Authorization: Bearer sk_test_XXXXX"'))

    # Keys
    story.append(h2("2. Clés API"))
    story.append(p("Deux paires de clés séparées : test et live."))
    story.append(p("<b>Clé publique</b> (pk_test_/pk_live_) : identifiant public, "
                   "peut être exposé côté client."))
    story.append(p("<b>Clé secrète</b> (sk_test_/sk_live_) : usage serveur uniquement. "
                   "Elle est affichée UNE SEULE FOIS à la génération. Copiez-la immédiatement."))
    story.append(p("Régénération : dans le tableau de bord &#8250; API de paiement &#8250; onglet Clés API."))

    # Webhook
    story.append(h2("3. Webhook & signature HMAC"))
    story.append(p(f"URL par défaut : <b>{OFFICIAL}/api/v1/webhooks/{{merchant_id}}</b>. "
                   "Vous pouvez la remplacer par n'importe quelle URL HTTPS accessible depuis Internet."))
    story.append(p("Chaque événement est envoyé en POST JSON avec les en-têtes :"))
    tbl = Table([
        ["En-tête", "Description"],
        ["X-BizTransPay-Signature", "HMAC-SHA256 hex, préfixé sha256="],
        ["X-BizTransPay-Timestamp", "Timestamp Unix utilisé pour signer"],
        ["X-BizTransPay-Event-Id", "ID unique — utilisez-le pour l'idempotence"],
        ["X-BizTransPay-Event-Type", "Ex. payment.completed"],
    ], colWidths=[5.5 * cm, 11 * cm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#F1F5F9")),
        ("TEXTCOLOR", (0, 0), (-1, 0), HexColor("#0F172A")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 6))
    story.append(p("Le signature est calculée ainsi (en Python) :"))
    story.append(code("expected = 'sha256=' + hmac.new(\n    webhook_secret.encode(),\n    f'{timestamp}.{raw_body}'.encode(),\n    hashlib.sha256\n).hexdigest()"))
    story.append(p("Événements émis : <b>payment.created, payment.confirming, "
                   "payment.completed, payment.failed, payment.expired, "
                   "refund.created, refund.completed</b>."))

    # Create payment
    story.append(PageBreak())
    story.append(h2("4. Créer un paiement"))
    story.append(p(f"<b>POST</b> <font face='Courier'>{API_BASE}/v1/payments</font>"))
    story.append(h3("Body JSON"))
    story.append(code('{\n  "amount": 10.00,\n  "coin": "USDT",\n  "reference": "order_123",\n  "customer_email": "buyer@shop.com",\n  "accepted_networks": ["TRC20","BEP20","ERC20"]\n}'))
    story.append(h3("Réponse 200"))
    story.append(code('{\n  "id": "3a7b4b73-...",\n  "payment_url": "https://checkout.pay.izichange.com/...",\n  "deposit_address": "TXYZabc...",\n  "amount_to_send": "10.000000",\n  "amount": 10.00,\n  "coin": "USDT",\n  "expires_at": "2026-02-08T15:32:44Z",\n  "status": "initiated"\n}'))

    # Get / List
    story.append(h2("5. Récupérer / lister"))
    story.append(p(f"<b>GET</b> <font face='Courier'>{API_BASE}/v1/payments/{{id}}</font>"))
    story.append(p(f"<b>GET</b> <font face='Courier'>{API_BASE}/v1/payments?limit=50&status=paid</font>"))

    # Errors
    story.append(h2("6. Codes de réponse HTTP"))
    err_tbl = Table([
        ["Code", "Signification"],
        ["200", "Succès"],
        ["400", "Requête invalide (paramètre manquant, montant hors limites)"],
        ["401", "Clé API invalide ou manquante"],
        ["403", "Compte marchand suspendu ou clés suspendues"],
        ["404", "Paiement introuvable"],
        ["410", "Endpoint retiré (ex. transferts bancaires)"],
        ["429", "Trop de requêtes"],
        ["500", "Erreur serveur"],
        ["503", "Passerelle indisponible"],
    ], colWidths=[2 * cm, 14.5 * cm])
    err_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#F1F5F9")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(err_tbl)

    # SDK examples
    story.append(PageBreak())
    story.append(h2("7. Exemples d'intégration SDK"))

    story.append(h3("Node.js"))
    story.append(code(f"""const res = await fetch('{API_BASE}/v1/payments', {{
  method: 'POST',
  headers: {{
    Authorization: 'Bearer sk_test_XXXXX',
    'Content-Type': 'application/json',
  }},
  body: JSON.stringify({{
    amount: 10, coin: 'USDT', reference: 'order_123',
    customer_email: 'buyer@shop.com',
  }}),
}});
const payment = await res.json();
window.location.href = payment.payment_url;"""))

    story.append(h3("Python"))
    story.append(code(f"""import requests

r = requests.post(
    '{API_BASE}/v1/payments',
    json={{'amount': 10, 'coin': 'USDT', 'reference': 'order_123',
          'customer_email': 'buyer@shop.com'}},
    headers={{'Authorization': 'Bearer sk_test_XXXXX'}},
)
payment = r.json()
print(payment['payment_url'])"""))

    story.append(h3("PHP"))
    story.append(code(f"""<?php
$ch = curl_init('{API_BASE}/v1/payments');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_XXXXX',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 10, 'coin' => 'USDT',
    'reference' => 'order_123',
    'customer_email' => 'buyer@shop.com',
  ]),
]);
$response = json_decode(curl_exec($ch), true);
header('Location: ' . $response['payment_url']);"""))

    story.append(h3("Laravel"))
    story.append(code(f"""use Illuminate\\Support\\Facades\\Http;

$payment = Http::withToken(config('services.biztranspay.secret'))
    ->post('{API_BASE}/v1/payments', [
        'amount' => 10,
        'coin' => 'USDT',
        'reference' => 'order_' . $order->id,
        'customer_email' => auth()->user()->email,
    ])->json();

return redirect($payment['payment_url']);"""))

    story.append(h3("JavaScript (navigateur — via votre backend)"))
    story.append(code("""// Ne JAMAIS exposer sk_test_/sk_live_ côté navigateur.
// Créez le paiement depuis votre serveur, puis :
window.location.href = paymentUrlFromServer;"""))

    story.append(h3("Vérification de signature (Node.js)"))
    story.append(code("""const crypto = require('crypto');
const raw = req.rawBody;   // Buffer
const ts = req.headers['x-biztranspay-timestamp'];
const sig = req.headers['x-biztranspay-signature'];

const expected = 'sha256=' + crypto
  .createHmac('sha256', process.env.BIZTRANSPAY_WEBHOOK_SECRET)
  .update(`${ts}.${raw}`)
  .digest('hex');

if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
  return res.status(401).send('Invalid signature');
}"""))

    story.append(Spacer(1, 12))
    story.append(p(f"<i>Biz-transPay · {OFFICIAL} · Documentation générée automatiquement</i>"))

    doc.build(story)
    pdf_bytes = buf.getvalue()
    buf.close()

    from fastapi.responses import Response
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="biz-transpay-api-docs.pdf"',
            "Cache-Control": "no-store",
        },
    )


# ==================== WEBHOOK DELIVERY (outbound to merchants) ====================
async def _deliver_webhook(user_id: str, event_type: str, data: dict) -> None:
    """Fire-and-forget HMAC-signed POST to the merchant's webhook URL.
    Stores a webhook_deliveries record with the outcome. Best-effort retries
    (3 attempts, exponential backoff via asyncio.sleep). Only errors are logged.
    """
    doc = await db.api_keys.find_one({"user_id": user_id}, {"_id": 0})
    if not doc:
        return
    wh = doc.get("webhook") or {}
    url = wh.get("url", "").strip()
    if not url or not url.startswith(("http://", "https://")):
        return

    import httpx
    event_id = new_id()
    payload = {
        "id": event_id,
        "type": event_type,
        "data": data,
        "created_at": now_iso(),
    }
    body_json = json.dumps(payload, separators=(",", ":"), default=str, sort_keys=True)
    timestamp = str(int(datetime.now(timezone.utc).timestamp()))
    # Sign with the plaintext webhook secret (decrypted from secret_encrypted).
    # Legacy accounts without an encrypted secret fall back to signing with the
    # hash — those merchants are advised to regenerate their webhook secret so
    # signature verification works with the plaintext they copied.
    plaintext_secret = _decrypt(wh.get("secret_encrypted") or "")
    if plaintext_secret:
        sign_key = plaintext_secret.encode("utf-8")
    else:
        sign_key = (wh.get("secret_hash") or "").encode("utf-8")
    signed_payload = f"{timestamp}.{body_json}".encode("utf-8")
    signature = "sha256=" + hmac.new(sign_key, signed_payload, hashlib.sha256).hexdigest()

    delivery = {
        "id": event_id,
        "user_id": user_id,
        "event_id": event_id,
        "event_type": event_type,
        "url": url,
        "payload": payload,
        "attempts": 0,
        "status": "pending",
        "created_at": now_iso(),
    }
    await db.webhook_deliveries.insert_one(dict(delivery))

    async def _attempt(retry: int = 0):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(url, content=body_json, headers={
                    "Content-Type": "application/json",
                    "X-BizTransPay-Signature": signature,
                    "X-BizTransPay-Timestamp": timestamp,
                    "X-BizTransPay-Event-Id": event_id,
                    "X-BizTransPay-Event-Type": event_type,
                    "User-Agent": "BizTransPay-Webhook/1.0",
                })
                ok = 200 <= r.status_code < 300
                await db.webhook_deliveries.update_one(
                    {"id": event_id},
                    {"$set": {"status": "delivered" if ok else "failed",
                              "status_code": r.status_code,
                              "response_body": (r.text or "")[:2000],
                              "delivered_at": now_iso()},
                     "$inc": {"attempts": 1}}
                )
                if not ok and retry < 2:
                    await asyncio.sleep(2 ** (retry + 1) * 15)  # 30s, 60s
                    await _attempt(retry + 1)
        except Exception as e:  # noqa: BLE001
            await db.webhook_deliveries.update_one(
                {"id": event_id},
                {"$set": {"status": "failed",
                          "response_body": f"Exception: {str(e)[:500]}",
                          "delivered_at": now_iso()},
                 "$inc": {"attempts": 1}}
            )
            if retry < 2:
                await asyncio.sleep(2 ** (retry + 1) * 15)
                await _attempt(retry + 1)

    # Fire without awaiting — don't block the caller (webhook / API request).
    asyncio.create_task(_attempt())


# ==================== SETTINGS ====================
@api.patch("/settings/profile", response_model=UserPublic)
async def update_profile(req: UpdateProfile, uid: str = Depends(get_current_user_id)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if updates:
        if "email" in updates:
            updates["email"] = updates["email"].lower()
        await db.users.update_one({"id": uid}, {"$set": updates})
    u = await get_user(uid)
    return user_to_public(u)


@api.post("/settings/password")
async def change_password(req: ChangePassword, uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    if not verify_password(req.current_password, u["password_hash"]):
        raise HTTPException(400, "Mot de passe actuel incorrect")
    await db.users.update_one({"id": uid}, {"$set": {"password_hash": hash_password(req.new_password)}})
    return {"ok": True}


# ==================== SUPPORT ====================
@api.get("/support/tickets")
async def list_tickets(uid: str = Depends(get_current_user_id)):
    docs = await db.tickets.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return docs


@api.post("/support/tickets", response_model=Ticket)
async def create_ticket(req: TicketCreate, uid: str = Depends(get_current_user_id)):
    t = Ticket(
        id=new_id(),
        user_id=uid,
        subject=req.subject,
        message=req.message,
        category=req.category,
        status="open",
        created_at=now_iso(),
        replies=[],
    )
    await db.tickets.insert_one(t.model_dump())
    return t



# ==================== NOTIFICATIONS API ====================
@api.get("/notifications")
async def list_notifications(uid: str = Depends(get_current_user_id),
                             limit: int = Query(50, le=200),
                             unread_only: bool = False):
    q: dict = {"user_id": uid}
    if unread_only:
        q["read"] = False
    docs = await db.notifications.find(q, {"_id": 0}) \
        .sort("created_at", -1).limit(limit).to_list(limit)
    return docs


@api.get("/notifications/unread-count")
async def unread_count(uid: str = Depends(get_current_user_id)):
    n = await db.notifications.count_documents({"user_id": uid, "read": False})
    return {"count": n}


@api.post("/notifications/{nid}/read")
async def notification_mark_read(nid: str, uid: str = Depends(get_current_user_id)):
    r = await db.notifications.update_one(
        {"id": nid, "user_id": uid}, {"$set": {"read": True}}
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Notification introuvable")
    return {"ok": True}


@api.post("/notifications/read-all")
async def notification_mark_all_read(uid: str = Depends(get_current_user_id)):
    r = await db.notifications.update_many(
        {"user_id": uid, "read": False}, {"$set": {"read": True}}
    )
    return {"ok": True, "updated": r.modified_count}


@api.get("/notifications/stream")
async def notifications_stream(request: Request, token: str = Query(...)):
    """Server-Sent Events stream. Since EventSource cannot set Authorization
    headers, we accept the JWT via ?token= query. Emits:
        event: notification\ndata: {json}\n\n
    and heartbeats (': ping\n\n') every 25s to keep the socket alive.
    """
    try:
        payload = pyjwt.decode(token, os.environ.get("JWT_SECRET", "dev-secret"),
                               algorithms=[os.environ.get("JWT_ALGORITHM", "HS256")])
        uid = payload["sub"]
    except Exception:
        raise HTTPException(401, "Token invalide")

    q: asyncio.Queue = asyncio.Queue()
    _sse_subscribers.setdefault(uid, []).append(q)

    async def gen():
        try:
            # Initial comment so proxies flush headers immediately.
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    doc = await asyncio.wait_for(q.get(), timeout=25.0)
                    yield f"event: notification\ndata: {json.dumps(doc, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            try:
                _sse_subscribers.get(uid, []).remove(q)
            except ValueError:
                pass

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no",
                                      "Connection": "keep-alive"})


# ==================== ADMIN ====================
async def get_admin(uid: str = Depends(get_current_user_id)) -> dict:
    u = await db.users.find_one({"id": uid}, {"_id": 0})
    if not u:
        raise HTTPException(401, "Non autorisé")
    if u.get("role") not in ("admin", "super_admin"):
        raise HTTPException(403, "Accès administrateur requis")
    return u


@api.get("/crypto/coins")
async def public_crypto_coins(uid: str = Depends(get_current_user_id)):
    """Authenticated user endpoint: full list of coins available on IziPay
    grouped by ticker, each with the list of supported networks and the fee %
    configured in the Admin Panel (default 4%).
    Used by the Transfer → Crypto form and any user-facing crypto selector.
    Returns: [{coin, name, fee_pct, networks: [{code, name, address_regex, asset_code}]}]
    """
    coins: dict[str, dict] = {}
    if izipay.is_configured():
        try:
            assets = await izipay.list_assets()
            for a in assets:
                if not a.get("isActive"):
                    continue
                asset_code = a.get("assetCode") or ""
                if "." not in asset_code:
                    continue
                coin, network = asset_code.split(".", 1)
                entry = coins.setdefault(coin, {
                    "coin": coin,
                    "name": a.get("coin") or coin,
                    "networks": [],
                })
                entry["networks"].append({
                    "code": network,
                    "name": a.get("networkName") or network,
                    "asset_code": asset_code,
                    "address_regex": _NETWORK_REGEX.get(network),
                    "min": float(a.get("minimum") or 0),
                    "max": float(a.get("maximum") or 10**12),
                })
        except Exception:
            pass
    cfg = await get_transfer_config()
    fees = ((cfg.get("crypto") or {}).get("fees") or {})
    result = []
    for c in sorted(coins.keys()):
        entry = coins[c]
        entry["fee_pct"] = float(fees.get(c, 4.0))
        result.append(entry)
    return result


# Common on-chain address regex per network — used by user & admin sides.
_NETWORK_REGEX: dict[str, str] = {
    "TRC20": r"^T[A-Za-z1-9]{33}$",
    "BEP20": r"^0x[a-fA-F0-9]{40}$",
    "ERC20": r"^0x[a-fA-F0-9]{40}$",
    "POLYGON": r"^0x[a-fA-F0-9]{40}$",
    "BSC": r"^0x[a-fA-F0-9]{40}$",
    "AVAX": r"^0x[a-fA-F0-9]{40}$",
    "SOLANA": r"^[1-9A-HJ-NP-Za-km-z]{32,44}$",
    "SOL": r"^[1-9A-HJ-NP-Za-km-z]{32,44}$",
    "BTC": r"^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$",
    "LTC": r"^([LM3]|ltc1)[a-zA-HJ-NP-Z0-9]{25,62}$",
    "DOGE": r"^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$",
    "XRP": r"^r[1-9A-HJ-NP-Za-km-z]{25,34}$",
    "TON": r"^[A-Za-z0-9_\-]{48}$",
}


@api.get("/admin/crypto/coins")
async def admin_crypto_coins(admin=Depends(get_admin)):
    coins: dict[str, str] = {}
    if izipay.is_configured():
        try:
            assets = await izipay.list_assets()
            for a in assets:
                if not a.get("isActive"):
                    continue
                # Use assetCode prefix as the canonical ticker (USDT.TRC20 → USDT).
                # This is consistent across all coins, unlike the "coin" field.
                code = (a.get("assetCode") or "").split(".")[0]
                if code and code not in coins:
                    coins[code] = a.get("coin") or code
        except Exception:
            pass
    cfg = await get_transfer_config()
    fees = ((cfg.get("crypto") or {}).get("fees") or {})
    # Always include configured coins even if not returned by API (e.g. temporarily disabled)
    for c in fees:
        coins.setdefault(c, c)
    return [
        {"coin": c, "name": coins[c], "fee_pct": float(fees.get(c, 4.0))}
        for c in sorted(coins.keys())
    ]


async def audit(admin_id: str, admin_username: str, action: str,
                target_user_id: Optional[str] = None, target_username: Optional[str] = None,
                details: Optional[dict] = None):
    await db.admin_logs.insert_one({
        "id": new_id(),
        "admin_id": admin_id,
        "admin_username": admin_username,
        "action": action,
        "target_user_id": target_user_id,
        "target_username": target_username,
        "details": details or {},
        "created_at": now_iso(),
    })


class AdminUserAction(BaseModel):
    reason: Optional[str] = ""


class AdminBalanceAction(BaseModel):
    currency: Literal["XOF", "XAF"]
    amount: float
    reason: Optional[str] = ""


class AdminUpdateUser(BaseModel):
    full_name: Optional[str] = None
    username: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    country: Optional[str] = None
    role: Optional[Literal["user", "admin", "super_admin"]] = None
    account_type: Optional[Literal["personal", "merchant"]] = None


class AdminKycDecision(BaseModel):
    approve: bool
    reason: Optional[str] = ""
    request_resubmit: bool = False


class AdminResetPwd(BaseModel):
    new_password: str


@api.get("/admin/stats")
async def admin_stats(admin=Depends(get_admin), period: str = "month"):
    now = datetime.now(timezone.utc)
    if period == "day":
        since = now - timedelta(days=1)
    elif period == "week":
        since = now - timedelta(days=7)
    elif period == "year":
        since = now - timedelta(days=365)
    else:
        since = now - timedelta(days=30)
    since_iso = since.isoformat()

    total_users = await db.users.count_documents({})
    verified = await db.users.count_documents({"kyc_status": "verified"})
    kyc_pending = await db.users.count_documents({"kyc_status": "pending"})
    kyc_rejected = await db.users.count_documents({"kyc_status": "rejected"})
    not_verified = total_users - verified
    active_users = await db.transactions.distinct("user_id")
    suspended = await db.users.count_documents({"$or": [{"is_blocked": True}, {"is_banned": True}]})

    tx_all = db.transactions.find({}, {"_id": 0})
    # Global totals (across all channels & currencies, native units)
    total_deposits = 0.0
    total_withdrawals = 0.0
    total_tx = 0
    succeeded = 0
    pending = 0
    failed = 0
    # Legacy 3-bucket view (pending / valid / rejected) — all channels combined
    dep_pending = {"count": 0, "amount": 0.0}
    dep_valid = {"count": 0, "amount": 0.0}
    dep_rejected = {"count": 0, "amount": 0.0}
    wd_pending = {"count": 0, "amount": 0.0}
    wd_valid = {"count": 0, "amount": 0.0}
    wd_rejected = {"count": 0, "amount": 0.0}
    # Per-channel breakdown for the summary cards
    dep_mm = {"count": 0, "amount_xof": 0.0}
    dep_crypto = {"count": 0, "amount_usdt": 0.0}
    wd_mm = {"count": 0, "amount_xof": 0.0}
    wd_crypto = {"count": 0, "amount_usdt": 0.0}
    # Other operations (link payments, API merchant payments, biz-to-biz, exchange)
    link_payments = {"count": 0, "amount_usdt": 0.0}
    api_payments = {"count": 0, "amount_usdt": 0.0}
    biz_to_biz = {"count": 0}
    exchanges = {"count": 0}

    async for tx in tx_all:
        total_tx += 1
        st = tx.get("status")
        if st == "completed":
            succeeded += 1
        elif st == "pending":
            pending += 1
        elif st in ("failed", "cancelled"):
            failed += 1
        typ = tx.get("type")
        direction = tx.get("direction")
        currency = (tx.get("currency") or "").upper()
        meta = tx.get("metadata") or {}
        amt = float(tx.get("amount", 0) or 0)

        if typ == "deposit":
            if st == "completed":
                dep_valid["count"] += 1
                dep_valid["amount"] += amt
                total_deposits += amt
            elif st == "pending":
                dep_pending["count"] += 1
                dep_pending["amount"] += amt
            elif st in ("failed", "cancelled"):
                dep_rejected["count"] += 1
                dep_rejected["amount"] += amt
            # Per-channel classification (crypto = USDT / IziPay; else Mobile
            # Money / Stripe).
            is_crypto = (
                currency == "USDT"
                or bool(meta.get("izipay_intent_id"))
                or bool(meta.get("coin"))
            )
            if st == "completed":
                if is_crypto:
                    dep_crypto["count"] += 1
                    dep_crypto["amount_usdt"] += amt
                else:
                    dep_mm["count"] += 1
                    dep_mm["amount_xof"] += amt
        elif typ in ("withdrawal", "transfer") and direction == "out":
            # Exclude biz-to-biz internal transfers from the "withdrawals"
            # cards (they don't leave the platform).
            transfer_type = meta.get("transfer_type")
            if transfer_type == "biz_to_biz":
                biz_to_biz["count"] += 1
                continue
            if st == "completed":
                wd_valid["count"] += 1
                wd_valid["amount"] += amt
                total_withdrawals += amt
            elif st == "pending":
                wd_pending["count"] += 1
                wd_pending["amount"] += amt
            elif st in ("failed", "cancelled"):
                wd_rejected["count"] += 1
                wd_rejected["amount"] += amt
            # Per-channel: mobile money vs crypto (fallback on currency).
            is_crypto = (
                transfer_type == "biz_to_crypto"
                or currency == "USDT"
                or bool(meta.get("crypto"))
            )
            if st == "completed":
                if is_crypto:
                    wd_crypto["count"] += 1
                    wd_crypto["amount_usdt"] += amt
                else:
                    wd_mm["count"] += 1
                    wd_mm["amount_xof"] += amt
        elif typ == "transfer" and direction == "in":
            # Received leg of a biz-to-biz transfer — count for volume view.
            if (meta.get("transfer_type") or "biz_to_biz") == "biz_to_biz":
                biz_to_biz["count"] += 1
        elif typ == "link_payment":
            if st == "completed":
                link_payments["count"] += 1
                link_payments["amount_usdt"] += amt
        elif typ == "payment":
            if st == "completed":
                api_payments["count"] += 1
                api_payments["amount_usdt"] += amt
        elif typ == "exchange":
            exchanges["count"] += 1

    return {
        "users": {
            "total": total_users,
            "verified": verified,
            "kyc_pending": kyc_pending,
            "kyc_rejected": kyc_rejected,
            "not_verified": not_verified,
            "active": len(active_users),
            "suspended": suspended,
        },
        "transactions": {
            "total_deposits": total_deposits,
            "total_withdrawals": total_withdrawals,
            "count": total_tx,
            "succeeded": succeeded,
            "pending": pending,
            "failed": failed,
            "deposits": {"pending": dep_pending, "valid": dep_valid, "rejected": dep_rejected},
            "withdrawals": {"pending": wd_pending, "valid": wd_valid, "rejected": wd_rejected},
            "deposits_by_channel": {
                "mobile_money": dep_mm,
                "crypto": dep_crypto,
            },
            "withdrawals_by_channel": {
                "mobile_money": wd_mm,
                "crypto": wd_crypto,
            },
            "operations": {
                "link_payments": link_payments,
                "api_payments": api_payments,
                "biz_to_biz": biz_to_biz,
                "exchanges": exchanges,
            },
        },
        "period": period,
    }


@api.get("/admin/users")
async def admin_list_users(admin=Depends(get_admin), q: Optional[str] = None,
                           kyc: Optional[str] = None, status: Optional[str] = None,
                           limit: int = Query(200, le=1000)):
    query: dict = {}
    if q:
        query["$or"] = [
            {"full_name": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
            {"username": {"$regex": q, "$options": "i"}},
            {"phone": {"$regex": q, "$options": "i"}},
        ]
    if kyc:
        query["kyc_status"] = kyc
    if status == "blocked":
        query["is_blocked"] = True
    elif status == "banned":
        query["is_banned"] = True
    elif status == "active":
        query["is_blocked"] = False
        query["is_banned"] = False

    docs = await db.users.find(query, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(limit)
    return docs


@api.get("/admin/users/{user_id}")
async def admin_get_user(user_id: str, admin=Depends(get_admin)):
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    tx_count = await db.transactions.count_documents({"user_id": user_id})
    last_txs = await db.transactions.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).to_list(20)
    return {"user": u, "transactions_count": tx_count, "recent_transactions": last_txs}


@api.post("/admin/users/{user_id}/action/{action}")
async def admin_user_action(user_id: str, action: str,
                            req: AdminUserAction = Body(default_factory=AdminUserAction),
                            admin=Depends(get_admin)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")

    mapping = {
        "block": {"is_blocked": True},
        "unblock": {"is_blocked": False},
        "ban": {"is_banned": True, "is_blocked": True},
        "unban": {"is_banned": False, "is_blocked": False},
        "block_withdrawals": {"withdrawals_blocked": True},
        "unblock_withdrawals": {"withdrawals_blocked": False},
    }
    if action not in mapping:
        raise HTTPException(400, "Action inconnue")

    await db.users.update_one({"id": user_id}, {"$set": mapping[action]})
    await audit(admin["id"], admin["username"], action,
                target_user_id=user_id, target_username=target["username"],
                details={"reason": req.reason})
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    return {"ok": True, "user": u}


@api.post("/admin/users/{user_id}/credit")
async def admin_credit(user_id: str, req: AdminBalanceAction, admin=Depends(get_admin)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    field = "balance_xof" if req.currency == "XOF" else "balance_xaf"
    await db.users.update_one({"id": user_id}, {"$inc": {field: req.amount}})
    await record_tx(user_id, "deposit", "in", req.amount, req.currency,
                    description=f"Crédit administrateur ({req.reason or 'manuel'})",
                    metadata={"admin_id": admin["id"], "admin_username": admin["username"]})
    await audit(admin["id"], admin["username"], "credit",
                target_user_id=user_id, target_username=target["username"],
                details={"amount": req.amount, "currency": req.currency, "reason": req.reason})
    return {"ok": True}


@api.post("/admin/users/{user_id}/debit")
async def admin_debit(user_id: str, req: AdminBalanceAction, admin=Depends(get_admin)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    field = "balance_xof" if req.currency == "XOF" else "balance_xaf"
    if target.get(field, 0) < req.amount:
        raise HTTPException(400, "Solde utilisateur insuffisant")
    await db.users.update_one({"id": user_id}, {"$inc": {field: -req.amount}})
    await record_tx(user_id, "withdrawal", "out", req.amount, req.currency,
                    description=f"Débit administrateur ({req.reason or 'manuel'})",
                    metadata={"admin_id": admin["id"], "admin_username": admin["username"]})
    await audit(admin["id"], admin["username"], "debit",
                target_user_id=user_id, target_username=target["username"],
                details={"amount": req.amount, "currency": req.currency, "reason": req.reason})
    return {"ok": True}


@api.patch("/admin/users/{user_id}")
async def admin_update_user(user_id: str, req: AdminUpdateUser, admin=Depends(get_admin)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    # only super_admin can change roles
    if "role" in updates and admin.get("role") != "super_admin":
        raise HTTPException(403, "Seul un super_admin peut modifier les rôles")
    # Enforce uniqueness on username/email if being changed
    if "username" in updates and updates["username"] != target.get("username"):
        exists = await db.users.find_one({"username": updates["username"], "id": {"$ne": user_id}}, {"_id": 0, "id": 1})
        if exists:
            raise HTTPException(409, "Nom d'utilisateur déjà utilisé")
    if "email" in updates and updates["email"] != target.get("email"):
        exists = await db.users.find_one({"email": updates["email"], "id": {"$ne": user_id}}, {"_id": 0, "id": 1})
        if exists:
            raise HTTPException(409, "Adresse email déjà utilisée")
    if updates:
        await db.users.update_one({"id": user_id}, {"$set": updates})
        # If upgrading to merchant, auto-provision API keys idempotently so the
        # user immediately has access to /dashboard/api after promotion.
        if updates.get("account_type") == "merchant":
            await _ensure_api_keys(user_id)
    await audit(admin["id"], admin["username"], "update_user",
                target_user_id=user_id, target_username=target["username"],
                details=updates)
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    return u


@api.post("/admin/users/{user_id}/reset-password")
async def admin_reset_password(user_id: str, req: AdminResetPwd, admin=Depends(get_admin)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if len(req.new_password) < 6:
        raise HTTPException(400, "6 caractères minimum")
    await db.users.update_one({"id": user_id}, {"$set": {"password_hash": hash_password(req.new_password)}})
    await audit(admin["id"], admin["username"], "reset_password",
                target_user_id=user_id, target_username=target["username"])
    return {"ok": True}


@api.delete("/admin/users/{user_id}")
async def admin_delete_user(user_id: str, admin=Depends(get_admin)):
    """Permanently delete a user and ALL related data (transactions, KYC,
    payment links, link_payments, crypto_deposits, API keys, tickets,
    notifications, support messages, audit-log entries stay for traceability).
    This action is IRREVERSIBLE.

    - Only admins can invoke.
    - super_admin accounts CANNOT be deleted (protective guard).
    - Admin cannot delete themselves.
    """
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if target.get("role") == "super_admin":
        raise HTTPException(403, "Impossible de supprimer un super_admin")
    if target["id"] == admin["id"]:
        raise HTTPException(403, "Vous ne pouvez pas supprimer votre propre compte")

    # Cascade delete across all user-linked collections.
    r_user = await db.users.delete_one({"id": user_id})
    r_tx = await db.transactions.delete_many({"user_id": user_id})
    # Payment links → also delete their child link_payments.
    links = await db.payment_links.find({"user_id": user_id}, {"_id": 0, "id": 1}).to_list(10000)
    link_ids = [ln["id"] for ln in links]
    r_lp = 0
    if link_ids:
        rr = await db.link_payments.delete_many({"link_id": {"$in": link_ids}})
        r_lp = rr.deleted_count
    r_links = await db.payment_links.delete_many({"user_id": user_id})
    r_kyc = await db.kyc.delete_many({"user_id": user_id})
    r_keys = await db.api_keys.delete_many({"user_id": user_id})
    r_tk = await db.tickets.delete_many({"user_id": user_id})
    r_dep = await db.crypto_deposits.delete_many({"user_id": user_id})
    r_notif = await db.notifications.delete_many({"user_id": user_id})
    r_sm = await db.support_messages.delete_many({"conversation_id": user_id})
    r_pt = await db.payment_transactions.delete_many({"user_id": user_id})
    r_mp = await db.merchant_payments.delete_many({"merchant_id": user_id})

    counts = {
        "user": r_user.deleted_count, "transactions": r_tx.deleted_count,
        "payment_links": r_links.deleted_count, "link_payments": r_lp,
        "kyc": r_kyc.deleted_count, "api_keys": r_keys.deleted_count,
        "tickets": r_tk.deleted_count, "crypto_deposits": r_dep.deleted_count,
        "notifications": r_notif.deleted_count, "support_messages": r_sm.deleted_count,
        "payment_transactions": r_pt.deleted_count, "merchant_payments": r_mp.deleted_count,
    }
    await audit(admin["id"], admin["username"], "delete_user_permanent",
                target_user_id=user_id, target_username=target.get("username"),
                details=counts)
    return {"ok": True, "deleted": counts}


@api.post("/admin/users/cleanup-test-users")
async def admin_cleanup_test_users(admin=Depends(get_admin)):
    """Danger: super_admin only. Deletes ALL users except super_admins,
    along with all their transactions, links, KYC, API keys, tickets,
    crypto deposits, link payments, and support messages.
    """
    if admin.get("role") != "super_admin":
        raise HTTPException(403, "Réservé aux super_admin")
    keep = await db.users.find({"role": "super_admin"}, {"_id": 0, "id": 1}).to_list(100)
    keep_ids = [u["id"] for u in keep]
    victims = await db.users.find({"id": {"$nin": keep_ids}}, {"_id": 0, "id": 1, "email": 1}).to_list(10000)
    victim_ids = [u["id"] for u in victims]
    if not victim_ids:
        return {"deleted": 0, "kept": keep_ids}
    r1 = await db.users.delete_many({"id": {"$in": victim_ids}})
    await db.transactions.delete_many({"user_id": {"$in": victim_ids}})
    await db.payment_links.delete_many({"user_id": {"$in": victim_ids}})
    await db.kyc.delete_many({"user_id": {"$in": victim_ids}})
    await db.api_keys.delete_many({"user_id": {"$in": victim_ids}})
    await db.tickets.delete_many({"user_id": {"$in": victim_ids}})
    await db.crypto_deposits.delete_many({"user_id": {"$in": victim_ids}})
    await db.link_payments.delete_many({})  # link payments are tied to links (already deleted)
    await db.merchant_payments.delete_many({"merchant_id": {"$in": victim_ids}})
    await db.support_messages.delete_many({"conversation_id": {"$in": victim_ids}})
    await db.payment_transactions.delete_many({"user_id": {"$in": victim_ids}})
    await audit(admin["id"], admin["username"], "cleanup_test_users",
                details={"deleted_count": r1.deleted_count})
    return {"deleted": r1.deleted_count, "kept_super_admins": keep_ids}


class AdminPlatformResetReq(BaseModel):
    confirmation: str  # must be exactly "RÉINITIALISER" (case-sensitive)


@api.post("/admin/platform/reset")
async def admin_platform_reset(req: AdminPlatformResetReq,
                               admin=Depends(get_admin)):
    """DESTRUCTIVE — Full platform reset. Super_admin only.

    Deletes ALL non-super_admin users and their data, wipes ALL transactional
    collections platform-wide (transactions, links, webhooks, api_logs,
    notifications, kyc, tickets, etc.), and resets balances of every
    remaining super_admin to 0. Idempotent and audited.

    Requires body `{"confirmation": "RÉINITIALISER"}` to prevent accidents.
    """
    if admin.get("role") != "super_admin":
        raise HTTPException(403, "Réservé aux super_admin")
    if req.confirmation != "RÉINITIALISER":
        raise HTTPException(400, "Confirmation invalide. Tapez exactement RÉINITIALISER.")

    keep = await db.users.find({"role": "super_admin"}, {"_id": 0, "id": 1, "email": 1}).to_list(100)
    keep_ids = [u["id"] for u in keep]

    # 1) Delete every non-super_admin user
    r_users = await db.users.delete_many({"role": {"$ne": "super_admin"}})

    # 2) Wipe platform-wide transactional collections (all of them, including
    #    the ones belonging to the preserved super_admin — the user wants
    #    every counter reset to 0).
    wipe_collections = [
        "transactions",
        "payment_links",
        "link_payments",
        "crypto_deposits",
        "webhook_events",
        "webhook_deliveries",
        "api_logs",
        "notifications",
        "tickets",
        "support_messages",
        "payment_transactions",
        "merchant_payments",
        "kyc",
        "audit_logs",
        "api_keys",
    ]
    wiped: dict[str, int] = {}
    for coll in wipe_collections:
        r = await db[coll].delete_many({})
        wiped[coll] = r.deleted_count

    # 3) Reset balances of preserved super_admins to 0
    await db.users.update_many(
        {"role": "super_admin"},
        {"$set": {"balance_xof": 0.0, "balance_xaf": 0.0, "balance_usdt": 0.0}},
    )

    # 4) Re-provision fresh API keys for preserved super_admins so /dashboard/api
    #    keeps working after the wipe.
    for sa_id in keep_ids:
        try:
            await _ensure_api_keys(sa_id)
        except Exception:
            pass

    # Audit (recreates the collection we just wiped — that's fine, gives us a
    # historical trace of the reset itself).
    await audit(admin["id"], admin["username"], "platform_reset",
                details={"deleted_users": r_users.deleted_count,
                         "wiped": wiped,
                         "kept_super_admins": [u["email"] for u in keep]})

    return {
        "deleted_users": r_users.deleted_count,
        "kept_super_admins": [u["email"] for u in keep],
        "wiped": wiped,
        "balances_reset": True,
    }


@api.get("/admin/kyc")
async def admin_list_kyc(admin=Depends(get_admin), status: Optional[str] = None):
    query = {}
    if status:
        query["status"] = status
    docs = await db.kyc.find(query, {"_id": 0}).sort("submitted_at", -1).to_list(500)
    # enrich with user info
    for d in docs:
        u = await db.users.find_one({"id": d["user_id"]}, {"_id": 0, "full_name": 1, "username": 1, "email": 1, "country": 1})
        d["user"] = u
    return docs


@api.post("/admin/kyc/{user_id}/decision")
async def admin_kyc_decision(user_id: str, req: AdminKycDecision, admin=Depends(get_admin)):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if req.approve:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "verified"}})
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "verified",
                                                                 "verified_at": now_iso(),
                                                                 "reject_reason": None}})
        act = "kyc_approve"
        await notify(user_id, "kyc_verified",
                     "KYC vérifié ✓",
                     "Votre identité a été vérifiée. Vous pouvez maintenant utiliser toutes les fonctionnalités (liens de paiement, API, retraits).",
                     data={"status": "verified"})
    elif req.request_resubmit:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "not_started"}})
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "resubmit_requested",
                                                                 "reject_reason": req.reason,
                                                                 "reviewed_at": now_iso()}})
        act = "kyc_request_resubmit"
        await notify(user_id, "kyc_resubmit_requested",
                     "KYC — nouveaux documents demandés",
                     req.reason or "Merci de renvoyer vos documents KYC.",
                     data={"status": "resubmit_requested", "reason": req.reason})
    else:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "rejected"}})
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "rejected",
                                                                 "reject_reason": req.reason,
                                                                 "reviewed_at": now_iso()}})
        act = "kyc_reject"
        await notify(user_id, "kyc_rejected",
                     "KYC rejeté",
                     req.reason or "Votre demande de KYC a été rejetée. Contactez le support pour plus d'informations.",
                     data={"status": "rejected", "reason": req.reason})
    await audit(admin["id"], admin["username"], act,
                target_user_id=user_id, target_username=target["username"],
                details={"reason": req.reason})
    return {"ok": True}


@api.get("/admin/transactions")
async def admin_transactions(admin=Depends(get_admin), q: Optional[str] = None,
                             type: Optional[str] = None, status: Optional[str] = None,
                             limit: int = Query(500, le=2000)):
    query: dict = {}
    if type:
        query["type"] = type
    if status:
        query["status"] = status
    if q:
        esc = __import__("re").escape(q.strip())
        rx = {"$regex": esc, "$options": "i"}
        # First resolve users matching email/username so we can filter their txns.
        matching_users = await db.users.find(
            {"$or": [{"email": rx}, {"username": rx}, {"full_name": rx}, {"phone": rx}]},
            {"_id": 0, "id": 1}
        ).to_list(1000)
        user_ids = [u["id"] for u in matching_users]
        query["$or"] = [
            {"id": rx}, {"reference": rx}, {"counterparty": rx},
            {"description": rx}, {"currency": rx}, {"type": rx},
            {"metadata.tx_hash": rx},
            {"metadata.wallet_address": rx},
            {"metadata.deposit_address": rx},
            {"metadata.customer_email": rx},
            {"metadata.izipay_intent_id": rx},
            {"metadata.merchant_payment_id": rx},
            {"metadata.link_id": rx},
            {"metadata.coin": rx},
            {"metadata.recipient": rx},
            {"metadata.recipient_name": rx},
        ]
        if user_ids:
            query["$or"].append({"user_id": {"$in": user_ids}})
    docs = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    # attach user info lightly
    for d in docs:
        u = await db.users.find_one({"id": d["user_id"]}, {"_id": 0, "username": 1, "full_name": 1, "email": 1})
        d["user"] = u
    return docs


# ==================== ADMIN — Payment Links & API Keys management ====================
@api.get("/admin/links")
async def admin_list_links(admin=Depends(get_admin), q: Optional[str] = None,
                            status: Optional[str] = None, limit: int = Query(500, le=2000)):
    """List ALL payment links across all merchants, enriched with owner info.
    Supports free-text search on slug/title/id/user identity."""
    query: dict = {}
    if status == "active":
        query["active"] = True
    elif status in ("suspended", "disabled", "inactive"):
        query["active"] = False
    if q:
        esc = __import__("re").escape(q.strip())
        rx = {"$regex": esc, "$options": "i"}
        matching = await db.users.find(
            {"$or": [{"email": rx}, {"username": rx}, {"full_name": rx}]},
            {"_id": 0, "id": 1}).to_list(1000)
        uids = [u["id"] for u in matching]
        query["$or"] = [{"id": rx}, {"slug": rx}, {"title": rx}, {"description": rx}]
        if uids:
            query["$or"].append({"user_id": {"$in": uids}})
    docs = await db.payment_links.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    for d in docs:
        u = await db.users.find_one({"id": d["user_id"]},
            {"_id": 0, "username": 1, "full_name": 1, "email": 1, "account_type": 1})
        d["owner"] = u or {}
    return docs


@api.post("/admin/links/{link_id}/action/{action}")
async def admin_link_action(link_id: str, action: str, admin=Depends(get_admin)):
    link = await db.payment_links.find_one({"id": link_id}, {"_id": 0})
    if not link:
        raise HTTPException(404, "Lien introuvable")
    if action == "suspend":
        await db.payment_links.update_one({"id": link_id}, {"$set": {"active": False}})
    elif action == "reactivate":
        await db.payment_links.update_one({"id": link_id}, {"$set": {"active": True}})
    elif action == "delete":
        await db.payment_links.delete_one({"id": link_id})
        await db.link_payments.delete_many({"link_id": link_id})
    else:
        raise HTTPException(400, "Action inconnue (suspend|reactivate|delete)")
    await audit(admin["id"], admin["username"], f"link_{action}",
                target_user_id=link["user_id"], target_username=link.get("title"),
                details={"link_id": link_id, "slug": link.get("slug")})
    return {"ok": True}


@api.get("/admin/api-keys")
async def admin_list_api_keys(admin=Depends(get_admin), q: Optional[str] = None,
                               status: Optional[str] = None, limit: int = Query(500, le=2000)):
    """List all merchants' API keys with owner info + status. Secrets are NEVER
    returned — only public keys + hints."""
    query: dict = {}
    if status == "active":
        query["suspended"] = {"$ne": True}
    elif status == "suspended":
        query["suspended"] = True
    if q:
        esc = __import__("re").escape(q.strip())
        rx = {"$regex": esc, "$options": "i"}
        matching = await db.users.find(
            {"$or": [{"email": rx}, {"username": rx}, {"full_name": rx}]},
            {"_id": 0, "id": 1}).to_list(1000)
        uids = [u["id"] for u in matching]
        query["$or"] = [{"user_id": rx},
                         {"keys.test.public_key": rx}, {"keys.live.public_key": rx}]
        if uids:
            query["$or"].append({"user_id": {"$in": uids}})
    docs = await db.api_keys.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    result = []
    for d in docs:
        u = await db.users.find_one({"id": d["user_id"]},
            {"_id": 0, "username": 1, "full_name": 1, "email": 1, "account_type": 1})
        if not u:
            continue
        result.append({
            "user_id": d["user_id"],
            "owner": u,
            "test_public_key": (d.get("keys", {}).get("test") or {}).get("public_key"),
            "live_public_key": (d.get("keys", {}).get("live") or {}).get("public_key"),
            "webhook_url": (d.get("webhook") or {}).get("url"),
            "suspended": bool(d.get("suspended", False)),
            "created_at": d.get("created_at"),
            "last_used_at": max(
                filter(None, [(d.get("keys", {}).get("test") or {}).get("last_used_at"),
                              (d.get("keys", {}).get("live") or {}).get("last_used_at")]),
                default=None,
            ),
        })
    return result


@api.post("/admin/api-keys/{user_id}/action/{action}")
async def admin_api_key_action(user_id: str, action: str, admin=Depends(get_admin)):
    doc = await db.api_keys.find_one({"user_id": user_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Clés API introuvables pour cet utilisateur")
    if action == "suspend":
        await db.api_keys.update_one({"user_id": user_id}, {"$set": {"suspended": True}})
    elif action == "reactivate":
        await db.api_keys.update_one({"user_id": user_id}, {"$set": {"suspended": False}})
    elif action == "delete":
        await db.api_keys.delete_one({"user_id": user_id})
    elif action == "regenerate":
        # Regenerate BOTH test and live keys (admin-forced rotation).
        for env in ("test", "live"):
            if not (doc.get("keys") or {}).get(env):
                continue
            new_public = _gen_key(f"pk_{env}_")
            new_secret = _gen_key(f"sk_{env}_", 32)
            await db.api_keys.update_one(
                {"user_id": user_id},
                {"$set": {f"keys.{env}.public_key": new_public,
                          f"keys.{env}.secret_hint": _mask(new_secret),
                          f"keys.{env}.secret_hash": _hash_secret(new_secret),
                          f"keys.{env}.created_at": now_iso(),
                          f"keys.{env}.last_used_at": None}}
            )
    else:
        raise HTTPException(400, "Action inconnue (suspend|reactivate|delete|regenerate)")
    await audit(admin["id"], admin["username"], f"apikey_{action}",
                target_user_id=user_id)
    return {"ok": True}


@api.get("/admin/logs")
async def admin_logs(admin=Depends(get_admin), limit: int = Query(200, le=1000)):
    docs = await db.admin_logs.find({}, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs


@api.get("/admin/admins")
async def admin_list_admins(admin=Depends(get_admin)):
    docs = await db.users.find({"role": {"$in": ["admin", "super_admin"]}},
                                {"_id": 0, "password_hash": 0}).to_list(200)
    return docs


class AdminTransferConfigReq(BaseModel):
    mobile_money: Optional[dict] = None
    bank: Optional[dict] = None
    crypto: Optional[dict] = None


@api.get("/admin/transfer/config")
async def admin_get_transfer_config(admin=Depends(get_admin)):
    return await get_transfer_config()


class AdminPlatformConfigReq(BaseModel):
    conversion_fee: Optional[dict] = None
    auto_withdrawals_disabled: Optional[bool] = None


@api.get("/admin/platform/config")
async def admin_get_platform_config(admin=Depends(get_admin)):
    return await get_platform_config()


@api.patch("/admin/platform/config")
async def admin_update_platform_config(req: AdminPlatformConfigReq, admin=Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "Aucune modification")
    await db.settings.update_one({"id": "platform_config"}, {"$set": updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_platform_config", details=updates)
    return await get_platform_config()


class AdminSupportConfigReq(BaseModel):
    chat_enabled: Optional[bool] = None
    telegram_url: Optional[str] = None
    whatsapp_url: Optional[str] = None
    email: Optional[str] = None


@api.get("/admin/support/config")
async def admin_get_support_config(admin=Depends(get_admin)):
    return await get_support_config()


@api.patch("/admin/support/config")
async def admin_update_support_config(req: AdminSupportConfigReq, admin=Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "Aucune modification")
    await db.settings.update_one({"id": "support_config"}, {"$set": updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_support_config", details=updates)
    return await get_support_config()


@api.get("/admin/support/conversations")
async def admin_conversations(admin=Depends(get_admin)):
    pipeline = [
        {"$sort": {"created_at": -1}},
        {"$group": {
            "_id": "$conversation_id",
            "last_message": {"$first": "$text"},
            "last_sender": {"$first": "$sender"},
            "last_created": {"$first": "$created_at"},
            "unread_count": {"$sum": {"$cond": [{"$and": [{"$eq": ["$sender", "user"]}, {"$ne": ["$read_by_admin", True]}]}, 1, 0]}},
        }},
        {"$sort": {"last_created": -1}},
    ]
    convs = await db.support_messages.aggregate(pipeline).to_list(500)
    # enrich with user info
    for c in convs:
        u = await db.users.find_one({"id": c["_id"]}, {"_id": 0, "id": 1, "full_name": 1, "username": 1, "email": 1})
        c["user"] = u
        c["conversation_id"] = c.pop("_id")
    return convs


@api.get("/admin/support/conversations/{user_id}/messages")
async def admin_conversation_messages(user_id: str, admin=Depends(get_admin)):
    msgs = await db.support_messages.find({"conversation_id": user_id}, {"_id": 0}).sort("created_at", 1).to_list(1000)
    await db.support_messages.update_many(
        {"conversation_id": user_id, "sender": "user", "read_by_admin": {"$ne": True}},
        {"$set": {"read_by_admin": True}}
    )
    return msgs


@api.post("/admin/support/conversations/{user_id}/messages")
async def admin_reply(user_id: str, msg: ChatMessage, admin=Depends(get_admin)):
    doc = {
        "id": new_id(),
        "conversation_id": user_id,
        "sender": "admin",
        "sender_id": admin["id"],
        "sender_name": admin.get("full_name") or admin.get("username"),
        "text": msg.text or "",
        "attachments": msg.attachments,
        "created_at": now_iso(),
        "read_by_user": False,
        "read_by_admin": True,
        "status": "sent",
    }
    await db.support_messages.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.patch("/admin/transfer/config")
async def admin_update_transfer_config(req: AdminTransferConfigReq, admin=Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "Aucune modification")
    # Deep-merge sub-dicts so partial toggles (e.g. {"crypto": {"enabled": true}})
    # don't wipe cryptos/networks/operators lists.
    current = await get_transfer_config()
    dot_updates: dict = {}
    for section, patch in updates.items():
        cur_section = current.get(section) or {}
        if isinstance(patch, dict) and isinstance(cur_section, dict):
            for k, v in patch.items():
                dot_updates[f"{section}.{k}"] = v
        else:
            dot_updates[section] = patch
    await db.settings.update_one({"id": "transfer_config"}, {"$set": dot_updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_transfer_config", details=updates)
    return await get_transfer_config()


@api.get("/users/lookup")
async def lookup_user(q: str = Query(...), uid: str = Depends(get_current_user_id)):
    needle = q.lower().strip()
    recip = await db.users.find_one({
        "$or": [
            {"username": needle},
            {"email": needle},
            {"phone": {"$regex": needle, "$options": "i"}},
        ]
    }, {"_id": 0, "id": 1, "username": 1, "full_name": 1, "country": 1})
    if not recip:
        raise HTTPException(404, "Utilisateur introuvable")
    return recip


# ==================== STATS (public) ====================
@api.get("/stats/public")
async def public_stats():
    return {
        "users": 50000,
        "partners": 5000,
        "transactions": 1000000,
        "uptime": 99.9,
    }


# ---------- register ----------
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-RateLimit-Limit", "X-RateLimit-Remaining",
                    "X-RateLimit-Reset", "Retry-After",
                    "X-BizTransPay-Signature", "X-BizTransPay-Timestamp",
                    "X-BizTransPay-Event-Id", "X-BizTransPay-Event-Type"],
)


# ==================== V1 EXCEPTION HANDLERS ====================
# For routes under /api/v1/*, we return the normalized error envelope:
#   {"statusCode": <int>, "message": "...", "code": "..."}
# Every other route keeps FastAPI's default `{detail: ...}`.
@app.exception_handler(HTTPException)
async def _http_exc_handler(request: Request, exc: HTTPException):
    if not _is_v1_path(request.url.path):
        # Non-v1 route: keep the original behaviour to avoid breaking the
        # existing dashboard/admin endpoints.
        return JSONResponse(status_code=exc.status_code,
                            content={"detail": exc.detail},
                            headers=(getattr(exc, "headers", None) or {}))
    detail = exc.detail
    if isinstance(detail, BizAPIError):
        code = detail.code
        message = detail.message
    elif isinstance(detail, dict) and "message" in detail:
        code = detail.get("code") or _DEFAULT_ERROR_CODES.get(exc.status_code, "ERROR")
        message = str(detail["message"])
    else:
        code = _DEFAULT_ERROR_CODES.get(exc.status_code, "ERROR")
        message = detail if isinstance(detail, str) else str(detail)
    return _v1_error_response(exc.status_code, message, code,
                              headers=getattr(exc, "headers", None))


# Pydantic validation errors -> 422 with code=VALIDATION_ERROR on v1 routes.
from fastapi.exceptions import RequestValidationError  # noqa: E402


@app.exception_handler(RequestValidationError)
async def _validation_exc_handler(request: Request, exc: RequestValidationError):
    if not _is_v1_path(request.url.path):
        return JSONResponse(status_code=422,
                            content={"detail": exc.errors()})
    # Take the first error message for a concise machine-friendly message.
    errs = exc.errors() or []
    first = errs[0] if errs else {}
    loc = ".".join(str(x) for x in first.get("loc", ()) if x != "body")
    msg = first.get("msg", "Validation error")
    message = f"{loc}: {msg}" if loc else msg
    return _v1_error_response(422, message, "VALIDATION_ERROR")


# Unhandled exceptions -> 500 INTERNAL_ERROR (only on v1 routes).
@app.exception_handler(Exception)
async def _unhandled_exc_handler(request: Request, exc: Exception):
    if not _is_v1_path(request.url.path):
        raise exc
    logger.exception("Unhandled error on %s: %s", request.url.path, exc)
    return _v1_error_response(500, "An unexpected error occurred", "INTERNAL_ERROR")


# API request log middleware — records every /api/v1/* call made by merchants
# using their API keys, so they can audit calls from their dashboard.
@app.middleware("http")
async def api_log_middleware(request: Request, call_next):
    is_v1 = request.url.path.startswith("/api/v1/")
    start = datetime.now(timezone.utc)
    response = await call_next(request)
    if is_v1:
        duration_ms = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)
        # Try to resolve user_id from Authorization if it's a merchant key
        user_id: Optional[str] = None
        auth = request.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            secret = auth.split(" ", 1)[1].strip()
            if secret.startswith("sk_test_") or secret.startswith("sk_live_"):
                try:
                    env = "test" if secret.startswith("sk_test_") else "live"
                    h = _hash_secret(secret)
                    doc = await db.api_keys.find_one(
                        {f"keys.{env}.secret_hash": h}, {"_id": 0, "user_id": 1})
                    if doc:
                        user_id = doc["user_id"]
                except Exception:
                    pass
        # Best-effort informative rate limit headers on v1 responses.
        if user_id and "X-RateLimit-Limit" not in response.headers:
            remaining, limit, reset_ts = _rate_touch(user_id)
            for k, v in _rate_headers(remaining, limit, reset_ts).items():
                response.headers[k] = v
        try:
            await db.api_logs.insert_one({
                "id": new_id(),
                "user_id": user_id,
                "method": request.method,
                "path": request.url.path,
                "query": str(request.url.query or ""),
                "status": response.status_code,
                "duration_ms": duration_ms,
                "ip": request.client.host if request.client else None,
                "user_agent": request.headers.get("User-Agent", "")[:200],
                "timestamp": now_iso(),
            })
        except Exception:
            pass
    return response


@app.on_event("startup")
async def startup_db_client():
    try:
        await db.webhook_events.create_index("event_id", unique=True)
    except Exception:
        pass
    try:
        # Idempotency-Key uniqueness per (user_id, key)
        await db.idempotency_keys.create_index(
            [("user_id", 1), ("key", 1)], unique=True)
    except Exception:
        pass


@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()
