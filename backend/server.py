"""Biz-transPay backend – FastAPI monolith."""
import os
import logging
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Literal

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Query, Request
from pydantic import BaseModel, Field
from fastapi.responses import JSONResponse
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
        "balance_xof": 25000.0,  # welcome bonus for demo
        "balance_xaf": 15000.0,
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
        "enabled": False,
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
        return {"transaction": tx_out.model_dump(), "fee": fee, "total_debit": total_debit,
                "recipient_gets": recipient_gets, "operator": op["name"]}

    # -------- BIZ TO BANK --------
    if req.transfer_type == "biz_to_bank":
        bank_cfg = cfg.get("bank", {})
        if not bank_cfg.get("enabled"):
            raise HTTPException(403, "Bientôt disponible. Les transferts bancaires seront disponibles prochainement.")
        if not req.bank:
            raise HTTPException(400, "Banque requise")
        bank = next((b for b in bank_cfg.get("banks", [])
                     if b.get("code") == req.bank and b.get("active", True)), None)
        if not bank:
            raise HTTPException(400, "Banque non disponible")
        fee_pct = bank.get("fee_pct", 0) / 100.0
        fee = req.amount * fee_pct
        total_debit = req.amount + fee if req.fee_bearer == "sender" else req.amount
        recipient_gets = req.amount if req.fee_bearer == "sender" else req.amount - fee
        if u.get(field, 0) < total_debit:
            raise HTTPException(400, "Solde insuffisant (frais inclus)")
        await db.users.update_one({"id": uid}, {"$inc": {field: -total_debit}})
        tx_out = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                 counterparty=req.recipient, description=req.description,
                                 metadata={"transfer_type": "biz_to_bank", "bank": bank["name"],
                                           "fee": fee, "fee_bearer": req.fee_bearer,
                                           "recipient_gets": recipient_gets, "total_debit": total_debit})
        return {"transaction": tx_out.model_dump(), "fee": fee, "total_debit": total_debit,
                "recipient_gets": recipient_gets, "bank": bank["name"]}

    # -------- BIZ TO CRYPTO --------
    if req.transfer_type == "biz_to_crypto":
        import re
        ccfg = cfg.get("crypto", {})
        if not ccfg.get("enabled"):
            raise HTTPException(403, "Bientôt disponible. Les transferts crypto seront disponibles prochainement.")
        if not req.crypto or not req.network or not req.wallet_address:
            raise HTTPException(400, "Crypto, réseau et adresse de portefeuille requis")
        crypto = next((c for c in ccfg.get("cryptos", [])
                       if c.get("code", "").upper() == req.crypto.upper() and c.get("active", True)), None)
        if not crypto:
            raise HTTPException(400, "Cryptomonnaie non disponible")
        if req.network.upper() not in [n.upper() for n in crypto.get("networks", [])]:
            raise HTTPException(400, f"Le réseau {req.network} n'est pas compatible avec {req.crypto}")
        network = next((n for n in ccfg.get("networks", [])
                        if n.get("code", "").upper() == req.network.upper() and n.get("active", True)), None)
        if not network:
            raise HTTPException(400, "Réseau non disponible")
        # validate address against network regex
        regex = network.get("address_regex")
        if regex and not re.match(regex, req.wallet_address.strip()):
            raise HTTPException(400, f"Adresse invalide pour le réseau {network.get('name', req.network)}")
        if req.amount < crypto.get("min", 0) or req.amount > crypto.get("max", 10**12):
            raise HTTPException(400, f"Montant hors des limites autorisées ({crypto['min']} - {crypto['max']} {req.crypto})")
        # Per-coin fee from admin config (defaults to 4% if not configured)
        coin_upper = req.crypto.upper()
        fees_map = (ccfg.get("fees") or {})
        fee_pct = float(fees_map.get(coin_upper, 4.0)) / 100.0
        fee = req.amount * fee_pct
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
                                           "crypto": req.crypto.upper(), "network": req.network.upper(),
                                           "wallet_address": req.wallet_address,
                                           "fee": fee, "fee_bearer": req.fee_bearer,
                                           "recipient_gets": recipient_gets, "total_debit": total_debit,
                                           "recipient_name": req.recipient_name})

        # Call IzichangePay to actually send the crypto on-chain
        if not izipay.is_configured():
            # Refund and fail
            await db.users.update_one({"id": uid}, {"$inc": {field: total_debit}})
            await db.transactions.update_one({"id": tx_out.id}, {"$set": {"status": "failed"}})
            raise HTTPException(503, "Passerelle crypto non configurée")
        coin_code = f"{req.crypto.upper()}.{req.network.upper()}"  # e.g. USDT.TRC20 (assetCode)
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
        "expires_at": intent.get("expiresAt"),
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
    return d


# ==================== IZICHANGEPAY WEBHOOK ====================
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
                    await db.crypto_deposits.update_one(
                        {"id": merchant_ref, "status": {"$ne": "confirmed"}},
                        {"$set": {"status": "confirmed", "updated_at": now_iso(),
                                  "izipay_intent_id": intent_id}}
                    )
                    # Credit USDT balance
                    await db.users.update_one({"id": d["user_id"]}, {"$inc": {"balance_usdt": d["amount"]}})
                    await record_tx(d["user_id"], "deposit", "in", d["amount"], "USDT",
                                    status="completed",
                                    description="Dépôt crypto IzichangePay",
                                    metadata={"izipay_intent_id": intent_id, "coin": d["coin"]})
                # 2) Payment link payment?
                link_pay = await db.link_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
                if link_pay:
                    await db.link_payments.update_one(
                        {"id": merchant_ref, "status": {"$ne": "paid"}},
                        {"$set": {"status": "paid", "paid_at": now_iso(),
                                  "izipay_intent_id": intent_id}}
                    )
                    # Credit merchant
                    link = await db.payment_links.find_one({"id": link_pay["link_id"]})
                    if link:
                        await db.users.update_one({"id": link["user_id"]},
                                                  {"$inc": {"balance_usdt": link_pay["amount"]}})
                        await record_tx(link["user_id"], "link_payment", "in",
                                        link_pay["amount"], "USDT", status="completed",
                                        description=f"Paiement lien: {link.get('title','')}",
                                        counterparty=link_pay.get("customer_email") or "client",
                                        metadata={"link_id": link["id"], "izipay_intent_id": intent_id})
                # 3) Merchant API payment?
                mp = await db.merchant_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
                if mp:
                    await db.merchant_payments.update_one(
                        {"id": merchant_ref, "status": {"$ne": "paid"}},
                        {"$set": {"status": "paid", "paid_at": now_iso(),
                                  "izipay_intent_id": intent_id}}
                    )
                    await db.users.update_one({"id": mp["merchant_id"]},
                                              {"$inc": {"balance_usdt": mp["amount"]}})
                    await record_tx(mp["merchant_id"], "payment", "in", mp["amount"], "USDT",
                                    status="completed", description="Paiement API marchand",
                                    metadata={"merchant_payment_id": mp["id"], "izipay_intent_id": intent_id})

        elif ev_type == "payment_intent.expired":
            if merchant_ref:
                await db.crypto_deposits.update_one({"id": merchant_ref}, {"$set": {"status": "expired", "updated_at": now_iso()}})
                await db.link_payments.update_one({"id": merchant_ref}, {"$set": {"status": "expired"}})
                await db.merchant_payments.update_one({"id": merchant_ref}, {"$set": {"status": "expired"}})

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
        "expires_at": intent.get("expiresAt"),
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
    return lp


# ==================== MERCHANT PAYMENT API (Public — auth via secret key) ====================
async def _authenticate_merchant(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Authorization header")
    secret = auth.split(" ", 1)[1].strip()
    if not secret.startswith(("sk_test_", "sk_live_")):
        raise HTTPException(401, "Invalid API key format")
    keys = await db.api_keys.find_one({"secret_key": secret})
    if not keys:
        raise HTTPException(401, "Invalid API key")
    user = await db.users.find_one({"id": keys["user_id"]})
    if not user or user.get("is_banned") or user.get("is_blocked"):
        raise HTTPException(403, "Merchant account inactive")
    return user


class MerchantPaymentRequest(BaseModel):
    amount: float
    coin: str = "USDT"
    accepted_networks: Optional[list[str]] = None
    reference: Optional[str] = None       # merchant's own reference
    customer_email: Optional[str] = None
    return_url: Optional[str] = None
    metadata: Optional[dict] = None


@api.post("/v1/payments")
async def merchant_create_payment(payload: MerchantPaymentRequest, request: Request):
    """Merchant API — create a crypto payment using izichangepay hosted checkout.
    Requires a valid `sk_...` merchant secret key in the Authorization header.
    The merchant's USDT balance is credited when the webhook confirms the payment.
    """
    merchant = await _authenticate_merchant(request)
    if not izipay.is_configured():
        raise HTTPException(503, "Passerelle crypto non configurée")
    if payload.amount < 1:
        raise HTTPException(400, "Montant minimum : 1 USDT")

    mp_id = new_id()
    accepted = [f"{payload.coin.upper()}.{n.upper()}" for n in (payload.accepted_networks or ["TRC20", "BEP20", "ERC20"])]
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
        raise HTTPException(400 if e.status < 500 else 502, f"Passerelle crypto: {e.message}")

    await db.merchant_payments.insert_one({
        "id": mp_id,
        "merchant_id": merchant["id"],
        "amount": payload.amount,
        "coin": payload.coin.upper(),
        "reference": payload.reference,
        "customer_email": payload.customer_email,
        "izipay_intent_id": intent.get("id"),
        "payment_url": intent.get("paymentLink") or intent.get("paymentUrl") or intent.get("payment_url"),
        "status": "initiated",
        "created_at": now_iso(),
    })
    return {
        "id": mp_id,
        "payment_url": intent.get("paymentLink") or intent.get("paymentUrl") or intent.get("payment_url"),
        "amount": payload.amount,
        "coin": payload.coin.upper(),
        "accepted_networks": payload.accepted_networks or ["TRC20", "BEP20", "ERC20"],
        "status": "initiated",
    }


@api.get("/v1/payments/{payment_id}")
async def merchant_get_payment(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    mp = await db.merchant_payments.find_one({"id": payment_id, "merchant_id": merchant["id"]}, {"_id": 0})
    if not mp:
        raise HTTPException(404, "Payment not found")
    return {"id": mp["id"], "status": mp.get("status"), "amount": mp.get("amount"),
            "coin": mp.get("coin"), "reference": mp.get("reference"),
            "payment_url": mp.get("payment_url"), "created_at": mp.get("created_at"),
            "paid_at": mp.get("paid_at")}



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
        query["$or"] = [
            {"reference": {"$regex": q, "$options": "i"}},
            {"counterparty": {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
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


# ==================== API KEYS ====================
@api.get("/api-keys")
async def get_api_keys(uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    if u["account_type"] != "merchant":
        raise HTTPException(403, "Réservé aux comptes marchands")
    keys = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    if not keys:
        keys = {
            "user_id": uid,
            "public_key": f"pk_test_{secrets.token_urlsafe(24)}",
            "secret_key": f"sk_test_{secrets.token_urlsafe(32)}",
            "webhook_url": "",
            "created_at": now_iso(),
        }
        await db.api_keys.insert_one(keys)
        keys = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    return keys


@api.post("/api-keys/regenerate")
async def regenerate_keys(uid: str = Depends(get_current_user_id)):
    new_keys = {
        "public_key": f"pk_test_{secrets.token_urlsafe(24)}",
        "secret_key": f"sk_test_{secrets.token_urlsafe(32)}",
        "created_at": now_iso(),
    }
    await db.api_keys.update_one({"user_id": uid}, {"$set": new_keys}, upsert=True)
    keys = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    return keys


@api.patch("/api-keys/webhook")
async def set_webhook(cfg: WebhookConfig, uid: str = Depends(get_current_user_id)):
    await db.api_keys.update_one({"user_id": uid}, {"$set": {"webhook_url": cfg.webhook_url}}, upsert=True)
    return {"ok": True, "webhook_url": cfg.webhook_url}


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


# ==================== ADMIN ====================
async def get_admin(uid: str = Depends(get_current_user_id)) -> dict:
    u = await db.users.find_one({"id": uid}, {"_id": 0})
    if not u:
        raise HTTPException(401, "Non autorisé")
    if u.get("role") not in ("admin", "super_admin"):
        raise HTTPException(403, "Accès administrateur requis")
    return u


@api.get("/admin/crypto/coins")
async def admin_crypto_coins(admin=Depends(get_admin)):
    """Admin: list all distinct coins available on IzichangePay + current per-coin
    withdrawal fee (%) from platform config. Default = 4% for coins without a
    configured fee. Used by the admin panel Fee Configuration.
    """
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
    email: Optional[str] = None
    phone: Optional[str] = None
    country: Optional[str] = None
    role: Optional[Literal["user", "admin", "super_admin"]] = None


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
    total_deposits = 0.0
    total_withdrawals = 0.0
    total_tx = 0
    succeeded = 0
    pending = 0
    failed = 0
    dep_pending = {"count": 0, "amount": 0.0}
    dep_valid = {"count": 0, "amount": 0.0}
    dep_rejected = {"count": 0, "amount": 0.0}
    wd_pending = {"count": 0, "amount": 0.0}
    wd_valid = {"count": 0, "amount": 0.0}
    wd_rejected = {"count": 0, "amount": 0.0}
    async for tx in tx_all:
        total_tx += 1
        st = tx.get("status")
        if st == "completed": succeeded += 1
        elif st == "pending": pending += 1
        elif st in ("failed", "cancelled"): failed += 1
        typ = tx.get("type")
        amt = tx.get("amount", 0)
        if typ == "deposit":
            if st == "completed":
                dep_valid["count"] += 1; dep_valid["amount"] += amt; total_deposits += amt
            elif st == "pending":
                dep_pending["count"] += 1; dep_pending["amount"] += amt
            elif st in ("failed", "cancelled"):
                dep_rejected["count"] += 1; dep_rejected["amount"] += amt
        elif typ in ("withdrawal", "transfer") and tx.get("direction") == "out":
            if st == "completed":
                wd_valid["count"] += 1; wd_valid["amount"] += amt; total_withdrawals += amt
            elif st == "pending":
                wd_pending["count"] += 1; wd_pending["amount"] += amt
            elif st in ("failed", "cancelled"):
                wd_rejected["count"] += 1; wd_rejected["amount"] += amt

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
async def admin_user_action(user_id: str, action: str, req: AdminUserAction,
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
    if updates:
        await db.users.update_one({"id": user_id}, {"$set": updates})
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
    elif req.request_resubmit:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "not_started"}})
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "resubmit_requested",
                                                                 "reject_reason": req.reason,
                                                                 "reviewed_at": now_iso()}})
        act = "kyc_request_resubmit"
    else:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "rejected"}})
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "rejected",
                                                                 "reject_reason": req.reason,
                                                                 "reviewed_at": now_iso()}})
        act = "kyc_reject"
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
        query["$or"] = [
            {"reference": {"$regex": q, "$options": "i"}},
            {"id": {"$regex": q, "$options": "i"}},
            {"counterparty": {"$regex": q, "$options": "i"}},
        ]
    docs = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    # attach user info lightly
    for d in docs:
        u = await db.users.find_one({"id": d["user_id"]}, {"_id": 0, "username": 1, "full_name": 1, "email": 1})
        d["user"] = u
    return docs


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
)


@app.on_event("startup")
async def startup_db_client():
    try:
        await db.webhook_events.create_index("event_id", unique=True)
    except Exception:
        pass


@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()
