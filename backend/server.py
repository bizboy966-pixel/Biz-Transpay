"""Biz-transPay backend – FastAPI monolith."""
import os
import logging
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Literal

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Query, Request
from pydantic import BaseModel
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
    Transaction, TransferRequest, DepositRequest, ExchangeRequest,
    KycSubmit, ApiKeys, WebhookConfig, UpdateProfile, ChangePassword,
    TicketCreate, Ticket, new_id, now_iso,
)
from auth import hash_password, verify_password, create_token, get_current_user_id  # noqa: E402

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
        "transactions_count": tx_count,
        "kyc_status": u.get("kyc_status", "not_started"),
    }


# ==================== TRANSFER ====================
@api.post("/transfers")
async def transfer(req: TransferRequest, uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    if u.get("kyc_status") != "verified":
        # allow demo transfer but flag
        pass

    field = "balance_xof" if req.currency == "XOF" else "balance_xaf"
    if u.get(field, 0) < req.amount:
        raise HTTPException(400, "Solde insuffisant")

    fee = 0.0
    if req.transfer_type == "biz_to_bank":
        fee = req.amount * 0.015
    elif req.transfer_type == "biz_to_mobile":
        fee = req.amount * 0.01

    total_debit = req.amount + fee
    if u.get(field, 0) < total_debit:
        raise HTTPException(400, "Solde insuffisant (frais inclus)")

    # if biz_to_biz, recipient MUST exist
    recip = None
    if req.transfer_type == "biz_to_biz":
        recip = await db.users.find_one(
            {"$or": [{"username": req.recipient.lower()}, {"email": req.recipient.lower()}]}
        )
        if not recip:
            raise HTTPException(404, "Destinataire introuvable")

    await db.users.update_one({"id": uid}, {"$inc": {field: -total_debit}})

    if recip:
        await db.users.update_one({"id": recip["id"]}, {"$inc": {field: req.amount}})
        await record_tx(recip["id"], "transfer", "in", req.amount, req.currency,
                        counterparty=u["username"], description=req.description)

    tx = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                         counterparty=req.recipient, description=req.description,
                         metadata={"transfer_type": req.transfer_type, "fee": fee,
                                   "recipient_name": req.recipient_name})
    return {"transaction": tx.model_dump(), "fee": fee}


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


# ==================== EXCHANGE ====================
@api.get("/exchange/rate")
async def get_rate(from_currency: str = "XOF", to_currency: str = "XAF"):
    rate = FX_RATE_XOF_TO_XAF if from_currency == "XOF" else FX_RATE_XAF_TO_XOF
    return {"from": from_currency, "to": to_currency, "rate": rate, "fee_pct": FX_FEE_PCT}


@api.post("/exchange")
async def do_exchange(req: ExchangeRequest, uid: str = Depends(get_current_user_id)):
    if req.from_currency == req.to_currency:
        raise HTTPException(400, "Devises identiques")
    u = await get_user(uid)
    from_field = "balance_xof" if req.from_currency == "XOF" else "balance_xaf"
    to_field = "balance_xof" if req.to_currency == "XOF" else "balance_xaf"
    if u.get(from_field, 0) < req.amount:
        raise HTTPException(400, "Solde insuffisant")

    rate = FX_RATE_XOF_TO_XAF if req.from_currency == "XOF" else FX_RATE_XAF_TO_XOF
    fee = req.amount * FX_FEE_PCT
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
    link = PaymentLink(
        id=new_id(),
        user_id=uid,
        slug=secrets.token_urlsafe(8),
        title=req.title,
        amount=req.amount,
        currency=req.currency,
        description=req.description or "",
        expires_at=req.expires_at,
        single_use=req.single_use,
        active=True,
        created_at=now_iso(),
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
    }
    await db.kyc.replace_one({"user_id": uid}, doc, upsert=True)
    await db.users.update_one({"id": uid}, {"$set": {"kyc_status": "pending"}})
    # auto-approve after submit for demo
    await db.users.update_one({"id": uid}, {"$set": {"kyc_status": "verified"}})
    await db.kyc.update_one({"user_id": uid}, {"$set": {"status": "verified",
                                                         "verified_at": now_iso()}})
    return {"status": "verified", "message": "Vérification KYC approuvée (démo)"}


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
    async for tx in tx_all:
        total_tx += 1
        if tx.get("status") == "completed":
            succeeded += 1
        elif tx.get("status") == "pending":
            pending += 1
        elif tx.get("status") in ("failed", "cancelled"):
            failed += 1
        if tx.get("type") == "deposit" and tx.get("status") == "completed":
            total_deposits += tx.get("amount", 0)
        if tx.get("type") in ("withdrawal", "transfer") and tx.get("direction") == "out" and tx.get("status") == "completed":
            total_withdrawals += tx.get("amount", 0)

    return {
        "users": {
            "total": total_users,
            "verified": verified,
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
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "verified", "verified_at": now_iso()}})
        act = "kyc_approve"
    else:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "rejected"}})
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "rejected", "reject_reason": req.reason,
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


@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()
