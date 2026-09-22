"""Biz-transPay backend – FastAPI monolith."""
import os
import logging
import secrets
import hashlib
import uuid
import asyncio
import json
import copy
import ipaddress
import math
import re
import base64
import socket
import unicodedata
from html import escape as html_escape
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Optional, List, Literal
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Query, Request, Body, Response
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from pymongo.errors import DuplicateKeyError
from stripe_checkout import (
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
    TwoFactorCodeRequest, TwoFactorDisableRequest, PasswordRecoveryRequest,
    ReauthenticationRequest,
)
import auth as auth_security  # noqa: E402
from auth import hash_password, verify_password, create_token  # noqa: E402
from postgres_document_store import create_database  # noqa: E402
import jwt as pyjwt  # for SSE query-token verification
import izipay  # IzichangePay integration (server-side only)
import fedapay  # FedaPay Mobile Money integration (server-side only)
import paydunya  # PayDunya SoftPay deposits (server-side only)
import mbiyo  # Mbiyo Mobile Money integration (server-side only)

# ---------- DB ----------
postgres_store, db = create_database(os.environ.get("DATABASE_URL", ""))

# ---------- Browser sessions ----------
SESSION_COOKIE_NAME = "btp_session"
CSRF_COOKIE_NAME = "btp_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"
SESSION_MAX_AGE = 24 * 60 * 60
SESSION_IDLE_SECONDS = 30 * 60
REAUTH_MAX_AGE_SECONDS = 15 * 60
ADMIN_ALLOWED_IPS = tuple(
    value.strip() for value in os.environ.get("ADMIN_ALLOWED_IPS", "").split(",")
    if value.strip()
)
ADMIN_TRUST_PROXY_HEADERS = os.environ.get(
    "ADMIN_TRUST_PROXY_HEADERS", ""
).lower() in {"1", "true", "yes"}
PLATFORM_OWNER_EMAIL = os.environ.get(
    "PLATFORM_OWNER_EMAIL", ""
).strip().lower()
PLATFORM_OWNER_CLAIM_BEFORE = os.environ.get(
    "PLATFORM_OWNER_CLAIM_BEFORE", ""
).strip()
EDGE_BLOCKED_IPS = tuple(
    value.strip() for value in os.environ.get("EDGE_BLOCKED_IPS", "").split(",")
    if value.strip()
)
EDGE_TRUST_PROXY_HEADERS = os.environ.get(
    "EDGE_TRUST_PROXY_HEADERS", ""
).lower() in {"1", "true", "yes"}
MAX_REQUEST_BYTES = int(os.environ.get("MAX_REQUEST_BYTES", str(12 * 1024 * 1024)))
MAX_WEBHOOK_BYTES = int(
    os.environ.get("MAX_WEBHOOK_BYTES", str(2 * 1024 * 1024))
)


def _session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _as_utc(value: datetime | str) -> datetime:
    """Normalize PostgreSQL/JSONB datetimes and ISO strings to UTC.

    The document adapter serializes datetimes into JSONB, so values read back
    from PostgreSQL are ISO strings rather than BSON datetime objects.
    """
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/",
    )


def _set_csrf_cookie(response: Response, token: Optional[str] = None) -> str:
    csrf_token = token or secrets.token_urlsafe(32)
    response.set_cookie(
        CSRF_COOKIE_NAME,
        csrf_token,
        max_age=SESSION_MAX_AGE,
        httponly=False,
        secure=True,
        samesite="strict",
        path="/",
    )
    return csrf_token


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        SESSION_COOKIE_NAME, httponly=True, secure=True, samesite="strict", path="/")
    response.delete_cookie(
        CSRF_COOKIE_NAME, httponly=False, secure=True, samesite="strict", path="/")


async def get_current_user_id(
    request: Request,
    creds=Depends(auth_security.bearer),
) -> str:
    """Validate a short-lived browser session and expose only the user id."""
    token = request.cookies.get(SESSION_COOKIE_NAME) or (
        creds.credentials if creds else None)
    if not token:
        raise HTTPException(401, "Session requise")
    payload = auth_security.decode_token_payload(token)
    session_id = payload.get("sid")
    if payload.get("typ") != "session" or not session_id:
        raise HTTPException(401, "Session invalide")
    now = datetime.now(timezone.utc)
    session = await db.sessions.find_one({
        "id": session_id,
        "user_id": payload.get("sub"),
        "token_hash": _session_token_hash(token),
        "revoked_at": {"$exists": False},
    }, {"_id": 0})
    if not session:
        raise HTTPException(401, "Session révoquée")
    expired = _as_utc(session["expires_at"]) <= now
    idle = _as_utc(session["last_activity_at"]) + timedelta(
        seconds=SESSION_IDLE_SECONDS) <= now
    if expired or idle:
        await db.sessions.update_one(
            {"id": session_id, "revoked_at": {"$exists": False}},
            {"$set": {"revoked_at": now, "revocation_reason": "expired"}},
        )
        raise HTTPException(401, "Session expirée")
    await db.sessions.update_one(
        {"id": session_id},
        {"$set": {"last_activity_at": now}},
    )
    request.state.session_id = session_id
    request.state.session = session
    request.state.session_token = token
    request.state.user_id = payload["sub"]
    return payload["sub"]


async def _issue_session(user_id: str, request: Request, response: Response) -> None:
    now = datetime.now(timezone.utc)
    session_id = secrets.token_urlsafe(32)
    token = auth_security.create_token(user_id, session_id=session_id)
    await db.sessions.insert_one({
        "id": session_id,
        "user_id": user_id,
        "token_hash": _session_token_hash(token),
        "created_at": now,
        "last_activity_at": now,
        "last_auth_at": now,
        "expires_at": now + timedelta(seconds=SESSION_MAX_AGE),
        "ip": _auth_ip(request),
        "user_agent": (request.headers.get("user-agent") or "")[:300],
    })
    _set_session_cookie(response, token)
    _set_csrf_cookie(response)


async def _rotate_session(request: Request, response: Response, user_id: str) -> None:
    old_id = getattr(request.state, "session_id", None)
    if old_id:
        await db.sessions.update_one(
            {"id": old_id, "user_id": user_id, "revoked_at": {"$exists": False}},
            {"$set": {"revoked_at": datetime.now(timezone.utc),
                      "revocation_reason": "rotated"}},
        )
    await _issue_session(user_id, request, response)


async def require_recent_auth(
    request: Request,
    uid: str = Depends(get_current_user_id),
) -> str:
    session = getattr(request.state, "session", {})
    last_auth = session.get("last_auth_at")
    if not last_auth or _as_utc(last_auth) + timedelta(
            seconds=REAUTH_MAX_AGE_SECONDS) <= datetime.now(timezone.utc):
        raise HTTPException(
            428,
            detail={
                "message": "Réauthentification requise pour cette opération.",
                "code": "REAUTH_REQUIRED",
            },
        )
    return uid

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
# httpx logs full request URLs. Telegram embeds the bot credential in its URL,
# so production logs must never record successful outbound request lines.
logging.getLogger("httpx").setLevel(logging.WARNING)

# ---------- Cloudflare Turnstile ----------
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def _turnstile_config() -> tuple[str, str, set[str]]:
    secret = os.environ.get("CLOUDFLARE_TURNSTILE_SECRET_KEY", "").strip()
    site_key = os.environ.get("CLOUDFLARE_TURNSTILE_SITE_KEY", "").strip()
    hostnames = {
        value.strip().lower()
        for value in os.environ.get(
            "CLOUDFLARE_TURNSTILE_ALLOWED_HOSTNAMES", ""
        ).split(",")
        if value.strip()
    }
    return secret, site_key, hostnames


@api.get("/security/turnstile-config")
async def turnstile_config():
    """Expose only the public Turnstile site key to the browser."""
    _secret, site_key, _hostnames = _turnstile_config()
    return {
        "enabled": bool(_secret and site_key),
        "site_key": site_key or None,
    }


async def _require_turnstile(
    token: Optional[str],
    request: Request,
    action: str,
) -> None:
    """Verify a one-time Cloudflare Turnstile token before risky public actions."""
    secret, _site_key, allowed_hostnames = _turnstile_config()
    if not secret:
        raise HTTPException(
            503,
            detail={
                "code": "ANTI_BOT_NOT_CONFIGURED",
                "message": "La vérification anti-bot n'est pas configurée.",
            },
        )
    if not token:
        raise HTTPException(
            400,
            detail={
                "code": "TURNSTILE_REQUIRED",
                "message": "La vérification anti-bot est obligatoire.",
            },
        )

    try:
        import httpx

        payload = {"secret": secret, "response": token}
        client_ip = _edge_request_ip(request)
        if client_ip:
            payload["remoteip"] = client_ip
        async with httpx.AsyncClient(timeout=8.0) as client:
            verification = await client.post(TURNSTILE_VERIFY_URL, data=payload)
            result = verification.json()
    except Exception:
        logger.exception("Cloudflare Turnstile verification request failed")
        raise HTTPException(
            503,
            detail={
                "code": "ANTI_BOT_UNAVAILABLE",
                "message": "La vérification anti-bot est temporairement indisponible.",
            },
        )

    if (
        verification.status_code != 200
        or not result.get("success")
        or result.get("action") != action
        or (
            allowed_hostnames
            and str(result.get("hostname", "")).lower()
            not in allowed_hostnames
        )
    ):
        logger.warning(
            "Cloudflare Turnstile rejected action=%s errors=%s",
            action,
            result.get("error-codes", []),
        )
        raise HTTPException(
            403,
            detail={
                "code": "TURNSTILE_FAILED",
                "message": "La vérification anti-bot a échoué. Réessayez.",
            },
        )

# App start time for uptime reporting on /v1/health
_APP_STARTED_AT = datetime.now(timezone.utc)
API_VERSION = "1.0.0"
_paydunya_reconcile_task = None
MOMO_PENDING_TIMEOUT_MINUTES = 10

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
    """HTTPException subclass carrying an explicit machine code and optional
    upstream details that will be surfaced to the caller."""

    def __init__(self, status_code: int, message: str, code: str,
                 headers: Optional[dict] = None,
                 details: Optional[dict] = None) -> None:
        payload = {"message": message, "code": code}
        if details:
            payload["details"] = details
        super().__init__(status_code=status_code, detail=payload,
                         headers=headers or {})
        self.message = message
        self.code = code
        self.details = details


def _is_v1_path(path: str) -> bool:
    return path.startswith("/api/v1/") or path == "/api/v1"


def _v1_error_response(status_code: int, message: str, code: Optional[str],
                       headers: Optional[dict] = None,
                       details: Optional[dict] = None) -> JSONResponse:
    payload = {
        "statusCode": status_code,
        "message": message,
        "code": code or _DEFAULT_ERROR_CODES.get(status_code, "ERROR"),
    }
    if details:
        payload["details"] = details
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


async def _idempotency_release(user_id: str, key: str, fingerprint: str = "") -> None:
    """Release a reservation when no upstream financial operation was created."""
    if not key:
        return
    query = {"user_id": user_id, "key": key, "status": "processing"}
    if fingerprint:
        query["fingerprint"] = fingerprint
    await db.idempotency_keys.delete_one(query)


async def _idempotency_claim(user_id: str, key: str, method: str, path: str,
                             fingerprint: str = "") -> Optional[dict]:
    """Atomically reserve an idempotency key before any money-moving work.

    A read followed by an insert is not sufficient here: two concurrent
    requests can both pass the read.  The unique index is the reservation
    barrier.  A second request receives the completed response when available,
    otherwise it gets a conflict instead of creating a second upstream intent.
    """
    if not key:
        return None
    existing = await _idempotency_lookup(user_id, key)
    if existing:
        if fingerprint and existing.get("fingerprint") not in (None, fingerprint):
            raise BizAPIError(409, "Idempotency-Key was already used for another request.",
                              "IDEMPOTENCY_KEY_REUSED")
        if existing.get("body") is not None:
            return existing
        raise BizAPIError(409, "An identical request is already being processed.",
                          "IDEMPOTENCY_IN_PROGRESS")
    exp = datetime.now(timezone.utc) + timedelta(hours=_IDEMPOTENCY_TTL_HOURS)
    try:
        await db.idempotency_keys.insert_one({
            "user_id": user_id, "key": key, "method": method, "path": path,
            "fingerprint": fingerprint, "status": "processing",
            "expires_at": exp.isoformat(), "created_at": now_iso(),
        })
    except DuplicateKeyError:
        existing = await _idempotency_lookup(user_id, key)
        if existing and existing.get("body") is not None:
            return existing
        raise BizAPIError(409, "An identical request is already being processed.",
                          "IDEMPOTENCY_IN_PROGRESS")
    return None


def _request_fingerprint(payload: BaseModel) -> str:
    raw = json.dumps(payload.model_dump(), sort_keys=True, separators=(",", ":"),
                     default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


async def _credit_wallet_once(user_id: str, field: str, amount: float,
                              operation_id: str) -> bool:
    """Atomically credit a wallet once, using the operation id as the barrier."""
    if not operation_id or amount == 0:
        return False
    result = await db.users.update_one(
        {"id": user_id, "wallet_credit_operation_ids": {"$ne": operation_id}},
        {"$inc": {field: float(amount)},
         "$addToSet": {"wallet_credit_operation_ids": operation_id}},
    )
    return result.modified_count == 1


async def _refund_wallet_once(user_id: str, field: str, amount: float,
                              operation_id: str) -> bool:
    """Atomically refund a wallet once, even if webhook and polling race."""
    return await _credit_wallet_once(user_id, field, amount,
                                     f"refund:{operation_id}")


async def _debit_wallet_once(user_id: str, field: str, amount: float,
                             operation_id: str) -> bool:
    """Atomically debit only available funds and never apply one operation twice."""
    result = await db.users.update_one(
        {"id": user_id, field: {"$gte": float(amount)},
         "wallet_debit_operation_ids": {"$ne": operation_id}},
        {"$inc": {field: -float(amount)},
         "$addToSet": {"wallet_debit_operation_ids": operation_id}},
    )
    return result.modified_count == 1


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


# ---------- Global route-aware rate limiting ----------
# This protects the whole API surface in the single application workflow.
# The existing merchant API bucket remains the public 100 req/min contract;
# these route buckets add stricter limits for sensitive operations.
_GLOBAL_RATE_PROFILES = {
    "default": (240, 60),
    "login": (6, 60),
    "otp": (8, 60),
    "register": (3, 3600),
    "password_reset": (5, 900),
    "payment": (30, 60),
    "transaction": (12, 60),
    "deposit": (12, 60),
    "withdrawal": (8, 60),
    "link": (20, 60),
    "search": (60, 60),
    "admin": (60, 60),
    "webhook": (120, 60),
    "merchant_api": (100, 60),
}
_global_rate_buckets: dict[str, list[float]] = {}
_global_rate_lock = asyncio.Lock()


def _global_rate_profile(path: str, method: str) -> str:
    p = path.lower()
    m = method.upper()
    if p == "/api/auth/login":
        return "login"
    if p == "/api/auth/register":
        return "register"
    if p == "/api/auth/2fa/confirm" or p == "/api/auth/2fa/disable":
        return "otp"
    if p in {"/api/auth/recover", "/api/settings/password"}:
        return "password_reset"
    if p.startswith("/api/admin/"):
        return "admin"
    if p.startswith("/api/webhook") or p.startswith("/api/webhooks/"):
        return "webhook"
    if p.startswith("/api/v1/"):
        if (
            p == "/api/v1/payments"
            or p == "/api/v1/payouts"
            or (p.startswith("/api/v1/payments/") and m == "POST")
            or (p.startswith("/api/v1/payouts/") and m == "POST")
        ):
            return "payment"
        return "merchant_api"
    if p in {"/api/transfers", "/api/exchange"}:
        return "withdrawal" if p == "/api/transfers" else "transaction"
    if p.startswith("/api/deposits/"):
        return "deposit"
    if p.startswith("/api/links/pay"):
        return "payment"
    if p == "/api/links" and m in {"POST", "PATCH", "DELETE"}:
        return "link"
    if "/search" in p or p.endswith("/lookup") or p == "/api/users/lookup":
        return "search"
    return "default"


async def _global_rate_identity(request: Request) -> dict:
    """Resolve a stable per-user/per-merchant key without trusting user input."""
    identity = {
        "ip": _edge_request_ip(request),
        "user_id": None,
        "merchant_id": None,
    }
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        try:
            identity["user_id"] = auth_security.decode_token_payload(token).get("sub")
        except Exception:
            pass

    authorization = request.headers.get("Authorization", "")
    if authorization.lower().startswith("bearer "):
        secret = authorization.split(" ", 1)[1].strip()
        if secret.startswith(("sk_test_", "sk_live_")):
            try:
                env = "test" if secret.startswith("sk_test_") else "live"
                key_doc = await db.api_keys.find_one(
                    {f"keys.{env}.secret_hash": _hash_secret(secret)},
                    {"_id": 0, "user_id": 1},
                )
                if key_doc:
                    identity["merchant_id"] = key_doc.get("user_id")
            except Exception:
                pass
    return identity


async def _global_rate_consume(
    profile: str, identity: dict
) -> Optional[dict]:
    """Consume the IP bucket and, where available, the user/merchant bucket."""
    limit, window = _GLOBAL_RATE_PROFILES[profile]
    now_ts = datetime.now(timezone.utc).timestamp()
    keys = [f"{profile}:ip:{identity['ip']}"]
    scoped_id = identity.get("merchant_id") or identity.get("user_id")
    if scoped_id:
        keys.append(f"{profile}:scope:{scoped_id}")
    async with _global_rate_lock:
        blocked = None
        for key in keys:
            bucket = [t for t in _global_rate_buckets.get(key, [])
                      if t > now_ts - window]
            _global_rate_buckets[key] = bucket
            if len(bucket) >= limit:
                retry_after = max(1, int(bucket[0] + window - now_ts))
                blocked = {
                    "retry_after": retry_after,
                    "limit": limit,
                    "reset": int(bucket[0] + window),
                }
                break
        if blocked:
            return blocked
        for key in keys:
            _global_rate_buckets[key].append(now_ts)
        # Bound memory if an abusive client creates many distinct addresses.
        if len(_global_rate_buckets) > 20000:
            stale_before = now_ts - 3600
            for key in list(_global_rate_buckets)[:5000]:
                if not _global_rate_buckets[key] or max(_global_rate_buckets[key]) < stale_before:
                    _global_rate_buckets.pop(key, None)
    return None


def _global_rate_response(profile: str, blocked: dict) -> JSONResponse:
    limit = blocked["limit"]
    retry_after = blocked["retry_after"]
    return JSONResponse(
        status_code=429,
        content={
            "detail": {
                "message": "Trop de requêtes. Réessayez plus tard.",
                "code": "RATE_LIMITED",
                "profile": profile,
                "retry_after": retry_after,
            }
        },
        headers={
            "Retry-After": str(retry_after),
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(blocked["reset"]),
        },
    )


def _apply_edge_security_headers(response: JSONResponse, request: Request) -> None:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
    )
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; object-src 'none'; "
        "frame-ancestors 'none'; form-action 'self' https:; "
        "script-src 'self' https://challenges.cloudflare.com "
        "'sha256-bv3BJQ9HDRPWREafa7OTAYZEHepHMGBDm7yX52R8CKE='; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; font-src 'self' data: https:; "
        "connect-src 'self' https://challenges.cloudflare.com; "
        "frame-src 'self' https://challenges.cloudflare.com; "
        "worker-src 'self' blob:; media-src 'self' blob: https:",
    )
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    forwarded_proto = request.headers.get("x-forwarded-proto", "").lower()
    if request.url.scheme == "https" or (
        EDGE_TRUST_PROXY_HEADERS and forwarded_proto == "https"
    ):
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )


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
    effective_role = _effective_role(u)
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
        **{f"balance_{currency.lower()}": u.get(f"balance_{currency.lower()}", 0.0)
           for currency in ("CDF", "USD", "GMD", "GNF", "UGX", "TZS", "KES",
                            "RWF", "GHS", "NGN", "ZAR", "ZMW", "EGP")},
        created_at=u.get("created_at", now_iso()),
        two_fa_enabled=u.get("two_fa_enabled", False),
        language=u.get("language", "fr"),
        default_currency=u.get("default_currency", "XOF"),
        avatar_url=u.get("avatar_url"),
        role=u.get("role", "user"),
        admin_role=u.get("admin_role"),
        effective_role=effective_role,
        permissions=sorted(_permissions_for_role(effective_role)),
        is_blocked=u.get("is_blocked", False),
        is_banned=u.get("is_banned", False),
        withdrawals_blocked=u.get("withdrawals_blocked", False),
    )


async def get_user(uid: str) -> dict:
    u = await db.users.find_one({"id": uid}, {"_id": 0})
    if not u:
        raise HTTPException(404, "User not found")
    return await _ensure_platform_owner_role(u)


async def require_merchant_account(
    uid: str = Depends(get_current_user_id),
) -> str:
    """Authorize merchant-only resources at the API boundary."""
    user = await get_user(uid)
    if user.get("account_type") != "merchant":
        raise HTTPException(403, "Réservé aux comptes marchands")
    return uid


async def record_tx(user_id: str, tx_type: str, direction: str, amount: float,
                    currency: str, status: str = "completed",
                    counterparty: Optional[str] = None, description: str = "",
                    metadata: Optional[dict] = None,
                    operation_id: Optional[str] = None) -> Transaction:
    metadata = dict(metadata or {})
    if operation_id:
        metadata["operation_id"] = operation_id
        existing = await db.transactions.find_one(
            {"user_id": user_id, "metadata.operation_id": operation_id},
            {"_id": 0},
        )
        if existing:
            return Transaction(**existing)
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
        metadata=metadata,
    )
    try:
        await db.transactions.insert_one(tx.model_dump())
    except DuplicateKeyError:
        if operation_id:
            existing = await db.transactions.find_one(
                {"user_id": user_id, "metadata.operation_id": operation_id},
                {"_id": 0},
            )
            if existing:
                return Transaction(**existing)
        raise
    return tx


# ==================== NOTIFICATIONS ====================
# Per-user Server-Sent Events subscribers for real-time push.
_sse_subscribers: dict[str, list[asyncio.Queue]] = {}
_telegram_queue: Optional[asyncio.Queue] = None
_telegram_worker_task: Optional[asyncio.Task] = None
TELEGRAM_MAX_MESSAGE_LENGTH = 3900
TELEGRAM_FINAL_NOTIFICATION_TYPES = {
    "deposit_success",
    "withdrawal_success",
    "withdrawal_failed",
    "transfer_success",
    "exchange_success",
    "security_alert",
}
TELEGRAM_ADMIN_NOTIFICATION_TYPES = {
    "admin_login",
    "kyc_submitted",
    "kyc_verified",
    "kyc_rejected",
    "kyc_resubmit_requested",
}
_security_alert_last_sent: dict[str, float] = {}
_security_alert_lock = asyncio.Lock()
SECURITY_ALERT_COOLDOWN_SECONDS = 300
_telegram_command_task: Optional[asyncio.Task] = None
_telegram_update_offset: Optional[int] = None


def _telegram_config() -> tuple[str, str]:
    """Read Telegram delivery settings without ever exposing the bot token."""
    return (
        os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(),
        os.environ.get("TELEGRAM_CHAT_ID", "").strip(),
    )


def _telegram_safe_data(data: Optional[dict]) -> list[tuple[str, str]]:
    """Keep provider credentials and customer PII out of Telegram alerts."""
    allowed = (
        "amount", "currency", "reference", "transaction_id", "deposit_id",
        "transfer_type", "security_event", "operation_id",
    )
    safe: list[tuple[str, str]] = []
    for key in allowed:
        value = (data or {}).get(key)
        if value is None or value == "":
            continue
        text = str(value)
        if len(text) > 180:
            text = text[:177] + "..."
        safe.append((key, text))
    return safe


def _telegram_mask_email(value: Optional[str]) -> str:
    text = str(value or "").strip()
    if "@" not in text:
        return text
    local, domain = text.split("@", 1)
    suffix = domain[domain.rfind("."):] if "." in domain else ""
    return f"{local[:1]}***@{domain[:1]}***{suffix}"


def _telegram_mask_phone(value: Optional[str]) -> str:
    text = str(value or "").strip()
    if len(text) <= 4:
        return text
    return f"{text[:3]}••••{text[-3:]}"


def _telegram_display_amount(value: Any, currency: str) -> str:
    if value is None or value == "":
        return f"— {currency}".strip()
    try:
        amount = Decimal(str(value))
        if not amount.is_finite():
            raise InvalidOperation
        digits = 6 if str(currency).upper() in {"USDT", "BTC", "ETH"} else 2
        rendered = f"{amount:,.{digits}f}"
        if digits == 2 and rendered.endswith(".00"):
            rendered = rendered[:-3]
        rendered = rendered.replace(",", "\u202f").replace(".", ",")
    except (InvalidOperation, TypeError, ValueError):
        rendered = "—"
    return f"{rendered} {str(currency).upper()}".strip()


def _telegram_display_time(value: Any) -> str:
    if not value:
        return datetime.now(timezone.utc).strftime("%d/%m/%Y %H:%M:%S UTC")
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).strftime("%d/%m/%Y %H:%M:%S UTC")
    except (TypeError, ValueError):
        return "—"


def _telegram_mask_ip(value: Any) -> str:
    try:
        address = ipaddress.ip_address(str(value or "").strip())
        if address.version == 4:
            parts = str(address).split(".")
            return ".".join(parts[:3] + ["xxx"])
        return ":".join(address.exploded.split(":")[:4]) + ":…"
    except ValueError:
        return "—"


def _telegram_security_text(data: Optional[dict]) -> str:
    safe = data or {}
    event_labels = {
        "edge_ip_blocked": "IP INTERDITE DÉTECTÉE",
        "request_too_large": "REQUÊTE ANORMALEMENT VOLUMINEUSE",
        "csrf_rejected": "TENTATIVE INTER-SITE DÉTECTÉE",
        "rate_limit_triggered": "TRAFIC ABUSIF / AUTOMATISÉ",
        "unusual_login": "CONNEXION INHABITUELLE RÉUSSIE",
    }
    outcome = str(safe.get("outcome") or "Signal à examiner")
    solution = str(
        safe.get("solution")
        or "Examiner les journaux et renforcer temporairement la surveillance."
    )
    lines = [
        f"<b>🛡️ ALERTE SÉCURITÉ — {html_escape(event_labels.get(str(safe.get('security_event')), 'ÉVÉNEMENT SUSPECT'))}</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        f"📊 Situation : <b>{html_escape(outcome[:240])}</b>",
        f"🛣️ Cible : <code>{html_escape(str(safe.get('method') or '—'))} {html_escape(str(safe.get('path') or '—')[:180])}</code>",
        f"🌐 IP : <code>{html_escape(_telegram_mask_ip(safe.get('ip')))}</code>",
        f"🕘 Heure : <b>{html_escape(_telegram_display_time(safe.get('detected_at')))}</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        "<b>🔧 Solution recommandée</b>",
        html_escape(solution[:700]),
    ]
    if safe.get("profile"):
        lines.insert(
            5,
            f"🎯 Protection déclenchée : <b>{html_escape(str(safe['profile'])[:80])}</b>",
        )
    return "\n".join(lines)[:TELEGRAM_MAX_MESSAGE_LENGTH]


async def _telegram_user_summary(user_id: Optional[str]) -> dict:
    if not user_id:
        return {}
    user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "full_name": 1, "username": 1, "email": 1, "phone": 1,
         "country": 1, "country_name": 1},
    )
    if not user:
        return {}
    return {
        "name": user.get("full_name") or user.get("username") or "Compte Biz-transPay",
        "username": user.get("username"),
        "email": _telegram_mask_email(user.get("email")),
        "phone": _telegram_mask_phone(user.get("phone")),
        "country": user.get("country_name") or user.get("country"),
    }


async def _telegram_party_lines(
    transaction: Optional[dict] = None,
    deposit: Optional[dict] = None,
) -> list[str]:
    """Show operational sender/recipient context with contact data masked."""
    if deposit:
        recipient = await _telegram_user_summary(deposit.get("user_id"))
        return [
            "━━━━ 👤 <b>EXPÉDITEUR (PAYEUR)</b> ━━━━",
            f"👤 Nom : <b>{html_escape(str(deposit.get('full_name') or 'Client externe')[:120])}</b>",
            f"📧 Email : <code>{html_escape(_telegram_mask_email(deposit.get('email')) or '—')}</code>",
            f"📞 Téléphone : <code>{html_escape(_telegram_mask_phone(deposit.get('phone_number')) or '—')}</code>",
            f"🌍 Pays : <b>{html_escape(str(deposit.get('country_label') or deposit.get('country') or '—'))}</b>",
            "━━━━ 🏦 <b>BÉNÉFICIAIRE</b> ━━━━",
            f"👤 Nom : <b>{html_escape(recipient.get('name', 'Compte Biz-transPay'))}</b>",
            f"📧 Email : <code>{html_escape(recipient.get('email', '—'))}</code>",
            f"🔑 Username : <code>{html_escape(str(recipient.get('username') or '—'))}</code>",
            f"📞 Téléphone : <code>{html_escape(recipient.get('phone', '—'))}</code>",
            f"🌍 Pays : <b>{html_escape(str(recipient.get('country') or '—'))}</b>",
        ]

    tx = transaction or {}
    meta = tx.get("metadata") or {}
    owner = await _telegram_user_summary(tx.get("user_id"))
    counterparty = tx.get("counterparty") or meta.get("recipient_name")
    transfer_type = meta.get("transfer_type")
    if tx.get("type") == "exchange":
        return [
            f"Expéditeur : <b>{html_escape(owner.get('name', 'Compte Biz-transPay'))}</b> "
            f"(portefeuille {html_escape(str(meta.get('from_currency') or tx.get('currency') or '—'))})",
            f"Destinataire : <b>{html_escape(owner.get('name', 'Compte Biz-transPay'))}</b> "
            f"(portefeuille {html_escape(str(meta.get('to_currency') or '—'))})",
        ]

    if tx.get("direction") == "in":
        sender = {}
        if transfer_type == "biz_to_biz" and counterparty:
            sender_doc = await db.users.find_one(
                {"username": str(counterparty).lower()}, {"_id": 0, "id": 1}
            )
            sender = await _telegram_user_summary((sender_doc or {}).get("id"))
        return [
            f"Expéditeur : <b>{html_escape(sender.get('name') or str(counterparty or 'Source externe')[:120])}</b>",
            f"Email expéditeur : <code>{html_escape(sender.get('email', '—'))}</code>",
            f"Destinataire : <b>{html_escape(owner.get('name', 'Compte Biz-transPay'))}</b>",
            f"Email destinataire : <code>{html_escape(owner.get('email', '—'))}</code>",
        ]

    recipient_name = meta.get("recipient_name") or counterparty or "Destinataire externe"
    recipient_phone = meta.get("phone_number") or meta.get("recipient_phone")
    recipient_wallet = meta.get("wallet_address")
    if transfer_type == "biz_to_biz" and counterparty:
        recipient_doc = await db.users.find_one(
            {"username": str(counterparty).lower()}, {"_id": 0, "id": 1}
        )
        recipient = await _telegram_user_summary((recipient_doc or {}).get("id"))
    else:
        recipient = {
            "name": recipient_name,
            "email": "—",
            "phone": _telegram_mask_phone(recipient_phone),
        }
        if recipient_wallet:
            wallet = str(recipient_wallet)
            recipient["phone"] = f"Portefeuille {wallet[:8]}…{wallet[-6:]}"
    return [
        "━━━━ 👤 <b>EXPÉDITEUR</b> ━━━━",
        f"👤 Nom : <b>{html_escape(owner.get('name', 'Compte Biz-transPay'))}</b>",
        f"📧 Email : <code>{html_escape(owner.get('email', '—'))}</code>",
        f"🔑 Username : <code>{html_escape(str(owner.get('username') or '—'))}</code>",
        f"📞 Téléphone : <code>{html_escape(owner.get('phone', '—'))}</code>",
        f"🌍 Pays : <b>{html_escape(str(owner.get('country') or '—'))}</b>",
        "━━━━ 📱 <b>DESTINATAIRE</b> ━━━━",
        f"👤 Nom : <b>{html_escape(str(recipient.get('name', 'Destinataire externe'))[:120])}</b>",
        f"📧 Email : <code>{html_escape(recipient.get('email', '—'))}</code>",
        f"📞 Téléphone / wallet : <code>{html_escape(recipient.get('phone', '—'))}</code>",
        f"🌍 Pays : <b>{html_escape(str(meta.get('country_label') or meta.get('country') or '—'))}</b>",
    ]


async def _telegram_transaction_context(
    data: Optional[dict],
) -> tuple[Optional[dict], Optional[dict]]:
    transaction = None
    deposit = None
    if data and data.get("transaction_id"):
        transaction = await db.transactions.find_one(
            {"id": data["transaction_id"]}, {"_id": 0}
        )
    if data and data.get("deposit_id"):
        deposit = await db.momo_deposits.find_one(
            {"id": data["deposit_id"]}, {"_id": 0}
        )
    return transaction, deposit


async def _telegram_notification_text(
    user_id: str,
    ntype: str,
    title: str,
    body: str,
    data: Optional[dict],
) -> str:
    if ntype == "security_alert":
        return _telegram_security_text(data)
    if ntype in TELEGRAM_ADMIN_NOTIFICATION_TYPES:
        return await _telegram_admin_notification_text(
            user_id, ntype, title, body, data
        )
    transaction, deposit = await _telegram_transaction_context(data)
    record = deposit or transaction or {}
    meta = (transaction or {}).get("metadata") or {}
    title_by_type = {
        "deposit_success": "✅ PAIEMENT REÇU / DÉPÔT CONFIRMÉ",
        "withdrawal_success": "✅ RETRAIT VALIDÉ AUTOMATIQUEMENT",
        "withdrawal_failed": "❌ RETRAIT ÉCHOUÉ / REMBOURSÉ",
        "transfer_success": "✅ TRANSFERT CONFIRMÉ",
        "exchange_success": "✅ CONVERSION CONFIRMÉE",
    }
    provider = (
        record.get("provider") or meta.get("provider")
        or ("fedapay" if meta.get("fedapay_payout_id") else None)
        or ("paydunya" if meta.get("paydunya_disbursement_token") else None)
        or ("izichangepay" if meta.get("izipay_payout_id") else None)
        or ("mbiyo" if meta.get("mbiyo_transaction_id") else None)
        or "Biz-transPay"
    )
    provider_labels = {
        "paydunya": "PayDunya", "fedapay": "FedaPay", "mbiyo": "Mbiyo",
        "izipay": "IzichangePay", "izichangepay": "IzichangePay",
    }
    provider_label = provider_labels.get(str(provider).lower(), str(provider))
    currency = str(
        record.get("currency") or (data or {}).get("currency") or "—"
    ).upper()
    if deposit:
        gross = deposit.get("amount_gross", deposit.get("amount"))
        net = deposit.get("amount_net", (data or {}).get("amount"))
        operator = deposit.get("operator_name") or deposit.get("operator") or "—"
        provider_reference = (
            deposit.get("provider_reference") or deposit.get("paydunya_reference")
            or deposit.get("fedapay_reference") or deposit.get("mbiyo_transaction_id")
        )
        internal_reference = deposit.get("reference") or deposit.get("id")
        event_time = deposit.get("approved_at") or deposit.get("updated_at") or deposit.get("created_at")
        source_labels = {
            "link_payment": "Lien de paiement",
            "merchant_api": "API marchand",
            "dashboard": "Dépôt Mobile Money",
        }
        lines = [
            f"<b>{title_by_type.get(ntype, title)}</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"📋 Type : <b>{html_escape(source_labels.get(str(deposit.get('source')), 'Dépôt Mobile Money'))}</b>",
            f"💰 Montant brut : <b>{html_escape(_telegram_display_amount(gross, currency))}</b>",
            f"💳 Montant crédité : <b>{html_escape(_telegram_display_amount(net, currency))}</b>",
            f"💼 Wallet crédité : <b>{html_escape(currency)}</b>",
            f"🔌 Passerelle : <b>{html_escape(provider_label)}</b>",
            f"📱 Opérateur : <b>{html_escape(str(operator))}</b>",
            f"📌 Réf. Biz-transPay : <code>{html_escape(str(internal_reference or '—'))}</code>",
            f"🔗 Réf. fournisseur : <code>{html_escape(str(provider_reference or '—'))}</code>",
            f"🕘 Heure : <b>{html_escape(_telegram_display_time(event_time))}</b>",
        ]
    else:
        gross = meta.get("total_debit", record.get("amount"))
        net = meta.get("recipient_gets", record.get("amount"))
        operator = meta.get("operator_name") or meta.get("operator") or meta.get("network") or "—"
        provider_reference = (
            meta.get("provider_reference") or meta.get("mbiyo_transaction_id")
            or meta.get("fedapay_payout_id") or meta.get("paydunya_disbursement_id")
            or meta.get("izipay_payout_id")
        )
        internal_reference = record.get("reference") or record.get("id")
        event_time = meta.get("completed_at") or record.get("updated_at") or record.get("created_at")
        lines = [
            f"<b>{title_by_type.get(ntype, title)}</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"💰 Montant brut : <b>{html_escape(_telegram_display_amount(gross, currency))}</b>",
            f"💳 Montant net : <b>{html_escape(_telegram_display_amount(net, currency))}</b>",
            f"💼 Wallet débité : <b>{html_escape(currency)}</b>",
            f"🔌 Passerelle : <b>{html_escape(provider_label)}</b>",
            f"📱 Opérateur / réseau : <b>{html_escape(str(operator))}</b>",
            f"📌 Réf. Biz-transPay : <code>{html_escape(str(internal_reference or '—'))}</code>",
            f"🔗 Réf. fournisseur : <code>{html_escape(str(provider_reference or '—'))}</code>",
            f"🕘 Heure : <b>{html_escape(_telegram_display_time(event_time))}</b>",
        ]
    lines.extend(await _telegram_party_lines(transaction, deposit))
    return "\n".join(lines)[:TELEGRAM_MAX_MESSAGE_LENGTH]


async def _telegram_admin_notification_text(
    user_id: str,
    ntype: str,
    title: str,
    body: str,
    data: Optional[dict],
) -> str:
    """Format admin-only operational alerts without exposing raw account data."""
    safe = data or {}
    user = await _telegram_user_summary(user_id)
    account_lines = [
        f"👤 Compte : <b>{html_escape(str(user.get('name') or 'Compte Biz-transPay')[:120])}</b>",
        f"🔑 Username : <code>{html_escape(str(user.get('username') or '—'))}</code>",
        f"📧 Email : <code>{html_escape(user.get('email') or '—')}</code>",
    ]
    if ntype == "admin_login":
        unusual = " — caractéristiques inhabituelles" if safe.get("unusual") else ""
        lines = [
            f"<b>🔐 CONNEXION ADMINISTRATEUR{unusual}</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            *account_lines,
            f"🌐 IP : <code>{html_escape(_telegram_mask_ip(safe.get('ip')))}</code>",
            f"🕘 Heure : <b>{html_escape(_telegram_display_time(safe.get('detected_at')))}</b>",
        ]
        return "\n".join(lines)[:TELEGRAM_MAX_MESSAGE_LENGTH]

    status_labels = {
        "kyc_submitted": "SOUMIS — EN ATTENTE DE VALIDATION",
        "kyc_verified": "VALIDÉ",
        "kyc_rejected": "REJETÉ",
        "kyc_resubmit_requested": "NOUVEAUX DOCUMENTS DEMANDÉS",
    }
    status = str(safe.get("status") or ntype.removeprefix("kyc_")).lower()
    lines = [
        f"<b>🪪 KYC — {html_escape(status_labels.get(ntype, status.upper()))}</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        *account_lines,
        f"📊 Statut : <b>{html_escape(status)}</b>",
    ]
    reason = safe.get("reason")
    if reason:
        lines.append(f"📝 Motif : {html_escape(str(reason)[:500])}")
    event_time = safe.get("reviewed_at") or safe.get("submitted_at") or safe.get("detected_at")
    lines.append(f"🕘 Heure : <b>{html_escape(_telegram_display_time(event_time))}</b>")
    return "\n".join(lines)[:TELEGRAM_MAX_MESSAGE_LENGTH]


async def _send_telegram_message(chat_id: str, message: str) -> None:
    token, _ = _telegram_config()
    if not token or not chat_id:
        return
    try:
        import httpx

        message = message[:TELEGRAM_MAX_MESSAGE_LENGTH]
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(
                url,
                json={
                    "chat_id": chat_id,
                    "text": message,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
            )
            result = response.json()
        if response.status_code != 200 or not result.get("ok"):
            logger.warning(
                "Telegram notification rejected with status=%s",
                response.status_code,
            )
    except Exception as exc:  # noqa: BLE001
        # Telegram must never block or fail a financial/authentication flow.
        logger.warning("Telegram notification delivery failed: %s", exc)


async def _send_telegram_notification(message: str) -> None:
    _, chat_id = _telegram_config()
    if chat_id:
        await _send_telegram_message(chat_id, message)


def _telegram_command_parts(text: str) -> tuple[str, str]:
    raw_parts = (text or "").strip().split(maxsplit=1)
    if not raw_parts:
        return "", ""
    command = raw_parts[0].split("@", 1)[0].lstrip("/")
    command = unicodedata.normalize("NFKD", command)
    command = "".join(char for char in command if not unicodedata.combining(char))
    return command.lower(), raw_parts[1].strip() if len(raw_parts) > 1 else ""


async def _telegram_search_records(kind: str, query: str) -> list[dict]:
    query = str(query or "").strip()
    if not query or len(query) > 100:
        return []
    needle = _literal_regex_term(query, field_name="Identifiant")
    user_ids: list[str] = []
    users = await db.users.find(
        {"email": {"$regex": f"^{needle}$", "$options": "i"}},
        {"_id": 0, "id": 1},
    ).to_list(10)
    user_ids.extend(str(user["id"]) for user in users if user.get("id"))

    matches: list[dict] = []
    if kind == "depot":
        tx_types = ["deposit", "payment", "link_payment"]
    elif kind == "retrait":
        tx_types = ["withdrawal", "transfer"]
    else:
        tx_types = ["exchange"]

    tx_or = [
        {"id": query},
        {"reference": query},
        {"id": {"$regex": needle, "$options": "i"}},
        {"reference": {"$regex": needle, "$options": "i"}},
    ]
    if user_ids:
        tx_or.append({"user_id": {"$in": user_ids}})
    tx_query = {
        "type": {"$in": tx_types},
        "$or": tx_or,
    }
    if kind == "retrait":
        tx_query["direction"] = "out"
    elif kind == "depot":
        tx_query["direction"] = "in"
    tx_docs = await db.transactions.find(
        tx_query, {"_id": 0}
    ).sort("created_at", -1).limit(5).to_list(5)
    matches.extend({"source": "transaction", "record": doc} for doc in tx_docs)

    if kind == "depot":
        deposit_or = [
            {"id": query},
            {"paydunya_reference": query},
            {"mbiyo_transaction_id": query},
            {"fedapay_id": query},
            {"email": {"$regex": needle, "$options": "i"}},
        ]
        if user_ids:
            deposit_or.append({"user_id": {"$in": user_ids}})
        deposit_docs = await db.momo_deposits.find(
            {"$or": deposit_or}, {"_id": 0}
        ).sort("created_at", -1).limit(5).to_list(5)
        matches.extend({"source": "deposit", "record": doc} for doc in deposit_docs)

        payment_or = [
            {"session_id": query},
            {"id": query},
            {"reference": query},
            {"email": {"$regex": needle, "$options": "i"}},
        ]
        if user_ids:
            payment_or.append({"user_id": {"$in": user_ids}})
        payment_docs = await db.payment_transactions.find(
            {"$or": payment_or}, {"_id": 0}
        ).sort("created_at", -1).limit(5).to_list(5)
        matches.extend(
            {"source": "payment", "record": doc} for doc in payment_docs
        )

    deduped: list[dict] = []
    seen: set[str] = set()
    for match in matches:
        record = match["record"]
        key = f"{match['source']}:{record.get('id') or record.get('session_id')}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(match)
    return deduped[:5]


def _telegram_status_label(status: Optional[str]) -> str:
    labels = {
        "completed": "confirmé",
        "approved": "confirmé",
        "paid": "confirmé",
        "failed": "échoué",
        "cancelled": "annulé",
        "canceled": "annulé",
        "pending": "en attente",
        "expired": "expiré",
    }
    return labels.get(str(status or "").lower(), str(status or "inconnu"))


async def _telegram_record_text(kind: str, match: dict) -> str:
    source = match["source"]
    record = match["record"]
    if source == "transaction":
        owner = await _telegram_user_summary(record.get("user_id"))
        party_lines = await _telegram_party_lines(transaction=record)
        meta = record.get("metadata") or {}
        identifier = record.get("id") or "—"
        reference = record.get("reference") or "—"
        amount = f"{record.get('amount', 0)} {record.get('currency', '')}"
        extra = ""
        if record.get("type") == "exchange":
            extra = (
                f"\nConversion : {meta.get('from_currency', record.get('currency'))}"
                f" → {meta.get('to_currency', '—')}"
                f"\nMontant reçu : {meta.get('received', '—')}"
            )
        return "\n".join([
            f"<b>{kind.title()} — {_telegram_status_label(record.get('status'))}</b>",
            f"Numéro : <code>{html_escape(str(identifier))}</code>",
            f"Référence : <code>{html_escape(str(reference))}</code>",
            f"Montant : <b>{html_escape(str(amount))}</b>",
            f"Compte : {html_escape(owner.get('name', '—'))}",
            f"Email compte : <code>{html_escape(owner.get('email', '—'))}</code>",
            *party_lines,
            extra,
        ])

    if source == "deposit":
        party_lines = await _telegram_party_lines(deposit=record)
        identifier = record.get("id") or "—"
        provider_ref = (
            record.get("paydunya_reference")
            or record.get("mbiyo_transaction_id")
            or record.get("fedapay_id")
            or "—"
        )
        amount = (
            record.get("amount")
            or record.get("requested_amount")
            or record.get("wallet_credit_amount")
            or 0
        )
        return "\n".join([
            f"<b>Dépôt — {_telegram_status_label(record.get('status'))}</b>",
            f"Numéro : <code>{html_escape(str(identifier))}</code>",
            f"Référence fournisseur : <code>{html_escape(str(provider_ref))}</code>",
            f"Montant : <b>{html_escape(str(amount))} {html_escape(str(record.get('currency', '')))}</b>",
            f"Opérateur : {html_escape(str(record.get('operator_name') or record.get('operator') or '—'))}",
            *party_lines,
        ])

    owner = await _telegram_user_summary(record.get("user_id"))
    return "\n".join([
        f"<b>Dépôt — {_telegram_status_label(record.get('status') or record.get('payment_status'))}</b>",
        f"Numéro : <code>{html_escape(str(record.get('id') or record.get('session_id') or '—'))}</code>",
        f"Référence paiement : <code>{html_escape(str(record.get('reference') or record.get('session_id') or '—'))}</code>",
        f"Montant : <b>{html_escape(str(record.get('amount', 0)))} {html_escape(str(record.get('currency', '')))}</b>",
        f"Destinataire : <b>{html_escape(owner.get('name', 'Compte Biz-transPay'))}</b>",
        f"Email destinataire : <code>{html_escape(owner.get('email', '—'))}</code>",
    ])


async def _telegram_handle_command(message: dict) -> None:
    _, allowed_chat_id = _telegram_config()
    chat = message.get("chat") or {}
    chat_id = str(chat.get("id") or "")
    if not allowed_chat_id or chat_id != allowed_chat_id:
        return
    command, query = _telegram_command_parts(message.get("text", ""))
    aliases = {
        "depot": "depot",
        "deposit": "depot",
        "retrait": "retrait",
        "withdrawal": "retrait",
        "withdraw": "retrait",
        "echange": "echange",
        "exchange": "echange",
    }
    if command in {"start", "help", "aide"}:
        await _send_telegram_message(
            chat_id,
            "Commandes disponibles :\n"
            "/depot <numéro, référence ou email>\n"
            "/retrait <numéro, référence ou email>\n"
            "/echange <numéro, référence ou email>",
        )
        return
    kind = aliases.get(command)
    if not kind:
        return
    if not query:
        await _send_telegram_message(
            chat_id,
            f"Utilisation : /{command} <numéro, référence ou email>",
        )
        return
    matches = await _telegram_search_records(kind, query)
    if not matches:
        await _send_telegram_message(chat_id, f"Aucun {kind} trouvé pour cette recherche.")
        return
    blocks = [await _telegram_record_text(kind, match) for match in matches]
    await _send_telegram_message(
        chat_id,
        f"<b>{len(blocks)} résultat(s)</b>\n\n" + "\n\n".join(blocks),
    )


async def _telegram_command_worker() -> None:
    global _telegram_update_offset
    token, chat_id = _telegram_config()
    if not token or not chat_id:
        return
    try:
        import httpx

        async with httpx.AsyncClient(timeout=35.0) as client:
            while True:
                try:
                    payload = {"limit": 20, "timeout": 25, "allowed_updates": ["message"]}
                    if _telegram_update_offset is not None:
                        payload["offset"] = _telegram_update_offset
                    response = await client.get(
                        f"https://api.telegram.org/bot{token}/getUpdates",
                        params=payload,
                    )
                    result = response.json()
                    if response.status_code != 200 or not result.get("ok"):
                        logger.warning("Telegram command polling rejected with status=%s", response.status_code)
                        await asyncio.sleep(15)
                        continue
                    for update in result.get("result") or []:
                        _telegram_update_offset = int(update.get("update_id", 0)) + 1
                        if update.get("message"):
                            await _telegram_handle_command(update["message"])
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Telegram command polling failed: %s", exc)
                    await asyncio.sleep(15)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Telegram command worker stopped: %s", exc)


@app.on_event("startup")
async def _start_telegram_command_worker() -> None:
    global _telegram_command_task
    commands_enabled = os.environ.get(
        "TELEGRAM_COMMAND_POLLING_ENABLED", "true"
    ).strip().lower() in {"1", "true", "yes"}
    token, chat_id = _telegram_config()
    if commands_enabled and token and chat_id and (
        _telegram_command_task is None or _telegram_command_task.done()
    ):
        _telegram_command_task = asyncio.create_task(_telegram_command_worker())


@app.on_event("shutdown")
async def _stop_telegram_command_worker() -> None:
    global _telegram_command_task
    if _telegram_command_task and not _telegram_command_task.done():
        _telegram_command_task.cancel()
        try:
            await _telegram_command_task
        except asyncio.CancelledError:
            pass
    _telegram_command_task = None


async def _telegram_notification_worker() -> None:
    while True:
        event = await _telegram_queue.get()
        try:
            message = await _telegram_notification_text(
                event["user_id"],
                event["ntype"],
                event["title"],
                event["body"],
                event["data"],
            )
            await _send_telegram_notification(message)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Telegram notification formatting failed: %s", exc)
        finally:
            _telegram_queue.task_done()


async def _queue_telegram_notification(
    user_id: str,
    ntype: str,
    title: str,
    body: str,
    data: Optional[dict],
) -> None:
    global _telegram_queue, _telegram_worker_task
    token, chat_id = _telegram_config()
    if (
        not token
        or not chat_id
        or ntype not in (
            TELEGRAM_FINAL_NOTIFICATION_TYPES
            | TELEGRAM_ADMIN_NOTIFICATION_TYPES
        )
        or "en cours" in f"{title} {body}".lower()
    ):
        return
    if _telegram_queue is None:
        _telegram_queue = asyncio.Queue(maxsize=200)
    if _telegram_worker_task is None or _telegram_worker_task.done():
        _telegram_worker_task = asyncio.create_task(
            _telegram_notification_worker()
        )
    try:
        _telegram_queue.put_nowait(
            {
                "user_id": user_id,
                "ntype": ntype,
                "title": title,
                "body": body,
                "data": data or {},
            }
        )
    except asyncio.QueueFull:
        logger.warning("Telegram notification queue is full; dropping alert")


async def _queue_security_telegram_alert(
    event_type: str,
    request: Request,
    *,
    outcome: str,
    solution: str,
    profile: Optional[str] = None,
    user_id: str = "platform",
) -> None:
    """Queue a deduplicated security alert without delaying the request."""
    ip = _edge_request_ip(request)
    dedupe_key = hashlib.sha256(
        f"{event_type}|{ip}|{request.url.path}|{profile or ''}".encode()
    ).hexdigest()
    now_ts = datetime.now(timezone.utc).timestamp()
    async with _security_alert_lock:
        previous = _security_alert_last_sent.get(dedupe_key, 0)
        if now_ts - previous < SECURITY_ALERT_COOLDOWN_SECONDS:
            return
        _security_alert_last_sent[dedupe_key] = now_ts
        if len(_security_alert_last_sent) > 5000:
            cutoff = now_ts - SECURITY_ALERT_COOLDOWN_SECONDS
            for key, sent_at in list(_security_alert_last_sent.items()):
                if sent_at < cutoff:
                    _security_alert_last_sent.pop(key, None)
    await _queue_telegram_notification(
        user_id,
        "security_alert",
        "Alerte sécurité",
        outcome,
        {
            "security_event": event_type,
            "outcome": outcome,
            "solution": solution,
            "path": request.url.path,
            "method": request.method.upper(),
            "ip": ip,
            "profile": profile,
            "detected_at": now_iso(),
        },
    )


async def notify(user_id: str, ntype: str, title: str, body: str,
                 data: Optional[dict] = None,
                 send_telegram: bool = True) -> dict:
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
    if send_telegram:
        await _queue_telegram_notification(user_id, ntype, title, body, data)
    return doc



# ==================== AUTH ====================
@api.get("/")
async def root():
    return {"message": "Biz-transPay API", "status": "ok"}


AUTH_WINDOW_SECONDS = 15 * 60
AUTH_CHALLENGE_AFTER = 5


def _auth_ip(request: Request) -> str:
    return (request.client.host if request.client else None) or "unknown"


def _admin_request_ip(request: Request) -> str:
    """Return the client IP used by the optional administrator allowlist.

    Forwarded headers are ignored unless explicitly enabled because they are
    otherwise trivially spoofable when the app is reachable directly.
    """
    if ADMIN_TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return real_ip
    return _auth_ip(request)


def _admin_ip_allowed(request: Request) -> bool:
    if not ADMIN_ALLOWED_IPS:
        return True
    candidate = _admin_request_ip(request)
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    for rule in ADMIN_ALLOWED_IPS:
        try:
            if address in ipaddress.ip_network(rule, strict=False):
                return True
        except ValueError:
            logging.getLogger(__name__).warning(
                "Ignoring invalid ADMIN_ALLOWED_IPS entry: %s", rule
            )
    return False


def _edge_request_ip(request: Request) -> str:
    if EDGE_TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return real_ip
    return _auth_ip(request)


def _edge_ip_blocked(request: Request) -> bool:
    if not EDGE_BLOCKED_IPS:
        return False
    try:
        candidate = ipaddress.ip_address(_edge_request_ip(request))
    except ValueError:
        return False
    for rule in EDGE_BLOCKED_IPS:
        try:
            if candidate in ipaddress.ip_network(rule, strict=False):
                return True
        except ValueError:
            logging.getLogger(__name__).warning(
                "Ignoring invalid EDGE_BLOCKED_IPS entry: %s", rule
            )
    return False


def _auth_hash(value: str) -> str:
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()


def _literal_regex_term(value: str, *, field_name: str = "valeur") -> str:
    """Build a bounded literal regex, never a client-controlled pattern."""
    term = str(value or "").strip()
    if not term:
        raise HTTPException(422, f"{field_name} requis")
    if len(term) > 100:
        raise HTTPException(422, f"{field_name} trop long")
    return re.escape(term)


_IMAGE_DATA_URL_RE = re.compile(
    r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$",
    re.IGNORECASE,
)
_IMAGE_SIGNATURES = {
    "image/jpeg": lambda data: data.startswith(b"\xff\xd8\xff"),
    "image/png": lambda data: data.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/webp": lambda data: (
        len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    ),
}


def _validate_raster_image(value: Optional[str], field_name: str,
                           *, required: bool = False) -> Optional[str]:
    """Accept only bounded raster data URLs; SVG and scriptable formats stay out."""
    if not value:
        if required:
            raise HTTPException(422, f"{field_name} requis")
        return None
    match = _IMAGE_DATA_URL_RE.fullmatch(value.strip())
    if not match:
        raise HTTPException(
            422, f"{field_name} doit être une image JPEG, PNG ou WebP"
        )
    mime = match.group(1).lower()
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (ValueError, TypeError):
        raise HTTPException(422, f"{field_name} invalide")
    if not raw or len(raw) > 3_000_000 or not _IMAGE_SIGNATURES[mime](raw):
        raise HTTPException(422, f"{field_name} invalide ou trop volumineux")
    return f"data:{mime};base64,{match.group(2)}"


def _validate_image_source(value: Optional[str], field_name: str) -> Optional[str]:
    """Allow safe raster data URLs or ordinary HTTPS/HTTP image URLs only."""
    if not value:
        return None
    if value.strip().lower().startswith("data:"):
        return _validate_raster_image(value, field_name)
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(422, f"{field_name} URL invalide")
    if parsed.username or parsed.password:
        raise HTTPException(422, f"{field_name} URL invalide")
    if parsed.path.lower().endswith((".svg", ".svgz")):
        raise HTTPException(422, f"{field_name} SVG interdit")
    return value.strip()


def _validate_http_url(value: str, field_name: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(422, f"{field_name} URL invalide")
    if parsed.username or parsed.password:
        raise HTTPException(422, f"{field_name} URL invalide")
    return value.strip().rstrip("/")


async def _is_safe_outbound_http_url(value: str) -> bool:
    """Reject webhook targets that resolve to local or private networks."""
    try:
        normalized = _validate_http_url(value, "URL")
        parsed = urlparse(normalized)
        hostname = (parsed.hostname or "").strip().lower().rstrip(".")
        if not hostname or hostname in {"localhost", "localhost.localdomain"}:
            return False
        infos = await asyncio.to_thread(
            socket.getaddrinfo,
            hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
        addresses = {str(item[4][0]) for item in infos if item[4]}
        if not addresses:
            return False
        return all(ipaddress.ip_address(address).is_global for address in addresses)
    except (HTTPException, OSError, ValueError):
        return False


async def _validate_outbound_http_url(value: str, field_name: str = "URL") -> str:
    normalized = _validate_http_url(value, field_name)
    if not await _is_safe_outbound_http_url(normalized):
        raise HTTPException(422, f"{field_name} doit viser un hôte public")
    return normalized


def _csrf_allowed_hosts(request: Request) -> set[str]:
    hosts: set[str] = set()
    for raw in (
        request.headers.get("host"),
        request.headers.get("x-forwarded-host"),
        os.environ.get("REPLIT_DEV_DOMAIN"),
        os.environ.get("REPLIT_DOMAINS"),
    ):
        for value in str(raw or "").split(","):
            value = value.strip().lower()
            if not value:
                continue
            parsed = urlparse(value if "://" in value else f"https://{value}")
            if parsed.netloc:
                hosts.add(parsed.netloc)
    for value in os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(","):
        parsed = urlparse(value.strip())
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            hosts.add(parsed.netloc.lower())
    return hosts


def _csrf_origin_is_allowed(request: Request) -> bool:
    fetch_site = (request.headers.get("sec-fetch-site") or "").lower()
    if fetch_site == "cross-site":
        return False
    source = request.headers.get("origin") or request.headers.get("referer")
    if not source or source == "null":
        return False
    parsed = urlparse(source)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        return False
    return parsed.netloc.lower() in _csrf_allowed_hosts(request)


def _csrf_error(code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={"detail": {"code": code, "message": message}},
    )


def _validate_csrf_request(request: Request) -> Optional[JSONResponse]:
    if request.method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return None
    if not request.url.path.startswith("/api/"):
        return None
    if request.url.path in {
        "/api/auth/login",
        "/api/auth/register",
        "/api/auth/recover",
    }:
        return None
    # Bearer-authenticated server-to-server calls and provider callbacks do not
    # carry browser session cookies and therefore do not use browser CSRF.
    if not request.cookies.get(SESSION_COOKIE_NAME):
        return None
    if not _csrf_origin_is_allowed(request):
        return _csrf_error(
            "CSRF_ORIGIN_REJECTED",
            "Origine de la requête non autorisée.",
        )
    cookie_token = request.cookies.get(CSRF_COOKIE_NAME) or ""
    header_token = request.headers.get(CSRF_HEADER_NAME) or ""
    if (
        len(cookie_token) < 32
        or len(cookie_token) > 128
        or len(header_token) < 32
        or len(header_token) > 128
        or not secrets.compare_digest(cookie_token, header_token)
    ):
        return _csrf_error(
            "CSRF_TOKEN_INVALID",
            "Jeton CSRF absent ou invalide.",
        )
    return None


async def _issue_login_challenge(identifier: str, ip: str) -> dict:
    nonce = secrets.token_urlsafe(24)
    challenge_id = new_id()
    difficulty = 4
    await db.auth_challenges.insert_one({
        "id": challenge_id,
        "nonce": nonce,
        "identifier_hash": _auth_hash(identifier),
        "ip_hash": _auth_hash(ip),
        "difficulty": difficulty,
        "used": False,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
        "created_at": now_iso(),
    })
    return {"id": challenge_id, "nonce": nonce, "difficulty": difficulty}


async def _verify_login_challenge(identifier: str, ip: str,
                                  challenge_id: str, solution: str) -> bool:
    challenge = await db.auth_challenges.find_one({
        "id": challenge_id,
        "identifier_hash": _auth_hash(identifier),
        "ip_hash": _auth_hash(ip),
        "used": False,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    }, {"_id": 0})
    if not challenge or not str(solution or "").isdigit():
        return False
    digest = hashlib.sha256(
        f"{challenge['nonce']}{solution}".encode()).hexdigest()
    if not digest.startswith("0" * int(challenge["difficulty"])):
        return False
    claimed = await db.auth_challenges.update_one(
        {"id": challenge_id, "used": False},
        {"$set": {"used": True, "used_at": datetime.now(timezone.utc)}},
    )
    return claimed.modified_count == 1


async def _auth_state(scope: str, value: str) -> dict:
    return await db.auth_rate_limits.find_one(
        {"scope": scope, "value_hash": _auth_hash(value)}, {"_id": 0}
    ) or {}


async def _check_login_security(identifier: str, request: Request,
                                challenge_id: Optional[str],
                                challenge_solution: Optional[str]) -> None:
    ip = _auth_ip(request)
    states = [
        await _auth_state("account", identifier),
        await _auth_state("ip", ip),
    ]
    now = datetime.now(timezone.utc)
    for index, state in enumerate(states):
        lock_until = state.get("lock_until")
        if lock_until and lock_until > now:
            seconds = max(1, int((lock_until - now).total_seconds()))
            raise HTTPException(
                429,
                detail={"message": "Trop de tentatives. Réessayez plus tard.",
                        "code": "AUTH_TEMPORARILY_LOCKED",
                        "retry_after": seconds},
                headers={"Retry-After": str(seconds)},
            )
    account_failures = int(states[0].get("failures", 0))
    ip_failures = int(states[1].get("failures", 0))
    failures = max(account_failures, ip_failures // 2)
    if failures >= AUTH_CHALLENGE_AFTER:
        if not challenge_id or not challenge_solution or not await _verify_login_challenge(
                identifier, ip, challenge_id, challenge_solution):
            challenge = await _issue_login_challenge(identifier, ip)
            raise HTTPException(
                429,
                detail={"message": "Vérification de sécurité requise.",
                        "code": "AUTH_CHALLENGE_REQUIRED",
                        "challenge": challenge},
            )


async def _record_login_failure(identifier: str, request: Request) -> None:
    now = datetime.now(timezone.utc)
    for scope, value in (("account", identifier), ("ip", _auth_ip(request))):
        key = {"scope": scope, "value_hash": _auth_hash(value)}
        current = await _auth_state(scope, value)
        failures = int(current.get("failures", 0)) + 1
        lock_seconds = 0
        lock_failures = failures if scope == "account" else failures // 2
        if lock_failures >= 12:
            lock_seconds = 3600
        elif lock_failures >= 10:
            lock_seconds = 900
        elif lock_failures >= 8:
            lock_seconds = 300
        elif lock_failures >= 6:
            lock_seconds = 60
        update = {
            "$set": {
                "last_failed_at": now,
                "expires_at": now + timedelta(seconds=AUTH_WINDOW_SECONDS),
                **({"lock_until": now + timedelta(seconds=lock_seconds)}
                   if lock_seconds else {}),
            },
            "$setOnInsert": {"scope": scope, "value_hash": key["value_hash"],
                             "created_at": now},
            "$inc": {"failures": 1},
        }
        await db.auth_rate_limits.update_one(key, update, upsert=True)


async def _clear_login_account_failures(identifier: str) -> None:
    await db.auth_rate_limits.delete_one(
        {"scope": "account", "value_hash": _auth_hash(identifier)}
    )


async def _begin_mfa_enrollment(user: dict) -> dict:
    secret = auth_security.generate_totp_secret()
    enrollment_id = new_id()
    await db.mfa_enrollments.insert_one({
        "id": enrollment_id,
        "user_id": user["id"],
        "secret_encrypted": auth_security.encrypt_mfa_secret(secret),
        "used": False,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
        "created_at": now_iso(),
    })
    token = auth_security.create_mfa_token(
        user["id"], "mfa_setup", enrollment_id=enrollment_id)
    return {
        "setup_token": token,
        "secret": secret,
        "otpauth_uri": auth_security.totp_uri(
            secret, user.get("email") or user.get("username") or user["id"]),
        "expires_in": 600,
    }


async def _complete_login(user: dict, request: Request) -> None:
    ip = _auth_ip(request)
    user_agent = (request.headers.get("user-agent") or "")[:300]
    unusual = bool(
        user.get("last_login_ip") and user.get("last_login_ip") != ip
        or user.get("last_login_user_agent")
        and user.get("last_login_user_agent") != user_agent
    )
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_login_ip": ip, "last_login_user_agent": user_agent,
                  "last_login_at": now_iso()}},
    )
    await db.auth_events.insert_one({
        "id": new_id(), "user_id": user["id"], "type": "login",
        "ip": ip, "user_agent": user_agent, "unusual": unusual,
        "created_at": now_iso(),
    })
    if _is_admin_account(user):
        await _queue_telegram_notification(
            user["id"],
            "admin_login",
            "Connexion administrateur",
            "Le compte administrateur vient de se connecter.",
            {
                "ip": ip,
                "unusual": unusual,
                "detected_at": now_iso(),
            },
        )
    if unusual:
        await notify(
            user["id"], "security_alert", "Nouvelle connexion détectée",
            "Une nouvelle connexion à votre compte Biz-transPay a été détectée.",
            data={
                "security_event": "unusual_login",
                "outcome": (
                    "Accès réussi avec des caractéristiques inhabituelles. "
                    "Une attaque n’est pas confirmée."
                ),
                "solution": (
                    "Vérifier immédiatement cette connexion. Si elle est inconnue, "
                    "révoquer les sessions, changer le mot de passe et contrôler "
                    "les opérations financières récentes."
                ),
                "path": "/api/auth/login",
                "method": "POST",
                "ip": ip,
                "detected_at": now_iso(),
            },
            send_telegram=False,
        )


async def _verify_user_totp(user: dict, code: str) -> bool:
    encrypted = user.get("two_fa_secret_encrypted")
    if not encrypted:
        return False
    try:
        secret = auth_security.decrypt_mfa_secret(encrypted)
    except Exception:
        return False
    counter = auth_security.verify_totp(
        secret, code, user.get("two_fa_last_counter"))
    if counter is None:
        return False
    claimed = await db.users.update_one(
        {"id": user["id"],
         "$or": [{"two_fa_last_counter": {"$lt": counter}},
                 {"two_fa_last_counter": {"$exists": False}}]},
        {"$set": {"two_fa_last_counter": counter}},
    )
    return claimed.modified_count == 1


def _is_admin_account(user: dict) -> bool:
    return user.get("role") in ("admin", "super_admin")


def _is_platform_owner_email(email: str) -> bool:
    return bool(
        PLATFORM_OWNER_EMAIL
        and str(email or "").strip().lower() == PLATFORM_OWNER_EMAIL
    )


def _platform_owner_recovery_eligible(user: dict) -> bool:
    if user.get("platform_owner") is True:
        return True
    if not _is_platform_owner_email(user.get("email")):
        return False
    try:
        created_at = datetime.fromisoformat(
            str(user.get("created_at") or "").replace("Z", "+00:00")
        )
        claim_before = datetime.fromisoformat(
            PLATFORM_OWNER_CLAIM_BEFORE.replace("Z", "+00:00")
        )
        return _as_utc(created_at) <= _as_utc(claim_before)
    except (TypeError, ValueError):
        return False


def _platform_owner_preservation_filter() -> dict:
    protected = [
        {"role": "super_admin"},
        {"platform_owner": True},
    ]
    if PLATFORM_OWNER_EMAIL:
        protected.append({"email": PLATFORM_OWNER_EMAIL})
    return {"$or": protected}


async def _ensure_platform_owner_role(user: dict) -> dict:
    """Restore the configured platform owner to the immutable top-level role."""
    if not _platform_owner_recovery_eligible(user):
        return user
    expected = {
        "platform_owner": True,
        "role": "super_admin",
        "kyc_status": "verified",
        "is_blocked": False,
        "is_banned": False,
        "withdrawals_blocked": False,
    }
    if all(user.get(key) == value for key, value in expected.items()) \
            and not user.get("admin_role"):
        return user
    result = await db.users.update_one(
        {"id": user["id"]},
        {
            "$set": expected,
            "$unset": {"admin_role": ""},
        },
    )
    if result.matched_count != 1:
        raise HTTPException(409, "Impossible d'activer le propriétaire de la plateforme")
    restored = dict(user)
    restored.update(expected)
    restored.pop("admin_role", None)
    logger.warning("Platform owner role restored for user_id=%s", user["id"])
    return restored


@api.post("/auth/register")
async def register(req: RegisterRequest, request: Request, response: Response):
    await _require_turnstile(req.turnstile_token, request, "register")
    # The first account wins a recoverable bootstrap claim. A configured
    # owner is repaired only after authenticated login and only when the
    # account predates the server-side recovery cutoff.
    users_empty = (await db.users.count_documents({})) == 0
    password_errors = (
        auth_security.admin_password_policy_errors(req.password)
        if users_empty else auth_security.password_policy_errors(req.password)
    )
    if password_errors:
        raise HTTPException(
            422, "Mot de passe insuffisant : " + ", ".join(password_errors))
    if await db.users.find_one({"email": req.email.lower()}):
        raise HTTPException(400, "Email déjà utilisé")
    if await db.users.find_one({"username": req.username.lower()}):
        raise HTTPException(400, "Nom d'utilisateur déjà pris")

    is_first = False
    bootstrap_token = None
    if users_empty:
        now = datetime.now(timezone.utc)
        await db.platform_bootstrap.delete_one({
            "_id": "first_super_admin",
            "status": "claiming",
            "expires_at": {"$lt": now},
        })
        bootstrap_token = secrets.token_urlsafe(24)
        try:
            await db.platform_bootstrap.insert_one({
                "_id": "first_super_admin",
                "status": "claiming",
                "claim_token": bootstrap_token,
                "claimed_at": now_iso(),
                "expires_at": now + timedelta(minutes=5),
            })
            is_first = True
        except DuplicateKeyError:
            raise HTTPException(
                409,
                "Initialisation de la plateforme en cours. Réessayez dans quelques instants.",
            )

    uid = new_id()
    role = "super_admin" if is_first else "user"
    # Registration always creates the merchant profile. The request field is
    # kept for backward compatibility with existing clients, but the public
    # registration flow no longer lets users choose a profile type.
    account_type = "merchant"
    user_doc = {
        "id": uid,
        "full_name": req.full_name,
        "username": req.username.lower(),
        "account_type": account_type,
        "country": req.country,
        "phone": req.phone,
        "email": req.email.lower(),
        "password_hash": hash_password(req.password),
        "password_policy_version": 1,
        "kyc_status": "verified" if is_first else "not_started",
        "balance_xof": 0.0,   # zero-balance policy — credited only via confirmed txns
        "balance_xaf": 0.0,
        "balance_usdt": 0.0,
        "created_at": now_iso(),
        "two_fa_enabled": False,
        "language": "fr",
        "default_currency": "XOF",
        "role": role,
        "platform_owner": is_first,
        "is_blocked": False,
        "is_banned": False,
        "withdrawals_blocked": False,
    }
    try:
        await db.users.insert_one(user_doc)
    except Exception:
        if is_first:
            await db.platform_bootstrap.delete_one({
                "_id": "first_super_admin",
                "claim_token": bootstrap_token,
                "status": "claiming",
            })
        raise
    if is_first:
        await db.platform_bootstrap.update_one(
            {
                "_id": "first_super_admin",
                "claim_token": bootstrap_token,
                "status": "claiming",
            },
            {
                "$set": {
                    "status": "complete",
                    "user_id": uid,
                    "completed_at": now_iso(),
                },
                "$unset": {"claim_token": "", "expires_at": ""},
            },
        )

    if role in ("admin", "super_admin"):
        setup = await _begin_mfa_enrollment(user_doc)
        return {"mfa_setup_required": True, "mfa_setup": setup,
                "user": user_to_public(user_doc)}
    await _issue_session(uid, request, response)
    return {"token": None, "user": user_to_public(user_doc)}


@api.post("/auth/login")
async def login(req: LoginRequest, request: Request, response: Response):
    # The MFA continuation and a retry after the server-side proof-of-work
    # challenge already passed the initial browser bot check.
    if not req.mfa_token and not (req.challenge_id and req.challenge_solution):
        await _require_turnstile(req.turnstile_token, request, "login")
    ident = req.email.lower().strip()
    await _check_login_security(
        ident, request, req.challenge_id, req.challenge_solution)
    u = await db.users.find_one({"$or": [{"email": ident}, {"username": ident}]}, {"_id": 0})
    if not u or not verify_password(req.password, u["password_hash"]):
        await _record_login_failure(ident, request)
        raise HTTPException(401, "Identifiants invalides")
    u = await _ensure_platform_owner_role(u)
    is_admin = _is_admin_account(u)
    if is_admin and not u.get("two_fa_enabled"):
        setup = await _begin_mfa_enrollment(u)
        return {"mfa_setup_required": True, "mfa_setup": setup}
    if is_admin and u.get("two_fa_enabled"):
        if not req.mfa_token:
            return {
                "mfa_required": True,
                "mfa_token": auth_security.create_mfa_token(u["id"], "login_mfa"),
            }
        try:
            mfa_payload = auth_security.decode_mfa_token(req.mfa_token, "login_mfa")
        except HTTPException:
            await _record_login_failure(ident, request)
            raise
        if mfa_payload.get("sub") != u["id"] or not await _verify_user_totp(u, req.otp or ""):
            await _record_login_failure(ident, request)
            raise HTTPException(
                401,
                "Code 2FA invalide ou expiré. Utilisez le code à 6 chiffres "
                "actuellement affiché dans votre application d’authentification.",
            )
    await _clear_login_account_failures(ident)
    await _complete_login(u, request)
    await _issue_session(u["id"], request, response)
    return {"token": None, "user": user_to_public(u)}


@api.get("/auth/csrf")
async def csrf_token(response: Response,
                     uid: str = Depends(get_current_user_id)):
    token = _set_csrf_cookie(response)
    response.headers["Cache-Control"] = "no-store"
    return {"csrf_token": token}


@api.post("/auth/logout")
async def logout(request: Request, response: Response,
                 uid: str = Depends(get_current_user_id)):
    session_id = getattr(request.state, "session_id", None)
    if session_id:
        await db.sessions.update_one(
            {"id": session_id, "user_id": uid, "revoked_at": {"$exists": False}},
            {"$set": {"revoked_at": datetime.now(timezone.utc),
                      "revocation_reason": "logout"}},
        )
    _clear_session_cookie(response)
    return {"ok": True}


@api.get("/auth/sessions")
async def list_sessions(request: Request,
                        uid: str = Depends(get_current_user_id)):
    current_id = getattr(request.state, "session_id", None)
    docs = await db.sessions.find(
        {"user_id": uid, "revoked_at": {"$exists": False}},
        {"_id": 0, "id": 1, "created_at": 1, "last_activity_at": 1,
         "last_auth_at": 1, "expires_at": 1, "user_agent": 1, "ip": 1},
    ).sort("last_activity_at", -1).to_list(50)
    return [{
        "id": doc["id"],
        "created_at": _as_utc(doc["created_at"]).isoformat(),
        "last_activity_at": _as_utc(doc["last_activity_at"]).isoformat(),
        "last_auth_at": _as_utc(doc["last_auth_at"]).isoformat(),
        "expires_at": _as_utc(doc["expires_at"]).isoformat(),
        "user_agent": doc.get("user_agent") or "Navigateur inconnu",
        "ip": doc.get("ip") or "",
        "current": doc["id"] == current_id,
    } for doc in docs]


@api.delete("/auth/sessions/{session_id}")
async def revoke_session(session_id: str, request: Request, response: Response,
                         uid: str = Depends(get_current_user_id)):
    result = await db.sessions.update_one(
        {"id": session_id, "user_id": uid, "revoked_at": {"$exists": False}},
        {"$set": {"revoked_at": datetime.now(timezone.utc),
                  "revocation_reason": "user_revoked"}},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Session introuvable")
    if getattr(request.state, "session_id", None) == session_id:
        _clear_session_cookie(response)
    return {"ok": True}


@api.post("/auth/sessions/revoke-all")
async def revoke_all_sessions(request: Request, response: Response,
                              uid: str = Depends(get_current_user_id)):
    await db.sessions.update_many(
        {"user_id": uid, "revoked_at": {"$exists": False}},
        {"$set": {"revoked_at": datetime.now(timezone.utc),
                  "revocation_reason": "user_revoked_all"}},
    )
    _clear_session_cookie(response)
    return {"ok": True}


@api.post("/auth/session/refresh")
async def refresh_session(request: Request, response: Response,
                          uid: str = Depends(get_current_user_id)):
    await _rotate_session(request, response, uid)
    return {"ok": True}


@api.post("/auth/reauth")
async def reauthenticate(req: ReauthenticationRequest, request: Request,
                         response: Response,
                         uid: str = Depends(get_current_user_id)):
    user = await get_user(uid)
    if not verify_password(req.current_password, user.get("password_hash", "")):
        raise HTTPException(401, "Mot de passe actuel incorrect")
    if _is_admin_account(user) and user.get("two_fa_enabled") and not await _verify_user_totp(
            user, req.otp or ""):
        raise HTTPException(401, "Code 2FA invalide")
    session_id = getattr(request.state, "session_id", None)
    await db.sessions.update_one(
        {"id": session_id, "user_id": uid, "revoked_at": {"$exists": False}},
        {"$set": {"last_auth_at": datetime.now(timezone.utc)}},
    )
    await _rotate_session(request, response, uid)
    return {"ok": True, "expires_in": REAUTH_MAX_AGE_SECONDS}


@api.post("/auth/2fa/setup")
async def setup_two_factor(uid: str = Depends(get_current_user_id)):
    user = await get_user(uid)
    if not _is_admin_account(user):
        raise HTTPException(
            403, "La double authentification est réservée aux administrateurs"
        )
    if user.get("two_fa_enabled"):
        raise HTTPException(409, "La double authentification est déjà activée")
    return await _begin_mfa_enrollment(user)


async def _optional_user_id(
    request: Request,
    creds=Depends(auth_security.bearer),
) -> Optional[str]:
    if not request.cookies.get(SESSION_COOKIE_NAME) and not creds:
        return None
    try:
        return await get_current_user_id(request, creds)
    except HTTPException:
        return None


@api.post("/auth/2fa/confirm")
async def confirm_two_factor(req: TwoFactorCodeRequest,
                             uid: Optional[str] = Depends(_optional_user_id)):
    enrollment_id = None
    user_id = uid
    if req.setup_token:
        payload = auth_security.decode_mfa_token(req.setup_token, "mfa_setup")
        user_id = payload["sub"]
        enrollment_id = payload.get("enrollment_id")
    if not user_id:
        raise HTTPException(401, "Authentification requise")
    user = await get_user(user_id)
    if not _is_admin_account(user):
        raise HTTPException(
            403, "La double authentification est réservée aux administrateurs"
        )
    enrollment = await db.mfa_enrollments.find_one({
        "id": enrollment_id if enrollment_id else {"$exists": True},
        "user_id": user_id, "used": False,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    }, {"_id": 0})
    if not enrollment:
        raise HTTPException(400, "Session de configuration 2FA expirée")
    try:
        secret = auth_security.decrypt_mfa_secret(enrollment["secret_encrypted"])
    except Exception:
        raise HTTPException(500, "Configuration 2FA indisponible")
    counter = auth_security.verify_totp(secret, req.code)
    if counter is None:
        raise HTTPException(401, "Code 2FA invalide")
    recovery_codes = [
        f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(8)]
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "two_fa_enabled": True,
            "two_fa_secret_encrypted": enrollment["secret_encrypted"],
            "two_fa_last_counter": counter,
            "recovery_codes": [
                {"id": new_id(), "hash": hash_password(code), "used": False}
                for code in recovery_codes
            ],
        }},
    )
    await db.mfa_enrollments.update_one(
        {"id": enrollment["id"], "used": False},
        {"$set": {"used": True, "used_at": now_iso()}},
    )
    return {"enabled": True, "recovery_codes": recovery_codes}


@api.post("/auth/2fa/disable")
async def disable_two_factor(req: TwoFactorDisableRequest,
                             uid: str = Depends(get_current_user_id)):
    user = await get_user(uid)
    if _is_admin_account(user):
        raise HTTPException(403, "La 2FA est obligatoire pour les administrateurs")
    if not verify_password(req.current_password, user.get("password_hash", "")):
        raise HTTPException(401, "Mot de passe actuel incorrect")
    if not await _verify_user_totp(user, req.code):
        raise HTTPException(401, "Code 2FA invalide")
    await db.users.update_one(
        {"id": uid},
        {"$set": {"two_fa_enabled": False},
         "$unset": {"two_fa_secret_encrypted": "", "two_fa_last_counter": "",
                    "recovery_codes": ""}},
    )
    return {"enabled": False}


@api.post("/auth/recover")
async def recover_account(req: PasswordRecoveryRequest, request: Request):
    await _require_turnstile(req.turnstile_token, request, "recover")
    identifier = req.identifier.lower().strip()
    await _check_login_security(identifier, request, None, None)
    errors = auth_security.password_policy_errors(req.new_password)
    if errors:
        raise HTTPException(422, "Mot de passe insuffisant : " + ", ".join(errors))
    user = await db.users.find_one(
        {"$or": [{"email": identifier}, {"username": identifier}]}, {"_id": 0})
    if not user:
        await _record_login_failure(identifier, request)
        raise HTTPException(401, "Informations de récupération invalides")
    matched = None
    for item in user.get("recovery_codes") or []:
        if not item.get("used") and verify_password(req.recovery_code, item.get("hash", "")):
            matched = item
            break
    if not matched:
        await _record_login_failure(identifier, request)
        raise HTTPException(401, "Informations de récupération invalides")
    claimed = await db.users.update_one(
        {"id": user["id"],
         "recovery_codes": {"$elemMatch": {"id": matched["id"], "used": False}}},
        {"$set": {"recovery_codes.$.used": True,
                  "password_hash": hash_password(req.new_password),
                  "password_policy_version": 1}},
    )
    if claimed.modified_count != 1:
        raise HTTPException(401, "Informations de récupération invalides")
    await _clear_login_account_failures(identifier)
    return {"ok": True, "message": "Mot de passe réinitialisé. Connectez-vous de nouveau."}


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
    "social_channels": {
        "facebook": {"url": "", "active": False},
        "tiktok": {"url": "", "active": False},
        "instagram": {"url": "", "active": False},
        "whatsapp": {"url": "", "active": False},
    },
    "community_enabled": False,
    "community_url": "",
    "community_label": "Rejoindre la communauté",
    "faqs": [
        {
            "id": "verify-account",
            "question": "Comment vérifier mon compte ?",
            "answer": "Rendez-vous sur la page Vérification KYC et téléversez vos documents.",
            "active": True,
        },
        {
            "id": "fees",
            "question": "Quels sont les frais ?",
            "answer": "Les frais applicables sont affichés dans le parcours de chaque opération et sont configurés par l'administrateur.",
            "active": True,
        },
        {
            "id": "api-access",
            "question": "Quand puis-je utiliser l'API ?",
            "answer": "L'accès à l'API est disponible pour les comptes marchands éligibles après les vérifications requises.",
            "active": True,
        },
        {
            "id": "minimum-deposit",
            "question": "Quel est le montant minimum de dépôt ?",
            "answer": "Le montant minimum dépend du pays, de l'opérateur et des limites configurées dans la plateforme.",
            "active": True,
        },
        {
            "id": "payment-link",
            "question": "Comment créer un lien de paiement ?",
            "answer": "Ouvrez Dashboard → Liens de paiement → Créer un lien de paiement, puis renseignez les informations demandées.",
            "active": True,
        },
    ],
}

SOCIAL_CHANNEL_KEYS = ("facebook", "tiktok", "instagram", "whatsapp")


def normalize_social_channels(value: Optional[dict]) -> dict:
    """Keep admin-configured social links safe and predictable for clients."""
    source = value if isinstance(value, dict) else {}
    normalized = {}
    for key in SOCIAL_CHANNEL_KEYS:
        channel = source.get(key) if isinstance(source.get(key), dict) else {}
        url = str(channel.get("url") or "").strip()
        if url:
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise HTTPException(422, f"Le lien {key} doit être une URL HTTP ou HTTPS valide")
            url = url[:500]
        normalized[key] = {
            "url": url,
            "active": bool(channel.get("active", False)),
        }
    return normalized


DEFAULT_APP_FEATURES = {
    "id": "app_features",
    # Legacy top-level toggles kept for backwards compat with the old
    # "Mobile Money vs Crypto" UI. New granular per-currency toggles below
    # take precedence when set.
    "mobile_money_enabled": True,
    "crypto_enabled": True,
    "mobile_money_coming_soon_message": "Bientôt disponible — cette fonctionnalité est en cours de finalisation.",
    "crypto_coming_soon_message": "Bientôt disponible — cette fonctionnalité est en cours de finalisation.",
    # Per-currency wallet visibility.
    "wallet_xof_enabled": True,
    "wallet_xaf_enabled": True,
    "wallet_crypto_enabled": True,
    # Per-currency deposit / withdrawal switches.
    "deposit_xof_enabled": True,
    "deposit_xaf_enabled": True,
    "deposit_crypto_enabled": True,
    "withdrawal_xof_enabled": True,
    "withdrawal_xaf_enabled": True,
    "withdrawal_crypto_enabled": True,
    # Advanced modules — hide entire sections when off (sidebar entry + page).
    "api_enabled": True,
    "links_enabled": True,
}


async def get_app_features() -> dict:
    doc = await db.settings.find_one({"id": "app_features"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_APP_FEATURES.copy())
        doc = await db.settings.find_one({"id": "app_features"}, {"_id": 0})
    # Ensure keys exist (backwards compat).
    for k, v in DEFAULT_APP_FEATURES.items():
        doc.setdefault(k, v)
    return doc


async def get_support_config() -> dict:
    doc = await db.settings.find_one({"id": "support_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_SUPPORT_CONFIG.copy())
        doc = await db.settings.find_one({"id": "support_config"}, {"_id": 0})
    for key, value in DEFAULT_SUPPORT_CONFIG.items():
        doc.setdefault(key, copy.deepcopy(value))
    return doc


@api.get("/support/config")
async def support_config(uid: str = Depends(get_current_user_id)):
    cfg = await get_support_config()
    return {
        "telegram_url": cfg.get("telegram_url", ""),
        "whatsapp_url": cfg.get("whatsapp_url", ""),
        "email": cfg.get("email", ""),
        "social_channels": [
            {
                "key": key,
                "url": channel.get("url", ""),
            }
            for key, channel in normalize_social_channels(cfg.get("social_channels")).items()
            if channel.get("active") and channel.get("url")
        ],
        "faqs": [
            faq for faq in (cfg.get("faqs") or [])
            if faq.get("active", True) and faq.get("question") and faq.get("answer")
        ],
    }


class SupportAttachment(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    type: Literal["image/jpeg", "image/png", "image/webp", "application/pdf"]
    data: str = Field(..., min_length=1, max_length=4_200_000)


class ChatMessage(BaseModel):
    text: Optional[str] = Field("", max_length=5000)
    attachments: List[SupportAttachment] = Field(default_factory=list, max_length=5)


def _validate_support_attachments(
    attachments: list[SupportAttachment],
) -> list[dict]:
    clean = []
    for attachment in attachments:
        if attachment.type.startswith("image/"):
            safe_data = _validate_raster_image(attachment.data, "Pièce jointe")
        else:
            match = re.fullmatch(
                r"data:application/pdf;base64,([A-Za-z0-9+/]+={0,2})",
                attachment.data.strip(),
                re.IGNORECASE,
            )
            if not match:
                raise HTTPException(
                    422, "Les pièces jointes PDF doivent être des données PDF valides"
                )
            try:
                raw = base64.b64decode(match.group(1), validate=True)
            except (ValueError, TypeError):
                raise HTTPException(422, "Pièce jointe PDF invalide")
            if len(raw) > 2_500_000 or not raw.startswith(b"%PDF-"):
                raise HTTPException(422, "Pièce jointe PDF invalide ou trop volumineuse")
            safe_data = f"data:application/pdf;base64,{match.group(1)}"
        clean.append({
            "name": Path(attachment.name).name[:160],
            "type": attachment.type,
            "data": safe_data,
        })
    return clean


def _sanitize_stored_attachments(attachments) -> list[dict]:
    """Drop legacy or tampered attachments before rendering them in a browser."""
    clean = []
    for raw in attachments or []:
        try:
            attachment = SupportAttachment.model_validate(raw)
            clean.extend(_validate_support_attachments([attachment]))
        except (HTTPException, ValueError, TypeError):
            continue
    return clean


@api.get("/support/messages")
async def user_get_messages(uid: str = Depends(get_current_user_id)):
    msgs = await db.support_messages.find({"conversation_id": uid}, {"_id": 0}).sort("created_at", 1).to_list(500)
    for msg in msgs:
        msg["attachments"] = _sanitize_stored_attachments(msg.get("attachments"))
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
        "attachments": _validate_support_attachments(msg.attachments),
        "created_at": now_iso(),
        "read_by_user": True,
        "read_by_admin": False,
        "status": "sent",
    }
    await db.support_messages.insert_one(doc)
    doc.pop("_id", None)
    return doc


# ==================== DEPOSIT CONFIG (Mobile Money) ====================
# Same structure as transfer_config.mobile_money.operators, but scoped to
# deposits. Editable end-to-end from the Admin Panel. Applied uniformly on:
#   - direct deposits (/api/deposits/mobile-money)
#   - link payments (public checkout)
#   - merchant API payments (POST /v1/payments — mobile money mode)
DEFAULT_DEPOSIT_CONFIG = {
    "id": "deposit_config",
    "mobile_money": {
        "enabled": True,
        "operators": [
            # Bénin
            {"country": "BJ", "code": "mtn_bj", "name": "MTN Bénin", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "BJ", "code": "moov_bj", "name": "Moov Bénin", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "BJ", "code": "celtiis_bj", "name": "Celtiis Bénin", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Côte d'Ivoire
            {"country": "CI", "code": "mtn_ci", "name": "MTN Côte d'Ivoire", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Togo
            {"country": "TG", "code": "moov_tg", "name": "Moov Togo", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "TG", "code": "togocel_tg", "name": "TogoCom (T-Money)", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Sénégal
            {"country": "SN", "code": "orange_sn", "name": "Orange Sénégal", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Mali
            {"country": "ML", "code": "airtel_ml", "name": "Airtel Mali", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Niger
            {"country": "NE", "code": "airtel_ne", "name": "Airtel Niger", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "NE", "code": "wave_ne", "name": "Wave Niger", "currency": "XOF", "fee_pct": 1.0, "min": 100, "max": 1000000, "active": True},
            {"country": "NE", "code": "orange_ne", "name": "Orange Niger", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Burkina Faso
            {"country": "BF", "code": "moov_bf", "name": "Moov Burkina Faso", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            {"country": "BF", "code": "yas_bf", "name": "Mixx by Yas Burkina", "currency": "XOF", "fee_pct": 1.5, "min": 100, "max": 500000, "active": True},
            # Guinée
            {"country": "GN", "code": "mtn_gn", "name": "MTN Guinée", "currency": "GNF", "fee_pct": 1.5, "min": 1000, "max": 5000000, "active": True},
            {"country": "GN", "code": "moov_gn", "name": "Moov Guinée", "currency": "GNF", "fee_pct": 1.5, "min": 1000, "max": 5000000, "active": True},
            {"country": "GN", "code": "wave_gn", "name": "Wave Guinée", "currency": "GNF", "fee_pct": 1.0, "min": 1000, "max": 10000000, "active": True},
            {"country": "GN", "code": "orange_gn", "name": "Orange Guinée", "currency": "GNF", "fee_pct": 1.5, "min": 1000, "max": 5000000, "active": True},
        ],
    },
    "crypto": {
        "enabled": True,
        # Deposit-side crypto fees. Same structure as transfer_config.crypto.fees
        # (map coin → total percent) plus optional split into gateway + platform.
        # Falls back to transfer_config.crypto.fees when a coin is missing here
        # (retro-compat with pre-split installs).
        "fees": {},
        "fees_gateway": {},
        "fees_platform": {},
        # Coins hidden from the deposit surface (Deposit form, /crypto/assets,
        # merchant API create-payment path). Managed via the trash icon in
        # /admin/deposit-config.
        "hidden_coins": [],
    },
}


async def get_deposit_config() -> dict:
    doc = await db.settings.find_one({"id": "deposit_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_DEPOSIT_CONFIG.copy())
        doc = await db.settings.find_one({"id": "deposit_config"}, {"_id": 0})
    return doc


PAYDUNYA_WALLET_CURRENCIES = {"XOF", "XAF"}

PAYDUNYA_DEFAULT_CONFIG = {
    "id": "payment_provider_paydunya",
    "enabled": True,
    "mode": "test",
    "store_name": "Biz-transPay",
    # Each pay-in path is independently switchable.  Do not infer one mode
    # from another: this is also enforced by every create endpoint below.
    "modes": paydunya.default_modes(),
        "catalog": paydunya.default_catalog(),
}


async def get_paydunya_config(decrypt: bool = False) -> dict:
    doc = await db.settings.find_one({"id": "payment_provider_paydunya"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(PAYDUNYA_DEFAULT_CONFIG.copy())
        doc = await db.settings.find_one({"id": "payment_provider_paydunya"}, {"_id": 0})
    if decrypt:
        doc = dict(doc)
        # Credential decryption is part of an actual provider operation.  Do
        # not turn a missing/rotated SESSION_SECRET into an empty credential
        # set and then accidentally issue a different, misleading error.
        decrypted = paydunya.credentials(
            doc, os.environ.get("SESSION_SECRET", ""))
        env_credentials = {
            "master_key": os.environ.get("PAYDUNYA_MASTER_KEY"),
            "public_key": os.environ.get("PAYDUNYA_PUBLIC_KEY"),
            "private_key": os.environ.get("PAYDUNYA_PRIVATE_KEY"),
            "token": os.environ.get("PAYDUNYA_TOKEN"),
        }
        doc["_credentials"] = {
            key: decrypted.get(key) or env_credentials.get(key)
            for key in env_credentials
            if decrypted.get(key) or env_credentials.get(key)
        }
        doc["_sandbox_customer"] = {
            "email": os.environ.get("PAYDUNYA_TEST_CUSTOMER_EMAIL"),
            "phone": os.environ.get("PAYDUNYA_TEST_CUSTOMER_PHONE"),
            "password": os.environ.get("PAYDUNYA_TEST_CUSTOMER_PASSWORD"),
        }
    return doc


MBIYO_DEFAULT_CONFIG = mbiyo.default_config()


async def get_mbiyo_config(decrypt: bool = False) -> dict:
    doc = await db.settings.find_one({"id": "payment_provider_mbiyo"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(copy.deepcopy(MBIYO_DEFAULT_CONFIG))
        doc = await db.settings.find_one({"id": "payment_provider_mbiyo"}, {"_id": 0})
    elif int(doc.get("setup_version", 0) or 0) < 3:
        # Add newly documented routes without replacing existing operator
        # settings, fees, or administrator activation choices.
        catalog = copy.deepcopy(doc.get("catalog") or [])
        existing_ids = {str(op.get("id") or "") for op in catalog}
        existing_codes = {str(op.get("code") or "") for op in catalog}
        for op in mbiyo.default_catalog():
            if (str(op["id"]) not in existing_ids
                    and str(op["code"]) not in existing_codes):
                catalog.append(op)
        await db.settings.update_one(
            {"id": "payment_provider_mbiyo"},
             {"$set": {"catalog": catalog, "setup_version": 3}})
        doc = await db.settings.find_one({"id": "payment_provider_mbiyo"}, {"_id": 0})
    if decrypt:
        doc = dict(doc)
        decrypted = {}
        for key in ("public_key", "secret_key", "webhook_secret"):
            encrypted = doc.get(f"{key}_encrypted")
            if not encrypted:
                continue
            try:
                decrypted[key] = mbiyo.decrypt_secret(
                    encrypted, os.environ.get("SESSION_SECRET", ""))
            except Exception as exc:
                logger.warning("Mbiyo %s decryption failed: %s", key, exc)
        # api_key_encrypted/MBIYO_API_KEY are retained as a compatibility
        # bridge for settings saved by the first integration draft.
        legacy_api_key = ""
        if doc.get("api_key_encrypted"):
            try:
                legacy_api_key = mbiyo.decrypt_secret(
                    doc["api_key_encrypted"], os.environ.get("SESSION_SECRET", ""))
            except Exception:
                pass
        doc["_public_key"] = decrypted.get("public_key") or os.environ.get("MBIYO_PUBLIC_KEY", "")
        doc["_secret_key"] = (decrypted.get("secret_key") or legacy_api_key
                              or os.environ.get("MBIYO_SECRET_KEY")
                              or os.environ.get("MBIYO_API_KEY", ""))
        doc["_api_key"] = doc["_secret_key"]
        doc["_webhook_secret"] = (decrypted.get("webhook_secret")
                                  or os.environ.get("MBIYO_WEBHOOK_SECRET", ""))
    return doc


def _customer_fee_components(op: dict) -> tuple[float, float, float, float]:
    """Normalize split and legacy provider fees for customer-facing previews."""
    gateway_pct = float(op.get("gateway_fee_pct", 0) or 0)
    platform_pct = float(op.get("platform_fee_pct", 0) or 0)
    if gateway_pct == 0 and platform_pct == 0 and op.get("fee_pct") is not None:
        gateway_pct = float(op.get("fee_pct", 0) or 0)
    gateway_fixed = float(op.get("gateway_fee_fixed", 0) or 0)
    platform_fixed = float(op.get("platform_fee_fixed", 0) or 0)
    if gateway_fixed == 0 and platform_fixed == 0 and op.get("fee_fixed") is not None:
        gateway_fixed = float(op.get("fee_fixed", 0) or 0)
    return gateway_pct, gateway_fixed, platform_pct, platform_fixed


def _customer_fee_rates(op: dict) -> tuple[float, float]:
    gateway_pct, gateway_fixed, platform_pct, platform_fixed = (
        _customer_fee_components(op)
    )
    return gateway_pct + platform_pct, gateway_fixed + platform_fixed


def _mbiyo_public_config(cfg: dict, admin: bool = False) -> dict:
    secret_configured = bool(
        cfg.get("secret_key_encrypted") or cfg.get("api_key_encrypted")
        or os.environ.get("MBIYO_SECRET_KEY") or os.environ.get("MBIYO_API_KEY"))
    result = {
        "enabled": bool(cfg.get("enabled", False)),
        "mode": cfg.get("mode", "test"),
        "configured": secret_configured,
    }
    if admin:
        result["public_key_configured"] = bool(
            cfg.get("public_key_encrypted") or os.environ.get("MBIYO_PUBLIC_KEY"))
        result["secret_key_configured"] = secret_configured
        result["webhook_secret_configured"] = bool(
            cfg.get("webhook_secret_encrypted") or os.environ.get("MBIYO_WEBHOOK_SECRET"))
        result["catalog"] = cfg.get("catalog") or mbiyo.default_catalog()
    else:
        active_catalog = (cfg.get("catalog") or []) if (
            result["enabled"] and result["configured"]) else []
        result["catalog"] = [{
            **{k: op.get(k) for k in ("country", "country_label",
                                      "network", "name", "currency", "min", "max")},
            "code": str(op.get("code") or "").removeprefix("mbiyo_"),
            "fee_pct": _customer_fee_rates(op)[0],
            "fee_fixed": _customer_fee_rates(op)[1],
            "gateway_fee_pct": _customer_fee_components(op)[0],
            "gateway_fee_fixed": _customer_fee_components(op)[1],
            "platform_fee_pct": _customer_fee_components(op)[2],
            "platform_fee_fixed": _customer_fee_components(op)[3],
            "amount_increment": 5 if str(op.get("country") or "").upper()
                in mbiyo.ROUNDING_COUNTRIES else 0,
            "payment_flow": mbiyo.payment_flow(op),
        } for op in active_catalog
          if op.get("active", True) and not op.get("archived", False)
          and not op.get("hidden", False)]
        result["mobile_money_enabled"] = bool(result["enabled"] and result["configured"]
                                               and result["catalog"])
    return result


def _paydunya_credentials_configured(cfg: dict) -> bool:
    return bool(
        (cfg.get("master_key_encrypted") or os.environ.get("PAYDUNYA_MASTER_KEY"))
        and (cfg.get("private_key_encrypted") or os.environ.get("PAYDUNYA_PRIVATE_KEY"))
        and (cfg.get("token_encrypted") or os.environ.get("PAYDUNYA_TOKEN"))
    )


def _paydunya_public_config(cfg: dict, admin: bool = False) -> dict:
    configured = _paydunya_credentials_configured(cfg)
    modes = cfg.get("modes")
    if not isinstance(modes, dict):
        # Legacy settings only implemented direct SoftPay.  Do not advertise
        # newly added client/redirect flows until an administrator enables
        # them explicitly.
        modes = {"softpay_direct": {"enabled": True},
                 "psr": {"enabled": False},
                 "par_redirect": {"enabled": False}}
    public_modes = {}
    for mode in paydunya.PAY_IN_MODES:
        raw = modes.get(mode, {})
        enabled = bool(raw.get("enabled", False)) if isinstance(raw, dict) else bool(raw)
        public_modes[mode] = {
            "enabled": enabled,
            "available": bool(cfg.get("enabled", False) and configured and enabled),
        }
    result = {
        "enabled": bool(cfg.get("enabled", False)),
    }
    if admin:
        result.update({
            "mode": cfg.get("mode", "test"),
            "store_name": cfg.get("store_name") or "Biz-transPay",
            "configured": configured,
            "modes": public_modes,
            "mode_availability": {name: value["available"]
                                  for name, value in public_modes.items()},
        })
        for key in ("master_key", "public_key", "private_key", "token"):
            encrypted = cfg.get(f"{key}_encrypted")
            result[f"{key}_configured"] = bool(
                encrypted or os.environ.get(f"PAYDUNYA_{key.upper()}"))
        result["catalog"] = [
            op for op in (cfg.get("catalog") or [])
            if str(op.get("currency") or "").upper() in PAYDUNYA_WALLET_CURRENCIES
        ]
    else:
        result["catalog"] = [
            {
                "country": op.get("country"),
                "country_label": op.get("country_label")
                    or paydunya.COUNTRY_LABELS.get(op.get("country"), op.get("country")),
                "code": op.get("code"),
                "name": op.get("name") or op.get("code"),
                "currency": op.get("currency") or "XOF",
                "min": float(op.get("min", 100)),
                "max": float(op.get("max", 0)) or None,
                # One customer-facing fee preview; gateway/platform split is
                # intentionally kept out of the public response.
                "fee_pct": _customer_fee_rates(op)[0],
                "fee_fixed": _customer_fee_rates(op)[1],
                "gateway_fee_pct": _customer_fee_components(op)[0],
                "gateway_fee_fixed": _customer_fee_components(op)[1],
                "platform_fee_pct": _customer_fee_components(op)[2],
                "platform_fee_fixed": _customer_fee_components(op)[3],
                "amount_increment": 0,
                "payment_flow": paydunya.payment_flow(op),
            }
            for op in (cfg.get("catalog") or [])
            if op.get("active", True) and not op.get("archived", False)
            and not op.get("hidden", False)
            and str(op.get("currency") or "").upper() in PAYDUNYA_WALLET_CURRENCIES
        ]
        result["mobile_money_enabled"] = (
            any(item["available"] for item in public_modes.values())
            and bool(result["catalog"])
        )
        if not result["mobile_money_enabled"]:
            result["catalog"] = []
    return result


def _find_deposit_operator(cfg: dict, country: str, code: str) -> Optional[dict]:
    """Locate the per-operator config entry. Case-insensitive on the code."""
    mm = (cfg.get("mobile_money") or {})
    if not mm.get("enabled"):
        return None
    country_up = (country or "").upper()
    code_lo = (code or "").lower()
    for op in mm.get("operators", []):
        if op.get("country", "").upper() == country_up and op.get("code", "").lower() == code_lo:
            return op if (op.get("active", True)
                          and not op.get("archived", False)
                          and not op.get("hidden", False)) else None
    return None


def _active_operator(catalog: list[dict], country: str, code: str) -> Optional[dict]:
    country_up = str(country or "").upper()
    code_lo = str(code or "").lower()
    return next((
        op for op in catalog
        if str(op.get("country") or "").upper() == country_up
        and str(op.get("code") or "").lower() == code_lo
        and op.get("active", True)
        and not op.get("archived", False)
        and not op.get("hidden", False)
    ), None)


def _active_mbiyo_operator(
    catalog: list[dict], country: str, code: str
) -> Optional[dict]:
    """Resolve a provider-neutral public route code to its internal row."""
    country_up = str(country or "").upper()
    code_lo = str(code or "").lower()
    return next((
        op for op in catalog
        if str(op.get("country") or "").upper() == country_up
        and (
            str(op.get("code") or "").lower() == code_lo
            or str(op.get("code") or "").lower().removeprefix("mbiyo_") == code_lo
        )
        and op.get("active", True)
        and not op.get("archived", False)
        and not op.get("hidden", False)
    ), None)


async def _resolve_deposit_provider(country: str, code: str,
                                    currency: Optional[str] = None) -> str:
    paydunya_cfg = await get_paydunya_config()
    mbiyo_cfg = await get_mbiyo_config()
    paydunya_route = (
        _active_operator(paydunya_cfg.get("catalog") or [], country, code)
        if paydunya_cfg.get("enabled") else None
    )
    paydunya_match = (
        paydunya_route
        if _paydunya_credentials_configured(paydunya_cfg) else None
    )
    mbiyo_match = (
        _active_mbiyo_operator(mbiyo_cfg.get("catalog") or [], country, code)
        if mbiyo_cfg.get("enabled")
        and bool(mbiyo_cfg.get("secret_key_encrypted")
                 or mbiyo_cfg.get("api_key_encrypted")
                 or os.environ.get("MBIYO_SECRET_KEY")
                 or os.environ.get("MBIYO_API_KEY")) else None
    )
    if currency:
        wanted = currency.upper()
        paydunya_route = paydunya_route if paydunya_route and str(
            paydunya_route.get("currency", "")).upper() == wanted else None
        paydunya_match = paydunya_match if paydunya_match and str(
            paydunya_match.get("currency", "")).upper() == wanted else None
        mbiyo_match = mbiyo_match if mbiyo_match and str(
            mbiyo_match.get("currency", "")).upper() == wanted else None
    if paydunya_match and mbiyo_match:
        # The public catalogue de-duplicates equivalent routes in this same
        # order, so resolution must keep the first configured route as well.
        return "paydunya"
    if mbiyo_match:
        return "mbiyo"
    if paydunya_match:
        return "paydunya"
    if paydunya_route:
        raise HTTPException(
            503,
            "PayDunya est activé pour cet opérateur mais ses identifiants "
            "ne sont pas configurés.",
        )
    raise HTTPException(400, "Opérateur Mobile Money non disponible pour ce pays")


# ==================== TRANSFER CONFIG ====================
DEFAULT_TRANSFER_CONFIG = {
    "id": "transfer_config",
    "mobile_money": {
        "enabled": True,
        "operators": paydunya.default_withdrawal_catalog(),
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


_LEGACY_WITHDRAW_MODES = {
    ("TG", "tmoney"): "t-money-togo",
    ("TG", "flooz"): "moov-togo",
    ("SN", "orange"): "orange-money-senegal",
    ("SN", "free"): "free-money-senegal",
    ("SN", "wave"): "wave-senegal",
    ("CI", "orange"): "orange-money-ci",
    ("CI", "mtn"): "mtn-ci",
    ("CI", "moov"): "moov-ci",
    ("CI", "wave"): "wave-ci",
    ("ML", "orange"): "orange-money-mali",
    ("BF", "orange"): "orange-money-burkina",
    ("BF", "moov"): "moov-burkina-faso",
    ("CM", "mtn"): "mtn-cameroun",
    ("BJ", "mtn"): "mtn-benin",
    ("BJ", "moov"): "moov-benin",
    ("BJ", "celtiis"): "celtiis-cash",
}


def _merged_mobile_money(defaults: dict, current: dict) -> dict:
    """Merge the payout catalogue without replacing administrator choices.

    Existing entries are keyed by country+code and win over defaults.  Legacy
    entries are enriched only with non-destructive display/provider fields so
    old transfer configurations remain usable after the payout migration.
    """
    out = copy.deepcopy(current or {})
    base = copy.deepcopy(defaults.get("mobile_money") or {})
    for key, value in base.items():
        if key != "operators" and key not in out:
            out[key] = value
    had_operators = "operators" in out
    existing = list(out.get("operators") or [])
    for item in existing:
        country = str(item.get("country") or "").upper()
        code = str(item.get("code") or "").lower()
        item.setdefault("country", country)
        item.setdefault("country_label", paydunya.COUNTRY_LABELS.get(country, country))
        item.setdefault("currency", "XAF" if country == "CM" else "XOF")
        item.setdefault("archived", False)
        item.setdefault("hidden", False)
        if not item.get("withdraw_mode"):
            mode = _LEGACY_WITHDRAW_MODES.get((country, code))
            if mode:
                item["withdraw_mode"] = mode
            else:
                # Historical rows not supported by PayDunya PUSH must never
                # remain selectable as an automatic withdrawal route.
                item["active"] = False
                item["archived"] = True
        if item.get("currency") == "XAF":
            # PUSH v2 currently documents amount as XOF only.
            item["active"] = False
    by_key = {(str(item.get("country") or "").upper(),
               str(item.get("code") or "").lower()) for item in existing}
    by_mode = {str(item.get("withdraw_mode") or "").lower()
               for item in existing if item.get("withdraw_mode")}
    # An explicitly empty catalogue is an administrator choice (for example
    # a temporary global shutdown), not an invitation to repopulate defaults.
    if not had_operators:
        existing.extend(copy.deepcopy(paydunya.default_withdrawal_catalog()))
    else:
        for item in paydunya.default_withdrawal_catalog():
            key = (item["country"], item["code"].lower())
            if key not in by_key and item["withdraw_mode"].lower() not in by_mode:
                existing.append(copy.deepcopy(item))
    out["operators"] = existing
    return out


async def get_transfer_config() -> dict:
    doc = await db.settings.find_one({"id": "transfer_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(copy.deepcopy(DEFAULT_TRANSFER_CONFIG))
        doc = await db.settings.find_one({"id": "transfer_config"}, {"_id": 0})
    # This read-time migration is intentionally not a replacement write.  It
    # preserves admin edits and makes adding a future default non-destructive.
    merged = dict(doc)
    merged["mobile_money"] = _merged_mobile_money(
        DEFAULT_TRANSFER_CONFIG, doc.get("mobile_money") or {})
    paydunya_cfg = await get_paydunya_config()
    merged["paydunya"] = {
        "enabled": bool(paydunya_cfg.get("enabled")
                        and _paydunya_credentials_configured(paydunya_cfg)),
    }
    mb_cfg = await get_mbiyo_config()
    merged["mbiyo"] = {
        "enabled": bool(mb_cfg.get("enabled") and (
            mb_cfg.get("secret_key_encrypted") or mb_cfg.get("api_key_encrypted")
            or os.environ.get("MBIYO_SECRET_KEY") or os.environ.get("MBIYO_API_KEY"))),
        "operators": copy.deepcopy(mb_cfg.get("catalog") or []),
    }
    return merged


def _public_transfer_config(cfg: dict) -> dict:
    result = copy.deepcopy(cfg)
    mm = result.get("mobile_money") or {}
    public_ops = []
    global_enabled = bool(mm.get("enabled", False))
    paydunya_enabled = bool((result.get("paydunya") or {}).get("enabled"))
    paydunya_ops = (mm.get("operators") or []) if (
        global_enabled and paydunya_enabled) else []
    for op in paydunya_ops:
        if not op.get("active", True) or op.get("archived", False) or op.get("hidden", False):
            continue
        if not op.get("withdraw_mode") or str(op.get("currency") or "").upper() != "XOF":
            continue
        fee_pct, fee_fixed = _customer_fee_rates(op)
        public_ops.append({
            "country": op.get("country"),
            "country_label": op.get("country_label")
                or paydunya.COUNTRY_LABELS.get(op.get("country"), op.get("country")),
            "code": op.get("code"),
            "name": op.get("name") or op.get("code"),
            "currency": op.get("currency") or "XOF",
            "min": float(op.get("min", 0) or 0),
            "max": float(op.get("max", 0) or 0) or None,
            "fee_pct": fee_pct,
            "fee_fixed": fee_fixed,
            "active": True,
        })
    result["mobile_money"] = {
        "enabled": False,
        "operators": public_ops,
    }
    # Mbiyo payout routes use the same provider-neutral customer contract.
    mb_cfg = cfg.get("mbiyo") or {}
    # get_transfer_config already reduces this flag to
    # enabled-and-configured without copying credentials publicly.
    if global_enabled and mb_cfg.get("enabled"):
        for op in mb_cfg.get("operators", []):
            if not op.get("active", True) or op.get("archived") or op.get("hidden"):
                continue
            public_ops.append({
                "country": op.get("country"),
                "country_label": op.get("country_label") or mbiyo.COUNTRY_LABELS.get(op.get("country")),
                "code": str(op.get("code") or "").lower().removeprefix("mbiyo_"),
                "name": op.get("name") or op.get("code"),
                "currency": op.get("currency"), "min": float(op.get("min", 0) or 0),
                "max": float(op.get("max", 0) or 0) or None,
                "fee_pct": _customer_fee_rates(op)[0],
                "fee_fixed": _customer_fee_rates(op)[1], "active": True,
            })
    # Keep the first route for each public tuple: this is also the arbitration
    # priority used by payout execution.
    seen = set()
    public_ops = [op for op in public_ops if not (
        (key := (str(op.get("country") or "").upper(),
                 str(op.get("code") or "").lower().removeprefix("mbiyo_"),
                 str(op.get("currency") or "").upper())) in seen
        or seen.add(key)
    )]
    result["mobile_money"]["enabled"] = bool(global_enabled and public_ops)
    result["mobile_money"]["operators"] = public_ops
    result.pop("paydunya", None)
    result.pop("mbiyo", None)
    return result


@api.get("/transfer/config")
async def transfer_config(uid: str = Depends(get_current_user_id)):
    cfg = await get_transfer_config()
    return _public_transfer_config(cfg)


def _public_fee_crypto(crypto: dict) -> dict:
    crypto = crypto or {}
    hidden = {str(code).upper() for code in (crypto.get("hidden_coins") or [])}
    fees = crypto.get("fees") or {}
    gateway = crypto.get("fees_gateway") or {}
    platform = crypto.get("fees_platform") or {}
    gateway_fixed = crypto.get("fees_gateway_fixed") or {}
    platform_fixed = crypto.get("fees_platform_fixed") or {}
    codes = {
        str(code).upper()
        for code in set(fees) | set(gateway) | set(platform)
        if str(code).upper() not in hidden
    }
    assets = []
    for code in sorted(codes):
        gateway_pct = float(gateway.get(code, fees.get(code, 0)) or 0)
        platform_pct = float(platform.get(code, 0) or 0)
        fixed = float(gateway_fixed.get(code, 0) or 0) + float(platform_fixed.get(code, 0) or 0)
        assets.append({
            "code": code,
            "fee_pct": gateway_pct + platform_pct,
            "fee_fixed": fixed,
        })
    return {
        "enabled": bool(crypto.get("enabled", False)),
        "assets": assets,
    }


def _public_fee_mobile_money(mobile_money: dict, withdrawal: bool = False) -> dict:
    mobile_money = mobile_money or {}
    operators = []
    for op in mobile_money.get("operators") or []:
        if not op.get("active", True) or op.get("archived", False) or op.get("hidden", False):
            continue
        if withdrawal and (
            not op.get("withdraw_mode")
            or str(op.get("currency") or "").upper() != "XOF"
        ):
            continue
        gateway_pct = float(op.get("gateway_fee_pct", 0) or 0)
        platform_pct = float(op.get("platform_fee_pct", 0) or 0)
        if gateway_pct == 0 and platform_pct == 0:
            gateway_pct = float(op.get("fee_pct", 0) or 0)
        operators.append({
            "country": op.get("country"),
            "country_label": op.get("country_label")
                or paydunya.COUNTRY_LABELS.get(op.get("country"), op.get("country")),
            "name": op.get("name") or op.get("code"),
            "currency": op.get("currency") or "XOF",
            "fee_pct": gateway_pct + platform_pct,
            "fee_fixed": float(op.get("gateway_fee_fixed", 0) or 0)
                + float(op.get("platform_fee_fixed", 0) or 0),
            "min": float(op.get("min", 0) or 0),
            "max": float(op.get("max", 0) or 0) or None,
        })
    return {
        "enabled": bool(mobile_money.get("enabled", False)),
        "operators": operators,
    }


def _public_fee_provider_mobile_money(
    catalog: list[dict]
) -> dict:
    """Normalize an active provider catalog for the customer fee grid."""
    operators = []
    for op in catalog or []:
        operators.append({
            "country": op.get("country"),
            "country_label": op.get("country_label")
                or paydunya.COUNTRY_LABELS.get(op.get("country"), op.get("country")),
            "name": op.get("name") or op.get("code"),
            "currency": op.get("currency") or "XOF",
            "fee_pct": float(op.get("fee_pct", 0) or 0),
            "fee_fixed": float(op.get("fee_fixed", 0) or 0),
            "min": float(op.get("min", 0) or 0),
            "max": float(op.get("max", 0) or 0) or None,
        })
    return {
        "enabled": bool(operators),
        "operators": operators,
    }


@api.get("/fees/config")
async def public_fees_config(uid: str = Depends(get_current_user_id)):
    """Customer-facing fee grid built only from administrator settings."""
    deposit = await get_deposit_config()
    withdrawal = await get_transfer_config()
    paydunya = _paydunya_public_config(await get_paydunya_config())
    mbiyo = _mbiyo_public_config(await get_mbiyo_config())
    platform = await get_platform_config()
    conversion = platform.get("conversion_fee") or {}
    deposit_mobile_money = _public_fee_provider_mobile_money(
        paydunya.get("catalog") or []
    )
    deposit_mobile_money["operators"].extend(
        _public_fee_provider_mobile_money(
            mbiyo.get("catalog") or []
        )["operators"]
    )
    deposit_mobile_money["enabled"] = bool(deposit_mobile_money["operators"])
    return {
        "deposit": {
            "mobile_money": deposit_mobile_money,
            "crypto": _public_fee_crypto(deposit.get("crypto")),
        },
        "withdrawal": {
            "mobile_money": _public_fee_mobile_money(
                withdrawal.get("mobile_money"), withdrawal=True
            ),
            "crypto": _public_fee_crypto(withdrawal.get("crypto")),
        },
        "conversion": {
            "enabled": bool(conversion.get("enabled", False)),
            "type": conversion.get("type", "percent"),
            "value": float(conversion.get("value", 0) or 0),
            "min_fee": conversion.get("min_fee"),
            "max_fee": conversion.get("max_fee"),
        },
    }


# ==================== TRANSFER ====================
@api.post("/transfers")
async def transfer(req: TransferRequest, request: Request,
                   uid: str = Depends(require_recent_auth)):
    # Merchant API requests are authenticated by a scoped secret key and
    # already protected by API rate limits/idempotency. Browser transfers keep
    # the anti-bot challenge unchanged.
    if not getattr(request.state, "merchant_api", False):
        await _require_turnstile(req.turnstile_token, request, "withdrawal")
    u = await get_user(uid)
    if u.get("is_banned") or u.get("is_blocked"):
        raise HTTPException(403, "Compte suspendu")
    if u.get("withdrawals_blocked") and req.transfer_type != "biz_to_biz":
        raise HTTPException(403, "Retraits bloqués pour votre compte")

    mobile_idempotency_key = ""
    mobile_request_fingerprint = ""
    if req.transfer_type == "biz_to_mobile":
        mobile_idempotency_key = str(req.idempotency_key or "").strip()
        if not mobile_idempotency_key or len(mobile_idempotency_key) > 120:
            raise HTTPException(400, "Clé d'idempotence de retrait requise")
        fingerprint_data = {
            "transfer_type": req.transfer_type,
            "recipient": req.recipient,
            "country": (req.country or "").upper(),
            "operator": (req.operator or "").lower(),
            "fee_bearer": req.fee_bearer,
            "amount": req.amount,
            "currency": req.currency,
        }
        mobile_request_fingerprint = hashlib.sha256(
            json.dumps(fingerprint_data, sort_keys=True,
                       separators=(",", ":")).encode()).hexdigest()
        existing_tx = await db.transactions.find_one(
            {"user_id": uid,
             "metadata.idempotency_key": mobile_idempotency_key},
            {"_id": 0})
        if existing_tx:
            meta = existing_tx.get("metadata") or {}
            if meta.get("request_fingerprint") != mobile_request_fingerprint:
                raise HTTPException(
                    409, "Cette clé d'idempotence appartient à un autre retrait")
            if existing_tx.get("status") == "failed":
                raise HTTPException(409, "Cette tentative de retrait a déjà échoué")
            return {
                "transaction": existing_tx,
                "fee": meta.get("fee", 0),
                "total_debit": meta.get(
                    "total_debit", existing_tx.get("amount", 0)),
                "recipient_gets": meta.get(
                    "recipient_gets", existing_tx.get("amount", 0)),
                "operator": meta.get("operator_name", req.operator),
                "idempotent_replay": True,
            }

    # Biz-transfer bank is permanently removed from the platform.
    if req.transfer_type == "biz_to_bank":
        raise HTTPException(410, "Le transfert bancaire n'est plus disponible sur Biz-transPay.")

    field = f"balance_{req.currency.lower()}"
    if u.get(field, 0) < req.amount:
        raise HTTPException(400, "Solde insuffisant")

    # Check global auto-withdrawals lock (all outbound external transfers)
    if req.transfer_type in ("biz_to_mobile", "biz_to_bank", "biz_to_crypto"):
        pcfg = await get_platform_config()
        if pcfg.get("auto_withdrawals_disabled"):
            if req.transfer_type == "biz_to_mobile":
                raise HTTPException(
                    503, "Les retraits automatiques sont temporairement désactivés")
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
        phone_term = req.recipient_phone or needle
        recip = await db.users.find_one({
            "$or": [
                {"username": needle}, {"email": needle},
                {"phone": {"$regex": _literal_regex_term(phone_term, field_name="Téléphone"),
                            "$options": "i"}} if phone_term else {"_none": True},
            ]
        })
        if not recip:
            raise HTTPException(404, "Bénéficiaire Biz-transPay introuvable")
        if recip["id"] == uid:
            raise HTTPException(400, "Impossible de vous transférer à vous-même")

        transfer_operation_id = new_id()
        if not await _debit_wallet_once(
                uid, field, req.amount,
                f"biz-to-biz:{transfer_operation_id}"):
            raise HTTPException(400, "Solde insuffisant")
        await _credit_wallet_once(
            recip["id"], field, req.amount,
            f"biz-to-biz:{transfer_operation_id}")
        await record_tx(recip["id"], "transfer", "in", req.amount, req.currency,
                        counterparty=u["username"], description=req.description,
                        metadata={"transfer_operation_id": transfer_operation_id},
                        operation_id=f"biz-to-biz:{transfer_operation_id}:in")
        tx_out = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                 counterparty=recip["username"], description=req.description,
                                 metadata={"transfer_type": "biz_to_biz", "fee": 0,
                                            "recipient_name": recip.get("full_name"),
                                            "transfer_operation_id": transfer_operation_id},
                                  operation_id=f"biz-to-biz:{transfer_operation_id}:out")
        await notify(
            uid, "transfer_success", "Transfert Biz-transPay confirmé",
            f"Votre transfert de {req.amount:,.0f} {req.currency} vers "
            f"{recip.get('full_name') or recip['username']} est confirmé.",
            data={
                "transaction_id": tx_out.id,
                "status": "completed",
                "amount": req.amount,
                "currency": req.currency,
                "transfer_type": "biz_to_biz",
            },
        )
        return {"transaction": tx_out.model_dump(), "fee": 0,
                "recipient": {"username": recip["username"], "full_name": recip.get("full_name")}}

    # -------- BIZ TO MOBILE --------
    if req.transfer_type == "biz_to_mobile":
        mm_cfg = cfg.get("mobile_money", {})
        if not req.country or not req.operator:
            raise HTTPException(400, "Pays et opérateur requis")
        mb_cfg = await get_mbiyo_config(decrypt=True)
        mb_op = (
            _active_mbiyo_operator(
                mb_cfg.get("catalog") or [], req.country, req.operator)
            if mb_cfg.get("enabled") and mb_cfg.get("_api_key") else None
        )
        if mb_op and str(mb_op.get("currency") or "").upper() != req.currency.upper():
            mb_op = None
        paydunya_op = (
            _active_operator(mm_cfg.get("operators") or [], req.country, req.operator)
            if (cfg.get("paydunya") or {}).get("enabled") else None
        )
        if paydunya_op and (
                str(paydunya_op.get("currency") or "").upper() != req.currency.upper()
                or not paydunya_op.get("withdraw_mode")):
            paydunya_op = None
        if not mm_cfg.get("enabled"):
            raise HTTPException(403, "Fonctionnalité non activée. Bientôt disponible.")
        if mb_op and paydunya_op:
            # Match the public catalogue's deterministic first-provider
            # priority for an identical country/code/currency tuple.
            mb_op = None
        if not mb_op and not paydunya_op:
            raise HTTPException(400, "Opérateur Mobile Money non disponible pour ce pays")

        callback_base = (os.environ.get("OFFICIAL_DOMAIN")
                         or _paydunya_callback_base(request)).rstrip("/")
        callback_host = (urlparse(callback_base).hostname or "").lower()
        if (paydunya_op and (callback_host.endswith(".replit.dev")
                             or callback_host in {"localhost", "127.0.0.1"})):
            raise HTTPException(
                503,
                "Le retrait automatique Mobile Money nécessite l'application "
                "publiée. PayDunya refuse les callbacks de prévisualisation.")

        if mb_op:
            op = mb_op
            if str(op.get("currency")).upper() != req.currency.upper():
                raise HTTPException(400, "La devise ne correspond pas à l'opérateur")
            processed_amount = mbiyo.normalize_amount(req.country, req.amount)
            if processed_amount < float(op.get("min", 0) or 0) or processed_amount > float(op.get("max", 0) or 10**12):
                raise HTTPException(400, "Montant hors des limites autorisées")
            fees = paydunya.calculate_fees(processed_amount, op, req.fee_bearer or "sender")
            provider_payout_amount = mbiyo.normalize_amount(
                req.country, fees["wallet_credit_amount"])
            if fees["fee_bearer"] == "client":
                fees["charged_amount"] = provider_payout_amount + fees["total_fee"]
            else:
                rounded_total_fee = max(0.0, processed_amount - provider_payout_amount)
                gateway_fee = min(float(fees["gateway_fee"]), rounded_total_fee)
                fees.update({
                    "gateway_fee": gateway_fee,
                    "platform_fee": rounded_total_fee - gateway_fee,
                    "total_fee": rounded_total_fee,
                    "charged_amount": processed_amount,
                })
            fees["wallet_credit_amount"] = provider_payout_amount
            if u.get(field, 0) < fees["charged_amount"]:
                raise HTTPException(400, "Solde insuffisant (frais inclus)")
            callback_base = (os.environ.get("OFFICIAL_DOMAIN")
                             or _paydunya_callback_base(request)).rstrip("/")
            tx_out = await record_tx(
                uid, "transfer", "out", processed_amount, req.currency,
                status="pending", counterparty=req.recipient, description=req.description,
                metadata={"transfer_type": "biz_to_mobile", "provider": "mbiyo",
                          "country": req.country.upper(), "operator": req.operator,
                           "network": op.get("network"),
                          "operator_name": op.get("name"), "fee": fees["total_fee"],
                          "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
                          "recipient_gets": fees["wallet_credit_amount"],
                          "total_debit": fees["charged_amount"], "fee_snapshot": fees,
                          "idempotency_key": mobile_idempotency_key,
                          "request_fingerprint": mobile_request_fingerprint,
                           "debit_phase": "pending"})
            await db.transactions.update_one(
                {"id": tx_out.id}, {"$set": {"metadata.order_id": tx_out.id}}
            )
            debited = await db.users.update_one(
                {"id": uid, field: {"$gte": fees["charged_amount"]}},
                {"$inc": {field: -fees["charged_amount"]},
                 "$addToSet": {"withdrawal_debit_ids": tx_out.id}})
            if debited.modified_count != 1:
                await db.transactions.update_one({"id": tx_out.id}, {"$set": {"status": "failed"}})
                raise HTTPException(400, "Solde insuffisant (frais inclus)")
            await db.transactions.update_one({"id": tx_out.id},
                                             {"$set": {"metadata.debit_phase": "applied",
                                                       "metadata.debit_applied": True,
                                                       "metadata.debit_applied_at": now_iso()}})
            try:
                response = await mbiyo.MbiyoClient(
                    mb_cfg["_api_key"], mb_cfg.get("base_url", mbiyo.BASE_URL)).payout(
                    amount=provider_payout_amount, currency=req.currency.upper(),
                    payment_method="mobile_money", order_id=tx_out.id,
                    callback_url=f"{callback_base}/api/webhooks/mbiyo?ref={tx_out.id}",
                    metadata={"network": op.get("network"),
                              "phone_number": req.recipient,
                              "country_code": req.country.upper(),
                              "beneficiary": (req.recipient_name
                                              or u.get("full_name")
                                              or req.recipient)})
                data = response.get("data") if isinstance(response.get("data"), dict) else response
                provider_id = data.get("transaction_id") or data.get("id") or data.get("reference")
                provider_status = mbiyo.status_value(response)
                await db.transactions.update_one(
                    {"id": tx_out.id}, {"$set": {"metadata.mbiyo_transaction_id": provider_id,
                                                "metadata.mbiyo_status": provider_status,
                                                "metadata.next_reconcile_at": now_iso()}})
                if provider_status in mbiyo.SUCCESS_STATUSES:
                    fresh_tx = await db.transactions.find_one({"id": tx_out.id}, {"_id": 0})
                    await _reconcile_mbiyo_withdrawal(fresh_tx)
                elif provider_status in mbiyo.FAILURE_STATUSES:
                    fresh_tx = await db.transactions.find_one({"id": tx_out.id}, {"_id": 0})
                    await _reconcile_mbiyo_withdrawal(fresh_tx)
            except mbiyo.MbiyoError as exc:
                if exc.status < 500:
                    await _refund_mobile_withdrawal(tx_out.id, exc.message)
                await db.transactions.update_one(
                    {"id": tx_out.id},
                    {"$set": {"metadata.error": str(exc)[:240],
                              "metadata.provider_status": exc.status,
                              "metadata.submission_unknown": exc.status >= 500}})
                message_lower = exc.message.lower()
                if "insufficient" in message_lower and "balance" in message_lower:
                    detail = (
                        "Le solde de décaissement pour cet opérateur est "
                        "insuffisant. Votre solde Biz-transPay a été remboursé.")
                else:
                    detail = (
                        ("Le retrait Mobile Money a été refusé. Votre solde "
                         "Biz-transPay a été remboursé." if exc.status < 500 else
                         "Le retrait est en cours de vérification."))
                raise HTTPException(
                    400 if exc.status < 500 else 502, detail)
            except Exception as exc:
                await db.transactions.update_one(
                    {"id": tx_out.id},
                    {"$set": {"metadata.error": str(exc)[:240],
                              "metadata.submission_unknown": True}})
                raise HTTPException(
                    502,
                    "Le retrait est en cours de vérification.")
            return {"transaction": (await db.transactions.find_one({"id": tx_out.id}, {"_id": 0})),
                    "fee": fees["total_fee"], "processed_amount": processed_amount,
                    "total_debit": fees["charged_amount"],
                    "recipient_gets": fees["wallet_credit_amount"], "operator": op.get("name")}
        op = paydunya_op
        if req.currency.upper() not in PAYDUNYA_WALLET_CURRENCIES:
            raise HTTPException(400, "La devise ne correspond pas à l'opérateur")
        # Reject a disabled PayDunya route before recording or debiting the
        # withdrawal. Mbiyo has already been dispatched in the branch above.
        pcfg = await get_paydunya_config(decrypt=True)
        if (not pcfg.get("enabled")
                or not _paydunya_credentials_configured(pcfg)
                or not op.get("withdraw_mode")):
            raise HTTPException(503, "PayDunya n'est pas configuré pour les retraits")
        operator_currency = str(op.get("currency") or "").upper()
        if operator_currency and operator_currency != req.currency.upper():
            raise HTTPException(400, "La devise ne correspond pas à l'opérateur")
        if req.amount < float(op.get("min", 0) or 0) or req.amount > float(op.get("max", 10**12) or 10**12):
            raise HTTPException(400, f"Montant hors des limites autorisées ({op['min']} - {op['max']} {req.currency})")

        fee_snapshot = paydunya.calculate_fees(req.amount, op, req.fee_bearer or "sender")
        effective_gateway_pct = op.get("gateway_fee_pct")
        if effective_gateway_pct is None or (
                float(effective_gateway_pct or 0) == 0
                and float(op.get("platform_fee_pct", 0) or 0) == 0
                and op.get("fee_pct") is not None):
            effective_gateway_pct = op.get("fee_pct", 0)
        fee_snapshot = {
            **fee_snapshot,
            "gateway_fee_pct": float(effective_gateway_pct or 0),
            "gateway_fee_fixed": float(op.get("gateway_fee_fixed", 0) or 0),
            "platform_fee_pct": float(op.get("platform_fee_pct", 0) or 0),
            "platform_fee_fixed": float(op.get("platform_fee_fixed", 0) or 0),
        }
        fee = fee_snapshot["total_fee"]
        gateway_fee = fee_snapshot["gateway_fee"]
        platform_fee = fee_snapshot["platform_fee"]
        total_debit = fee_snapshot["charged_amount"]
        recipient_gets = fee_snapshot["wallet_credit_amount"]

        if u.get(field, 0) < total_debit:
            raise HTTPException(400, "Solde insuffisant (frais inclus)")

        metadata = {
            "transfer_type": "biz_to_mobile",
            "source": (req.metadata or {}).get("source"),
            "environment": (req.metadata or {}).get("environment"),
            "product": (req.metadata or {}).get("product"),
            "merchant_reference": (req.metadata or {}).get("merchant_reference"),
            "provider": "paydunya",
            "country": op.get("country"),
            "country_code": op.get("country"),
            "country_label": op.get("country_label"),
            "operator": op.get("code"),
            "operator_name": op["name"],
            "fee_bearer": req.fee_bearer,
            "recipient_phone": req.recipient,
            "fee": fee, "gateway_fee": gateway_fee,
            "platform_fee": platform_fee,
            "recipient_gets": recipient_gets,
            "total_debit": total_debit,
            "fee_snapshot": fee_snapshot,
            "paydunya_status": "created",
            "idempotency_key": mobile_idempotency_key,
            "request_fingerprint": mobile_request_fingerprint,
            "debit_phase": "pending",
            "debit_pending_at": now_iso(),
            "debit_applied": False,
        }
        try:
            tx_out = await record_tx(
                uid, "transfer", "out", req.amount, req.currency,
                status="pending", counterparty=req.recipient,
                description=req.description, metadata=metadata)
        except DuplicateKeyError:
            existing_tx = await db.transactions.find_one(
                {"user_id": uid,
                 "metadata.idempotency_key": mobile_idempotency_key},
                {"_id": 0})
            if existing_tx:
                meta = existing_tx.get("metadata") or {}
                if meta.get("request_fingerprint") != mobile_request_fingerprint:
                    raise HTTPException(
                        409, "Cette clé d'idempotence appartient à un autre retrait")
                return {
                    "transaction": existing_tx, "fee": meta.get("fee", 0),
                    "total_debit": meta.get("total_debit", existing_tx.get("amount", 0)),
                    "recipient_gets": meta.get("recipient_gets", existing_tx.get("amount", 0)),
                    "operator": meta.get("operator_name", op["name"]),
                    "idempotent_replay": True,
                }
            raise

        # Conditional debit prevents concurrent withdrawals from overdrawing
        # the wallet. The transaction ID also makes the debit idempotent.
        debit = await db.users.update_one(
            {"id": uid, field: {"$gte": total_debit},
             "withdrawal_debit_ids": {"$ne": tx_out.id}},
            {"$inc": {field: -total_debit},
             "$addToSet": {"withdrawal_debit_ids": tx_out.id}})
        if not debit.modified_count:
            await db.transactions.update_one(
                {"id": tx_out.id, "status": "pending"},
                {"$set": {"status": "failed",
                          "metadata.failure_reason": "insufficient_balance"}})
            raise HTTPException(400, "Solde insuffisant (frais inclus)")
        await db.transactions.update_one(
            {"id": tx_out.id},
            {"$set": {"metadata.debit_applied": True,
                      "metadata.debit_phase": "applied",
                      "metadata.debit_applied_at": now_iso()}})

        withdraw_mode = op.get("withdraw_mode")
        callback_url = f"{callback_base}/api/webhooks/paydunya/disbursement?ref={tx_out.reference}"
        try:
            account_alias = paydunya.normalize_disbursement_account_alias(
                req.recipient or "", req.country or "")
        except ValueError as exc:
            await _refund_mobile_withdrawal(tx_out.id, str(exc))
            raise HTTPException(400, str(exc))

        # Creating the token is the only stage where a provider failure proves
        # that no payout can have been submitted, so a refund is safe here.
        try:
            invoice = await paydunya.get_disbursement_invoice(
                pcfg, amount=recipient_gets, currency=req.currency,
                withdraw_mode=withdraw_mode, account_alias=account_alias,
                callback_url=callback_url,
                description=req.description or f"Retrait Biz-transPay {tx_out.reference}",
                reference=tx_out.reference)
            invoice_token = paydunya.disbursement_token(invoice)
            if not invoice_token:
                raise paydunya.PayDunyaError(502, "PayDunya n'a pas retourné de référence de retrait")
        except paydunya.PayDunyaError as exc:
            await _refund_mobile_withdrawal(tx_out.id, exc.message)
            raise HTTPException(400 if exc.status < 500 else 502,
                                f"Passerelle Mobile Money: {exc.message}")
        except Exception as exc:
            await _refund_mobile_withdrawal(tx_out.id, str(exc))
            raise HTTPException(502, "Passerelle Mobile Money indisponible")

        # Persist the token before submit. If submit times out, refunding would
        # risk paying the beneficiary and crediting the wallet simultaneously.
        await db.transactions.update_one(
            {"id": tx_out.id},
            {"$set": {"metadata.paydunya_invoice_token": invoice_token,
                      "metadata.paydunya_withdraw_mode": withdraw_mode,
                      "metadata.paydunya_status": "created",
                      "metadata.next_reconcile_at": now_iso()}}
        )
        try:
            submitted = await paydunya.submit_disbursement_invoice(
                pcfg, invoice_token=invoice_token, withdraw_mode=withdraw_mode,
                account_alias=account_alias, amount=recipient_gets,
                currency=req.currency, callback_url=callback_url,
                reference=tx_out.reference)
            provider_id = paydunya.disbursement_provider_id(submitted) or \
                paydunya.disbursement_provider_id(invoice)
            submit_status = _disbursement_status(submitted)
            await db.transactions.update_one(
                {"id": tx_out.id},
                {"$set": {"metadata.paydunya_disbursement_id": provider_id,
                          "metadata.paydunya_status": submit_status or "submitted"}}
            )
            if submit_status in {"failed", "failure", "cancelled", "canceled",
                                 "rejected", "declined", "error"}:
                await _refund_mobile_withdrawal(tx_out.id, submit_status)
                raise HTTPException(400, "Le retrait Mobile Money a été refusé")
            if submit_status in {"success", "successful", "completed", "sent",
                                 "paid", "succeeded"}:
                fresh = await db.transactions.find_one({"id": tx_out.id}, {"_id": 0})
                await _reconcile_mobile_withdrawal(fresh)
        except paydunya.PayDunyaError as exc:
            # Submission may have reached PayDunya even when its response was
            # lost. Verify by token; otherwise keep the debit pending for the
            # callback instead of creating a double-spend refund.
            try:
                fresh = await db.transactions.find_one({"id": tx_out.id}, {"_id": 0})
                await _reconcile_mobile_withdrawal(fresh)
            except Exception:
                logger.warning("PayDunya payout submit uncertain for %s: %s",
                               tx_out.reference, exc.message)
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("PayDunya payout submit uncertain for %s: %s",
                           tx_out.reference, exc)

        latest_tx = await db.transactions.find_one({"id": tx_out.id}, {"_id": 0}) or tx_out.model_dump()
        if latest_tx.get("status") == "pending":
            await notify(uid, "withdrawal_pending",
                         "Retrait Mobile Money en cours",
                         f"Votre retrait de {req.amount:,.0f} {req.currency} est en cours de traitement.",
                         data={"transaction_id": tx_out.id, "reference": tx_out.reference,
                               "amount": req.amount, "currency": req.currency,
                               "transfer_type": "biz_to_mobile"})
        return {"transaction": latest_tx, "fee": fee, "total_debit": total_debit,
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
        fees_gw_fixed = (ccfg.get("fees_gateway_fixed") or {})
        fee_pct = float(fees_map.get(coin_upper, 4.0))  # stored as percent (e.g. 4.0 = 4%)
        gw_fixed = float(fees_gw_fixed.get(coin_upper, 0) or 0)
        # Gateway split: percent share + optional fixed amount (in the coin's native unit)
        gateway_fee, platform_fee = await _crypto_platform_fee(coin_upper, "withdrawal", req.amount)
        gateway_fee = round(gateway_fee + gw_fixed, 6)
        # Total fee applied on the transaction = pct part + fixed gateway
        fee = round(req.amount * (fee_pct / 100.0) + gw_fixed, 6)
        total_debit = req.amount + fee if req.fee_bearer == "sender" else req.amount
        recipient_gets = req.amount if req.fee_bearer == "sender" else req.amount - fee
        # Debit user balance atomically.  The read above is only informative;
        # this conditional update is the concurrency barrier.
        transfer_operation_id = new_id()
        if not await _debit_wallet_once(uid, field, total_debit,
                                        f"crypto-transfer:{transfer_operation_id}"):
            raise HTTPException(400, "Solde insuffisant (frais inclus)")
        tx_out = await record_tx(uid, "transfer", "out", req.amount, req.currency,
                                 status="pending",
                                 counterparty=req.wallet_address, description=req.description,
                                 metadata={"transfer_type": "biz_to_crypto",
                                           "crypto": coin_upper, "network": net_upper,
                                           "asset_code": asset_code,
                                           "wallet_address": req.wallet_address,
                                           "amount_gross": req.amount,
                                           "gateway_fee_fixed": gw_fixed,
                                           "fee": fee, "fee_pct": fee_pct,
                                           "gateway_fee": gateway_fee,
                                           "platform_fee": platform_fee,
                                           "amount_net": recipient_gets,
                                           "fee_bearer": req.fee_bearer,
                                           "recipient_gets": recipient_gets, "total_debit": total_debit,
                                            "recipient_name": req.recipient_name,
                                            "operation_id": transfer_operation_id},
                                  operation_id=f"crypto-transfer:{transfer_operation_id}")

        # Call IzichangePay to actually send the crypto on-chain
        if not izipay.is_configured():
            # Refund and fail
            await _refund_wallet_once(uid, field, total_debit,
                                      f"crypto-transfer:{transfer_operation_id}")
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
            await _refund_wallet_once(uid, field, total_debit,
                                      f"crypto-transfer:{transfer_operation_id}")
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
        upstream_status = (payout.get("status") or "").lower()
        # If IziChange returned a terminal status synchronously (fast stablecoin
        # payouts often confirm within the same request), mark the transaction
        # completed immediately — no need to wait for the webhook to fire.
        tx_update = {
            "metadata.izipay_payout_id": payout_id,
            "metadata.izipay_status": payout.get("status", "pending"),
        }
        if upstream_status in ("completed", "confirmed", "success", "successful", "sent_success"):
            tx_update["status"] = "completed"
            tx_update["metadata.tx_hash"] = payout.get("txHash") or payout.get("txhash") or payout.get("transactionHash")
        elif upstream_status in ("failed", "rejected", "error"):
            # Refund immediately on sync failure.
            await _refund_wallet_once(
                uid, field, total_debit,
                f"crypto-transfer:{transfer_operation_id}")
            tx_update["status"] = "failed"
        await db.transactions.update_one({"id": tx_out.id}, {"$set": tx_update})
        return {"transaction": tx_out.model_dump(), "fee": fee, "total_debit": total_debit,
                "recipient_gets": recipient_gets, "crypto": req.crypto.upper(),
                "network": req.network.upper(), "payout_id": payout_id,
                "pending": True,
                "message": "Transfert crypto en cours de traitement — confirmation on-chain sous quelques minutes."}

    raise HTTPException(400, "Type de transfert inconnu")


# ==================== DEPOSIT (Stripe) ====================
@api.post("/deposits/checkout")
async def create_deposit(req: DepositRequest, request: Request,
                         uid: str = Depends(require_recent_auth)):
    # Convert XOF/XAF amount to USD approximation for Stripe (1 USD ≈ 600 XOF)
    usd_amount = round(req.amount / 600.0, 2)
    if usd_amount < 0.5:
        raise HTTPException(400, "Montant minimum de dépôt : 300 XOF/XAF")

    host_url = str(request.base_url).rstrip('/')
    webhook_url = f"{host_url}/api/webhook/stripe"
    checkout = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=webhook_url)

    return_url = _validate_http_url(req.origin_url, "URL de retour")
    success_url = f"{return_url}/payment/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{return_url}/payment/cancel"

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
async def payment_status(session_id: str, request: Request,
                         uid: str = Depends(get_current_user_id)):
    record = await db.payment_transactions.find_one(
        {"session_id": session_id, "user_id": uid}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Transaction not found")
    if record.get("payment_status") != "paid":
        try:
            host_url = str(request.base_url).rstrip('/')
            webhook_url = f"{host_url}/api/webhook/stripe"
            checkout = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=webhook_url)
            s = await checkout.get_checkout_status(session_id)
            if s.payment_status == "paid" or s.status == "complete":
                field = "balance_xof" if record["currency"] == "XOF" else "balance_xaf"
                operation_id = f"stripe:deposit:{session_id}"
                await _credit_wallet_once(uid, field, record["amount"], operation_id)
                r = await db.payment_transactions.update_one(
                    {"session_id": session_id, "user_id": uid,
                     "payment_status": {"$ne": "paid"}},
                    {"$set": {"status": "completed", "payment_status": "paid",
                              "updated_at": now_iso(),
                              "credit_operation_id": operation_id}}
                )
                if r.modified_count > 0:
                    await record_tx(uid, "deposit", "in", record["amount"], record["currency"],
                                    description="Dépôt Stripe",
                                    metadata={"stripe_session_id": session_id},
                                    operation_id=operation_id)
                record = await db.payment_transactions.find_one(
                    {"session_id": session_id, "user_id": uid}, {"_id": 0})
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
            operation_id = f"stripe:deposit:{event.session_id}"
            await _credit_wallet_once(uid, field, record["amount"], operation_id)
            changed = await db.payment_transactions.update_one(
                {"session_id": event.session_id,
                 "payment_status": {"$ne": "paid"}},
                {"$set": {"status": "completed", "payment_status": "paid",
                          "updated_at": now_iso(),
                          "credit_operation_id": operation_id}}
            )
            if changed.modified_count or record.get("payment_status") == "paid":
                await record_tx(
                    uid, "deposit", "in", record["amount"], record["currency"],
                    description="Dépôt Stripe",
                    metadata={"stripe_session_id": event.session_id},
                    operation_id=operation_id,
                )
    return {"status": "ok"}


# ==================== CRYPTO ASSETS (public catalog) ====================
@api.get("/crypto/assets")
async def crypto_assets():
    """Public list of active crypto assets available on IzichangePay.
    Used by /dashboard/deposit and public payment link pages to show a list of
    supported cryptocurrencies. Filters out coins hidden by the admin in the
    deposit-side hidden_coins list.
    """
    if not izipay.is_configured():
        return []
    try:
        assets = await izipay.list_assets()
    except Exception:
        return []
    dep_cfg = await get_deposit_config()
    hidden = set((((dep_cfg.get("crypto") or {}).get("hidden_coins")) or []))
    result = []
    for a in assets:
        if not a.get("isActive"):
            continue
        code = (a.get("assetCode") or "").split(".")[0]
        if code in hidden:
            continue
        result.append({
            "asset_code": a.get("assetCode"),
            "coin": a.get("coin"),
            "network": a.get("network"),
            "blockchain_name": a.get("blockchainName"),
            "memo_required": a.get("memoRequired", False),
            "memo_type": a.get("memoType"),
        })
    return result


# ==================== DEPOSIT (Crypto via IzichangePay) ====================
@api.post("/deposits/crypto")
async def create_crypto_deposit(req: CryptoDepositRequest,
                                uid: str = Depends(require_recent_auth)):
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


# ==================== FEDAPAY (Mobile Money) ====================
@api.get("/fedapay/catalog")
async def fedapay_catalog():
    """Public catalog of countries + Mobile Money operators available via
    FedaPay. Used by the frontend to render the Deposit / Transfer forms.
    """
    return {"catalog": fedapay.catalog()}


@api.get("/deposits/config")
async def deposits_config_public():
    cfg = await get_paydunya_config()
    public = _paydunya_public_config(cfg)
    mb_cfg = await get_mbiyo_config()
    mb_public = _mbiyo_public_config(mb_cfg)
    # Grouping is retained for the existing deposit form contract.
    grouped: dict[str, dict] = {}
    for op in public["catalog"]:
        country = op.get("country", "")
        entry = grouped.setdefault(country, {
            "country": country,
            "country_label": op.get("country_label")
                or paydunya.COUNTRY_LABELS.get(country, country),
            "operators": [],
        })
        entry["operators"].append({
            "code": op["code"], "name": op.get("name") or op["code"],
            "label": op.get("name") or op["code"],
            "currency": op.get("currency") or "XOF",
            "fee_pct": float(op.get("fee_pct", 0) or 0),
            "fee_fixed": float(op.get("fee_fixed", 0) or 0),
            **{key: op.get(key, 0) for key in (
                "gateway_fee_pct", "gateway_fee_fixed",
                "platform_fee_pct", "platform_fee_fixed", "amount_increment")},
            "min": float(op.get("min", 100)),
            "max": float(op.get("max", 0)) or None,
            "payment_flow": op.get("payment_flow") or {},
        })
    for op in mb_public.get("catalog", []):
        country = op.get("country", "")
        entry = grouped.setdefault(country, {
            "country": country, "country_label": op.get("country_label")
                or mbiyo.COUNTRY_LABELS.get(country, country), "operators": [],
        })
        entry["operators"].append({
            "code": op["code"], "name": op.get("name") or op["code"],
            "label": op.get("name") or op["code"],
            "currency": op.get("currency") or "XOF",
            "fee_pct": float(op.get("fee_pct", 0) or 0),
            "fee_fixed": float(op.get("fee_fixed", 0) or 0),
            **{key: op.get(key, 0) for key in (
                "gateway_fee_pct", "gateway_fee_fixed",
                "platform_fee_pct", "platform_fee_fixed", "amount_increment")},
            "min": float(op.get("min", 100)), "max": float(op.get("max", 0)) or None,
            "payment_flow": op.get("payment_flow") or {},
        })
    for entry in grouped.values():
        unique = []
        seen = set()
        for operator in entry["operators"]:
            route_code = str(operator.get("code") or "").lower()
            route_code = route_code.removeprefix("mbiyo_")
            country_suffix = f"_{str(entry.get('country') or '').lower()}"
            if route_code.endswith(country_suffix):
                route_code = route_code[:-len(country_suffix)]
            identity = (
                str(entry.get("country") or "").upper(),
                re.sub(r"[^a-z0-9]", "", route_code),
                str(operator.get("currency") or "").upper(),
            )
            if identity in seen:
                continue
            seen.add(identity)
            unique.append(operator)
        entry["operators"] = unique
    public["catalog"] = list(grouped.values())
    public["mobile_money_enabled"] = bool(public.get("mobile_money_enabled") or
                                          mb_public.get("mobile_money_enabled"))
    # The top-level flag represents aggregate Mobile Money availability, not
    # PayDunya alone. This keeps Mbiyo-only configurations usable.
    public["enabled"] = public["mobile_money_enabled"]
    return public


class MobileMoneyDepositRequest(BaseModel):
    amount: float = Field(..., ge=1)
    currency: str = "XOF"
    email: str
    full_name: str
    country: str            # ISO-2, e.g. BJ, TG, CI
    operator: str           # code, e.g. mtn_bj, moov_tg, orange_ci
    phone_number: str       # e.g. "97000001"
    otp: Optional[str] = Field(None, min_length=1, max_length=32)
    idempotency_key: Optional[str] = Field(None, min_length=8, max_length=120)
    fee_bearer: Literal["sender", "receiver", "client", "merchant"] = "client"
    description: Optional[str] = None


def _plain_payment_instructions(value: Any) -> Optional[str]:
    """Keep operator instructions readable without exposing HTML/scripts."""
    if isinstance(value, (list, tuple)):
        value = " ".join(str(item) for item in value)
    if not isinstance(value, str):
        return None
    text = re.sub(r"<[^>]+>", " ", value)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:2000] or None


def _public_payment_error(value: Any) -> Optional[str]:
    """Return a provider-neutral error for customer payment screens."""
    if value in (None, ""):
        return None
    return "La demande de paiement n’a pas pu être traitée. Veuillez réessayer."


def _paydunya_operation_error(exc: paydunya.PayDunyaError) -> str:
    """Map provider failures to actionable, secret-free customer messages."""
    message = str(exc.message or "").strip()
    lowered = message.lower()
    if "sandbox" in lowered and ("customer" in lowered or "client" in lowered):
        return (
            "Le compte client de test PayDunya n’est pas configuré. "
            "Passez PayDunya en production ou configurez le client sandbox."
        )
    if exc.status in (401, 403) or any(
            term in lowered
            for term in ("credential", "private key", "master key", "token")):
        return "Les identifiants PayDunya sont invalides ou incomplets."
    if exc.status >= 500:
        return "PayDunya est momentanément indisponible. Réessayez dans quelques instants."
    if message:
        return f"PayDunya a refusé la demande : {message[:180]}"
    return "PayDunya a refusé la demande. Vérifiez la configuration de l’opérateur."


def _provider_reference(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    for key in ("transaction_id", "transactionId", "TransactionID",
                "transactionID", "TransactionId", "reference", "Reference", "id"):
        value = payload.get(key)
        if value not in (None, ""):
            return str(value)
    for value in payload.values():
        found = _provider_reference(value)
        if found:
            return found
    return None


def _mbiyo_transaction_id(payload: Any, allow_short_fields: bool = False) -> Optional[str]:
    """Extract only Mbiyo transaction identifiers, never a generic object id."""
    if not isinstance(payload, dict):
        return None
    for key in ("transaction_id", "transactionId", "provider_transaction_id",
                "providerTransactionId"):
        value = payload.get(key)
        if value not in (None, ""):
            return str(value)
    if allow_short_fields:
        for key in ("id", "reference"):
            value = payload.get(key)
            if value not in (None, ""):
                return str(value)
    for key in ("data", "result", "payload", "event", "transaction",
                "transaction_data", "payment"):
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                found = _mbiyo_transaction_id(item, allow_short_fields=True)
                if found:
                    return found
        else:
            found = _mbiyo_transaction_id(value, allow_short_fields=True)
            if found:
                return found
    return None


def _provider_scalar(payload: Any, *keys: str) -> Any:
    """Find a scalar transaction field in known provider response containers."""
    if not isinstance(payload, dict):
        return None
    for key in keys:
        value = payload.get(key)
        if value not in (None, "") and not isinstance(value, (dict, list)):
            return value
    metadata = payload.get("metadata")
    found = _provider_scalar(metadata, *keys)
    if found not in (None, ""):
        return found
    for key in ("data", "result", "payload", "event", "transaction",
                "transaction_data", "payment"):
        found = _provider_scalar(payload.get(key), *keys)
        if found not in (None, ""):
            return found
    return None


def _new_finalize_capability() -> tuple[str, str, str]:
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode()).hexdigest(), (
        datetime.now(timezone.utc) + timedelta(minutes=15)
    ).isoformat()


def _mbiyo_response_fields(response: dict) -> dict:
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    ref = _provider_reference(response)
    fields = {
        "auth_mode": data.get("auth_mode"),
        "redirect_url": data.get("redirect_url"),
        "instructions": _plain_payment_instructions(data.get("instructions")),
        "provider_reference": ref,
        "provider_response": {
            "transaction_id": ref,
            "status": data.get("status"),
        },
    }
    return {key: value for key, value in fields.items()
            if value is not None}


async def _create_mbiyo_deposit(req: MobileMoneyDepositRequest, request: Request,
                                uid: str,
                                record_context: Optional[dict] = None):
    cfg = await get_mbiyo_config(decrypt=True)
    if not cfg.get("enabled") or not cfg.get("_api_key"):
        raise HTTPException(503, "La passerelle Mobile Money n’est pas configurée")
    op = _active_mbiyo_operator(
        cfg.get("catalog") or [], req.country, req.operator)
    if not op:
        raise HTTPException(400, "Opérateur Mobile Money non disponible pour ce pays")
    if req.idempotency_key:
        previous = await db.momo_deposits.find_one(
            {"user_id": uid, "idempotency_key": req.idempotency_key}, {"_id": 0}
        )
        if previous:
            return _public_momo_deposit(previous)
    currency = str(op.get("currency") or req.currency).upper()
    if currency not in mbiyo.CURRENCIES.get(req.country.upper(), ()):
        raise HTTPException(400, "Devise invalide pour cet opérateur")
    if currency != req.currency.upper():
        raise HTTPException(400, f"Devise invalide pour cet opérateur : {currency}")
    minimum, maximum = float(op.get("min", 0)), float(op.get("max", 0) or 10**12)
    processed_amount = mbiyo.normalize_amount(req.country, req.amount)
    if processed_amount < minimum or processed_amount > maximum:
        raise HTTPException(400, f"Montant hors limites ({minimum:g} - {maximum:g} {currency})")
    fees = paydunya.calculate_fees(processed_amount, op,
                                   "merchant" if req.fee_bearer in ("merchant", "receiver") else "client")
    provider_submitted_amount = mbiyo.normalize_amount(
        req.country, fees["charged_amount"])
    if fees["fee_bearer"] == "client":
        rounded_total_fee = max(0.0, provider_submitted_amount - processed_amount)
        gateway_fee = min(float(fees["gateway_fee"]), rounded_total_fee)
        platform_fee = rounded_total_fee - gateway_fee
        fees.update({
            "gateway_fee": gateway_fee,
            "platform_fee": platform_fee,
            "total_fee": rounded_total_fee,
            "charged_amount": provider_submitted_amount,
            "wallet_credit_amount": processed_amount,
        })
    else:
        # Merchant-borne fees do not change the amount collected from the payer.
        provider_submitted_amount = processed_amount
        fees["charged_amount"] = processed_amount
    payment_flow = mbiyo.payment_flow({**op, "country": req.country}, req.amount)
    dep_id = new_id()
    callback_base = (os.environ.get("OFFICIAL_DOMAIN")
                     or _paydunya_callback_base(request)).rstrip("/")
    callback = f"{callback_base}/api/webhooks/mbiyo?ref={dep_id}"
    parts = (req.full_name or "Client").strip().split(" ", 1)
    created_at = now_iso()
    pending_doc = {
        "id": dep_id, "user_id": uid, "amount": processed_amount,
        "requested_amount": req.amount, "processed_amount": processed_amount,
        "provider_submitted_amount": provider_submitted_amount,
        "charged_amount": fees["charged_amount"],
        "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
        "total_fee": fees["total_fee"],
        "wallet_credit_amount": fees["wallet_credit_amount"],
        "fee_snapshot": fees, "fee_bearer": fees["fee_bearer"],
        "currency": currency, "email": req.email, "full_name": req.full_name,
        "country": req.country.upper(), "operator": req.operator,
        "operator_name": op.get("name"), "operator_snapshot": dict(op),
        "phone_number": req.phone_number, "provider": "mbiyo",
        "status": "pending", "submission_unknown": False,
        "idempotency_key": req.idempotency_key,
        "request_fingerprint": _request_fingerprint(req),
        "created_at": created_at,
        "pending_expires_at": (
            datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            + timedelta(minutes=MOMO_PENDING_TIMEOUT_MINUTES)
        ).isoformat(),
    }
    if record_context:
        pending_doc.update(record_context)
        if pending_doc.get("source") == "merchant_api":
            pending_doc["merchant_id"] = pending_doc.get("merchant_id") or uid
            pending_doc["reference"] = pending_doc.get("reference") or dep_id
            pending_doc["merchant_reference"] = (
                pending_doc.get("merchant_reference") or pending_doc["reference"]
            )
    await db.momo_deposits.insert_one(pending_doc)
    try:
        metadata = {"network": op.get("network"),
                    "phone_number": req.phone_number,
                    "country_code": req.country.upper()}
        if req.otp:
            metadata["om_otp"] = req.otp
        response = await mbiyo.MbiyoClient(
            cfg["_api_key"], cfg.get("base_url", mbiyo.BASE_URL)).payin(
                amount=provider_submitted_amount, currency=currency,
                payment_method="mobile_money", order_id=dep_id,
                callback_url=callback,
                 metadata=metadata)
    except mbiyo.MbiyoError as exc:
        if exc.status < 500:
            safe_reason = re.sub(r"[\r\n]+", " ", str(exc.message or "")).strip()[:180]
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {"status": "failed", "provider_status": "rejected",
                          "failed_reason": safe_reason or "provider_rejected",
                          "provider_error_status": exc.status}},
            )
            raise HTTPException(
                400,
                ("La passerelle Mobile Money a refusé la demande"
                 + (f" : {safe_reason}" if safe_reason else ".")),
            )
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"submission_unknown": True,
                      "provider_status": "unknown", "error": str(exc)[:240]}},
        )
        pending_doc.update(submission_unknown=True, provider_status="unknown")
        return _public_momo_deposit(pending_doc)
    except Exception as exc:
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"submission_unknown": True,
                      "provider_status": "unknown", "error": str(exc)[:240]}},
        )
        pending_doc.update(submission_unknown=True, provider_status="unknown")
        return _public_momo_deposit(pending_doc)
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    provider_id = _mbiyo_transaction_id(response)
    if not provider_id:
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"submission_unknown": True, "provider_status": "unknown"}},
        )
        pending_doc.update(submission_unknown=True, provider_status="unknown")
        return _public_momo_deposit(pending_doc)
    doc = {
        "id": dep_id, "user_id": uid, "amount": processed_amount,
        "requested_amount": req.amount, "processed_amount": processed_amount,
        "provider_submitted_amount": provider_submitted_amount,
        "charged_amount": fees["charged_amount"],
        "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
        "total_fee": fees["total_fee"], "wallet_credit_amount": fees["wallet_credit_amount"],
        "fee_snapshot": fees, "currency": currency, "email": req.email,
        "full_name": req.full_name, "country": req.country.upper(), "operator": req.operator,
        "operator_name": op.get("name"), "operator_snapshot": dict(op),
        "phone_number": req.phone_number, "fee_bearer": fees["fee_bearer"],
        "idempotency_key": req.idempotency_key,
        "provider": "mbiyo", "mbiyo_transaction_id": str(provider_id),
        # The provider transaction ID is returned in the response to a request
        # that included this order_id.  It is safe to reuse that binding during
        # status polling; the ID is restricted to known Mbiyo fields and has a
        # unique database index.
        "provider_binding_verified": True,
        "payment_flow": payment_flow,
        **_mbiyo_response_fields(response),
        "status": ("failed" if mbiyo.status_value(response) in mbiyo.FAILURE_STATUSES
                   else "pending"),
        "provider_status": mbiyo.status_value(response) or "pending",
        "created_at": pending_doc["created_at"],
        "pending_expires_at": pending_doc["pending_expires_at"],
    }
    if record_context:
        doc.update({
            key: pending_doc.get(key)
            for key in (
                "merchant_id", "source", "environment", "product", "reference",
                "merchant_reference", "metadata", "link_payment_id",
                "single_use_claim_id",
            )
            if pending_doc.get(key) is not None
        })
    await db.momo_deposits.update_one({"id": dep_id}, {"$set": doc})
    if mbiyo.status_value(response) in mbiyo.SUCCESS_STATUSES:
        # Do not trust the initiation response alone. Re-read the transaction
        # server-to-server and apply the same reconciliation/idempotency path
        # used by callbacks and the background repair loop.
        try:
            await _reconcile_mbiyo_deposit(dep_id)
            doc = await db.momo_deposits.find_one({"id": dep_id}, {"_id": 0}) or doc
        except Exception:
            logger.exception("Immediate Mbiyo deposit reconciliation failed for %s", dep_id)
    return {"id": dep_id, "status": doc["status"], "amount": processed_amount,
            "requested_amount": req.amount, "processed_amount": processed_amount,
            "charged_amount": fees["charged_amount"],
            "total_fee": fees["total_fee"], "fee_bearer": fees["fee_bearer"],
            "currency": currency, "operator": {"code": req.operator, "label": op.get("name")},
            "phone_number": req.phone_number,
            "payment_kind": "redirect" if doc.get("redirect_url") else "phone",
            "checkout_url": doc.get("redirect_url"),
            "payment_flow": payment_flow, "auth_mode": doc.get("auth_mode"),
            "redirect_url": doc.get("redirect_url"),
            "instructions": doc.get("instructions"),
             "created_at": doc.get("created_at"),
             "pending_expires_at": doc.get("pending_expires_at"),
            "pending_remaining_seconds": MOMO_PENDING_TIMEOUT_MINUTES * 60,
            "otp_required": doc.get("auth_mode") == "pin",
            "challenge_status": "required" if doc.get("auth_mode") == "pin" else "pending",
            "message": "Suivez les instructions affichées puis validez la demande sur votre téléphone."}


@api.post("/deposits/mobile-money/start")
async def start_mobile_money_deposit(req: MobileMoneyDepositRequest,
                                     request: Request,
                                     uid: str = Depends(require_recent_auth)):
    """Start the customer-facing payment using the admin-selected route.

    The route name is deliberately kept server-side. The browser receives only
    the UX action it must perform: phone confirmation, popup, or redirect.
    """
    idem_key = str(req.idempotency_key or "").strip()
    fingerprint = _request_fingerprint(req)
    reservation_key = f"momo-deposit:{idem_key}" if idem_key else ""
    if idem_key:
        previous = await db.momo_deposits.find_one(
            {"user_id": uid, "idempotency_key": idem_key}, {"_id": 0})
        if previous:
            previous_fingerprint = previous.get("request_fingerprint")
            if previous_fingerprint and previous_fingerprint != fingerprint:
                raise HTTPException(
                    409, "Cette clé d’idempotence appartient à un autre dépôt")
            return _public_momo_deposit(previous)
        try:
            cached = await _idempotency_claim(
                uid, reservation_key, "POST",
                "/api/deposits/mobile-money/start", fingerprint)
        except BizAPIError as exc:
            raise HTTPException(
                exc.status_code,
                "Une demande de dépôt identique est déjà en cours.",
            )
        if cached and cached.get("body") is not None:
            return cached["body"]
    try:
        provider = await _resolve_deposit_provider(
            req.country, req.operator, req.currency)
        if provider == "mbiyo":
            result = await _create_mbiyo_deposit(req, request, uid)
        else:
            cfg = await get_paydunya_config()
            public = _paydunya_public_config(cfg)
            if not public.get("enabled") or not public.get("mobile_money_enabled"):
                raise HTTPException(503, "Mobile Money temporairement indisponible")

            modes = cfg.get("modes") if isinstance(cfg.get("modes"), dict) else {}
            enabled = lambda key: bool(
                (modes.get(key) or {}).get("enabled", False)
                if isinstance(modes.get(key), dict) else modes.get(key, False)
            )
            if not modes or enabled("softpay_direct") or enabled("softpay"):
                direct = await create_mobile_money_deposit(req, request, uid)
                result = {
                    **direct,
                    "payment_kind": direct.get("payment_kind", "phone"),
                }
            elif enabled("psr"):
                popup = await _create_paydunya_invoice_deposit(
                    req, uid, "psr", _paydunya_callback_base(request))
                result = {**popup, "payment_kind": "popup"}
            elif enabled("par_redirect"):
                redirect = await _create_paydunya_invoice_deposit(
                    req, uid, "par_redirect", _paydunya_callback_base(request))
                result = {**redirect, "payment_kind": "redirect"}
            else:
                raise HTTPException(503, "Mobile Money temporairement indisponible")
    except HTTPException:
        if reservation_key:
            persisted = await db.momo_deposits.find_one(
                {"user_id": uid, "idempotency_key": idem_key}, {"_id": 0, "id": 1})
            if not persisted:
                await _idempotency_release(uid, reservation_key, fingerprint)
        raise
    except Exception:
        if reservation_key:
            persisted = await db.momo_deposits.find_one(
                {"user_id": uid, "idempotency_key": idem_key}, {"_id": 0, "id": 1})
            if not persisted:
                await _idempotency_release(uid, reservation_key, fingerprint)
        raise
    if reservation_key:
        await _idempotency_store(
            uid, reservation_key, "POST",
            "/api/deposits/mobile-money/start", 200, result)
    return result


@api.post("/deposits/mobile-money")
async def create_mobile_money_deposit(req: MobileMoneyDepositRequest,
                                      request: Request,
                                      uid: str = Depends(require_recent_auth)):
    """Create a PayDunya invoice and trigger SoftPay; never credits here."""
    cfg = await get_paydunya_config(decrypt=True)
    if not cfg.get("enabled"):
        raise HTTPException(503, "Passerelle Mobile Money non configurée")
    if not paydunya.mode_is_enabled(cfg, "softpay_direct"):
        raise HTTPException(503, "Le paiement direct Mobile Money est désactivé")
    admin_op = next((op for op in cfg.get("catalog", [])
                     if op.get("country", "").upper() == req.country.upper()
                     and op.get("code", "").lower() == req.operator.lower()
                     and op.get("active", True)
                     and not op.get("archived", False)
                     and not op.get("hidden", False)), None)
    if not admin_op:
        raise HTTPException(400, "Opérateur non disponible pour ce pays")
    payment_flow = paydunya.payment_flow(admin_op, req.amount)
    if (payment_flow.get("otp_required") and payment_flow.get("before_submit")
            and not req.otp):
        raise HTTPException(
            400,
            detail={"message": "Générez le code indiqué puis saisissez-le avant de lancer le paiement.",
                    "code": "OTP_REQUIRED", "payment_flow": payment_flow},
        )
    currency = (admin_op.get("currency") or req.currency or "XOF").upper()
    if currency not in PAYDUNYA_WALLET_CURRENCIES:
        raise HTTPException(400, "Devise non prise en charge par le portefeuille")
    if req.currency and req.currency.upper() != currency:
        raise HTTPException(400, f"Devise invalide pour cet opérateur : {currency}")
    min_amt, max_amt = float(admin_op.get("min", 100)), float(admin_op.get("max", 0)) or None
    if req.amount < min_amt:
        raise HTTPException(400, f"Montant minimum : {int(min_amt)} {currency}")
    if max_amt and req.amount > max_amt:
        raise HTTPException(400, f"Montant maximum : {int(max_amt)} {currency}")
    bearer = "merchant" if req.fee_bearer in ("merchant", "receiver") else "client"
    fees = paydunya.calculate_fees(req.amount, admin_op, bearer)
    phone = req.phone_number
    if req.country.upper() == "TG":
        try:
            phone = paydunya.normalize_togo_phone(phone)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    dep_id = new_id()
    parts = (req.full_name or "").strip().split(" ", 1)
    first = parts[0] or "Client"
    last = parts[1] if len(parts) > 1 else first
    created_at = now_iso()
    callback_base = (os.environ.get("OFFICIAL_DOMAIN")
                     or _paydunya_callback_base(request)).rstrip("/")
    callback = f"{callback_base}/api/webhooks/paydunya?ref={dep_id}"
    try:
        invoice = await paydunya.create_invoice(
            cfg, amount=fees["charged_amount"], currency=currency, token=dep_id,
            customer={"firstname": first, "lastname": last, "email": req.email,
                      "phone_number": phone},
            callback_url=callback,
            return_url=(
                f"{callback_base}/api/deposits/paydunya/return?ref={dep_id}"
            ),
            cancel_url=f"{callback_base}/dashboard?paydunya=cancelled",
            description=req.description or f"Dépôt Biz-transPay {req.amount} {currency}",
        )
        token = paydunya.invoice_token(invoice)
        if not token:
            raise paydunya.PayDunyaError(502, "PayDunya did not return an invoice token")
        existing = await db.momo_deposits.find_one({"paydunya_token": token}, {"_id": 0})
        if existing:
            raise HTTPException(409, "Cette demande de paiement existe déjà")
        doc = {
            "id": dep_id, "user_id": uid, "amount": req.amount,
            "requested_amount": fees["requested_amount"],
            "charged_amount": fees["charged_amount"],
            "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
            "total_fee": fees["total_fee"], "wallet_credit_amount": fees["wallet_credit_amount"],
            "fee_snapshot": {
                **fees,
                "gateway_fee_pct": float(admin_op.get("gateway_fee_pct", admin_op.get("fee_pct", 0))),
                "gateway_fee_fixed": float(admin_op.get("gateway_fee_fixed", 0)),
                "platform_fee_pct": float(admin_op.get("platform_fee_pct", 0)),
                "platform_fee_fixed": float(admin_op.get("platform_fee_fixed", 0)),
            },
            "currency": currency, "email": req.email, "full_name": req.full_name,
            "country": req.country, "operator": req.operator,
            "operator_name": admin_op.get("name"),
            "endpoint_slug": admin_op.get("endpoint_slug"),
            "operator_snapshot": dict(admin_op),
            "phone_number": phone, "fee_bearer": fees["fee_bearer"],
            "idempotency_key": req.idempotency_key,
            "request_fingerprint": _request_fingerprint(req),
            "paydunya_token": token,
            "paydunya_reference": invoice.get("reference") or invoice.get("invoice_id"),
            "checkout_url": paydunya.checkout_url(invoice),
            "status": "pending", "provider": "paydunya",
            "provider_mode": cfg.get("mode", "test"),
            "paydunya_flow": "softpay_direct",
            "payment_flow": payment_flow,
            "auth_mode": "pin" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else None,
            "otp_required": admin_op.get("endpoint_slug") == "wizall-money-senegal",
            "challenge_status": "required" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else "pending",
            "prompt_sent": False, "prompt_error": None,
             "created_at": created_at,
             "pending_expires_at": (
                 datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                 + timedelta(minutes=MOMO_PENDING_TIMEOUT_MINUTES)
             ).isoformat(),
        }
        try:
            await db.momo_deposits.create_index("paydunya_token", unique=True, sparse=True)
            await db.momo_deposits.insert_one(doc)
        except Exception as exc:
            if "duplicate" in str(exc).lower():
                raise HTTPException(409, "Cette demande de paiement existe déjà")
            raise
        softpay = await paydunya.softpay_payment(
            cfg, invoice_token=token, operator=admin_op, phone=phone,
            amount=fees["charged_amount"], currency=currency,
            customer_name=req.full_name, customer_email=req.email, otp=req.otp or "")
        provider_ref = _provider_reference(softpay)
        redirect_url = paydunya.checkout_url(softpay)
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"prompt_sent": True, "prompt_error": None,
                      "paydunya_reference": (
                          invoice.get("reference") or invoice.get("invoice_id")
                           or provider_ref),
                      "provider_reference": provider_ref,
                      "redirect_url": redirect_url or None,
                      "payment_flow": payment_flow,
                      "auth_mode": "pin" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else None,
                      "otp_required": admin_op.get("endpoint_slug") == "wizall-money-senegal",
                      "challenge_status": "required" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else "pending"}})
    except HTTPException:
        raise
    except paydunya.PayDunyaError as exc:
        logger.warning(
            "PayDunya deposit initiation failed status=%s message=%s",
            exc.status, str(exc.message or "")[:240],
        )
        has_invoice = "doc" in locals() and doc.get("paydunya_token")
        fallback_url = doc.get("checkout_url") if has_invoice else None
        softpay_fallback = bool(
            has_invoice and fallback_url and exc.status >= 500
        )
        if softpay_fallback:
            safe_error = _paydunya_operation_error(exc)
            softpay_fallback_error = safe_error
            redirect_url = fallback_url
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {
                    "retryable": False,
                    "prompt_sent": False,
                    "prompt_error": safe_error,
                    "submission_unknown": True,
                    "softpay_error_status": exc.status,
                    "payment_fallback": "hosted_checkout",
                    "redirect_url": fallback_url,
                    "next_reconcile_at": now_iso(),
                }},
            )
        elif has_invoice:
            safe_error = str(exc.message or "SoftPay provider error")[:240]
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {"status": "failed", "retryable": True,
                          "prompt_sent": False, "prompt_error": safe_error,
                          "failed_at": now_iso()}})
        if not softpay_fallback:
            if cfg.get("mode") != "live" and (
                    "sandbox" in str(exc.message or "").lower()
                    or any(term in str(exc.message or "").lower()
                           for term in ("password", "credential", "account", "customer"))):
                raise HTTPException(
                    503,
                    _paydunya_operation_error(exc),
                )
            raise HTTPException(
                400 if exc.status < 500 else 502,
                _paydunya_operation_error(exc),
            )
    except Exception as exc:
        if "doc" in locals() and doc.get("paydunya_token"):
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {"status": "failed", "retryable": True,
                          "prompt_sent": False,
                          "prompt_error": str(exc)[:240],
                          "failed_at": now_iso()}})
        raise HTTPException(502, "Échec du déclenchement du paiement Mobile Money")

    return {
        "id": dep_id,
        "status": "pending",
        "amount": fees["requested_amount"],
        "requested_amount": fees["requested_amount"],
        "charged_amount": fees["charged_amount"],
        "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
        "total_fee": fees["total_fee"], "fee_bearer": fees["fee_bearer"],
        "currency": currency,
        "operator": {"code": req.operator, "label": admin_op.get("name"),
                     "endpoint_slug": admin_op.get("endpoint_slug")},
         "phone_number": phone, "checkout_url": locals().get("redirect_url") or doc["checkout_url"],
         "redirect_url": locals().get("redirect_url"),
         "payment_flow": payment_flow,
         "auth_mode": "pin" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else None,
         "otp_required": admin_op.get("endpoint_slug") == "wizall-money-senegal",
         "challenge_status": "required" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else "pending",
         "prompt_sent": not locals().get("softpay_fallback", False),
         "prompt_error": (
             locals().get("softpay_fallback_error")
             if locals().get("softpay_fallback", False) else None),
         "submission_unknown": bool(locals().get("softpay_fallback", False)),
         "payment_fallback": (
             "hosted_checkout"
             if locals().get("softpay_fallback", False) else None),
         "payment_kind": (
             "redirect"
             if locals().get("softpay_fallback", False)
             or locals().get("redirect_url") else "phone"),
         "created_at": doc.get("created_at"),
         "pending_expires_at": doc.get("pending_expires_at"),
         "message": (
             "La demande téléphonique tarde. Ouvrez la page sécurisée "
             "PayDunya pour terminer le paiement."
             if locals().get("softpay_fallback", False)
             else ("Ouvrez le lien affiché et validez le paiement."
                   if locals().get("redirect_url")
                   else "Vérifiez votre téléphone et validez la demande.")),
    }


class PayDunyaInvoiceRequest(BaseModel):
    """Request shared by the hosted (PAR) and client (PSR) flows.

    Country and operator are mandatory so disabled local routes cannot be
    bypassed through a provider-hosted checkout.
    """
    amount: float = Field(..., ge=1)
    currency: str = "XOF"
    email: str
    full_name: str
    country: str
    operator: str
    phone_number: Optional[str] = None
    fee_bearer: Literal["sender", "receiver", "client", "merchant"] = "client"
    description: Optional[str] = None
    return_url: Optional[str] = None


def _paydunya_callback_base(request: Request) -> str:
    """Return the externally reachable origin seen by PayDunya."""
    official = str(os.environ.get("OFFICIAL_DOMAIN") or "").strip().rstrip("/")
    if official:
        return official if "://" in official else f"https://{official}"
    preview = str(os.environ.get("REPLIT_DEV_DOMAIN") or "").strip().rstrip("/")
    if preview:
        return preview if "://" in preview else f"https://{preview}"
    raise HTTPException(
        503, "Le domaine public officiel doit être configuré pour les callbacks.")


async def _create_paydunya_invoice_deposit(req: PayDunyaInvoiceRequest,
                                           uid: str, flow: str,
                                           callback_base_url: str = "") -> dict:
    """Create a pending local row plus a PayDunya invoice.

    This helper deliberately does not approve or credit anything.  Approval is
    only possible after ``confirm_invoice`` validates the provider response.
    """
    cfg = await get_paydunya_config(decrypt=True)
    if not cfg.get("enabled"):
        raise HTTPException(503, "Passerelle Mobile Money non configurée")
    if not paydunya.mode_is_enabled(cfg, flow):
        raise HTTPException(503, "Ce mode de paiement Mobile Money est désactivé")
    if flow not in ("psr", "par_redirect"):
        raise HTTPException(400, "Mode de paiement Mobile Money invalide")

    selected = _active_operator(
        cfg.get("catalog") or [], req.country, req.operator)
    if not selected:
        raise HTTPException(400, "Opérateur non disponible pour ce pays")

    currency = (selected.get("currency") if selected else req.currency or "XOF").upper()
    if currency not in PAYDUNYA_WALLET_CURRENCIES:
        raise HTTPException(400, "Devise non prise en charge par le portefeuille")
    if req.currency and req.currency.upper() != currency:
        raise HTTPException(400, f"Devise invalide pour cet opérateur : {currency}")
    if selected:
        minimum = float(selected.get("min", 100))
        maximum = float(selected.get("max", 0)) or None
        if req.amount < minimum:
            raise HTTPException(400, f"Montant minimum : {int(minimum)} {currency}")
        if maximum and req.amount > maximum:
            raise HTTPException(400, f"Montant maximum : {int(maximum)} {currency}")
    tariff = selected or {}
    bearer = "merchant" if req.fee_bearer in ("merchant", "receiver") else "client"
    fees = paydunya.calculate_fees(req.amount, tariff, bearer)
    phone = req.phone_number
    if phone and (req.country or "").upper() == "TG":
        try:
            phone = paydunya.normalize_togo_phone(phone)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    dep_id = new_id()
    parts = (req.full_name or "").strip().split(" ", 1)
    first, last = (parts[0] or "Client"), (parts[1] if len(parts) > 1 else (parts[0] or "Client"))
    callback_base = (os.environ.get("OFFICIAL_DOMAIN") or callback_base_url).rstrip("/")
    callback = f"{callback_base}/api/webhooks/paydunya?ref={dep_id}"
    try:
        invoice = await paydunya.create_invoice(
            cfg, amount=fees["charged_amount"], currency=currency, token=dep_id,
            customer={"firstname": first, "lastname": last, "email": req.email,
                      **({"phone_number": phone} if phone else {})},
            callback_url=callback,
            return_url=(
                req.return_url
                or f"{callback_base}/api/deposits/paydunya/return?ref={dep_id}"
            ),
            cancel_url=f"{callback_base}/dashboard/deposit?paydunya=cancelled",
            description=req.description or f"Dépôt Biz-transPay {req.amount} {currency}",
        )
    except paydunya.PayDunyaError as exc:
        logger.warning(
            "PayDunya invoice creation failed status=%s message=%s",
            exc.status, str(exc.message or "")[:240],
        )
        raise HTTPException(400 if exc.status < 500 else 502,
                            _paydunya_operation_error(exc))
    token = paydunya.invoice_token(invoice)
    if not token:
        raise HTTPException(502, "La passerelle n’a pas retourné de référence de paiement")
    psr_capability = secrets.token_urlsafe(32) if flow == "psr" else None
    psr_capability_expires = (
        datetime.now(timezone.utc) + timedelta(minutes=10)
        if psr_capability else None
    )
    created_at = now_iso()

    doc = {
        "id": dep_id, "user_id": uid, "amount": req.amount,
        "requested_amount": fees["requested_amount"],
        "charged_amount": fees["charged_amount"],
        "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
        "total_fee": fees["total_fee"], "wallet_credit_amount": fees["wallet_credit_amount"],
        "fee_snapshot": {
            **fees,
            "gateway_fee_pct": float(tariff.get("gateway_fee_pct", tariff.get("fee_pct", 0))),
            "gateway_fee_fixed": float(tariff.get("gateway_fee_fixed", 0)),
            "platform_fee_pct": float(tariff.get("platform_fee_pct", 0)),
            "platform_fee_fixed": float(tariff.get("platform_fee_fixed", 0)),
        },
        "currency": currency, "email": req.email, "full_name": req.full_name,
        "country": req.country, "operator": req.operator,
        "operator_name": selected.get("name") if selected else None,
        "endpoint_slug": selected.get("endpoint_slug") if selected else None,
        "operator_snapshot": dict(selected) if selected else None,
        "phone_number": phone, "fee_bearer": fees["fee_bearer"],
        "idempotency_key": getattr(req, "idempotency_key", None),
        "request_fingerprint": _request_fingerprint(req),
        "paydunya_token": token,
        "paydunya_reference": invoice.get("reference") or invoice.get("invoice_id"),
        "checkout_url": paydunya.checkout_url(invoice),
        "status": "pending", "provider": "paydunya",
        "provider_mode": cfg.get("mode", "test"), "paydunya_flow": flow,
        "psr_capability_hash": (
            hashlib.sha256(psr_capability.encode()).hexdigest()
            if psr_capability else None),
        "psr_capability_expires_at": (
            psr_capability_expires.isoformat() if psr_capability_expires else None),
        "psr_capability_used": False if psr_capability else None,
        "created_at": created_at,
        "pending_expires_at": (
            datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            + timedelta(minutes=MOMO_PENDING_TIMEOUT_MINUTES)
        ).isoformat(),
    }
    try:
        await db.momo_deposits.create_index("paydunya_token", unique=True, sparse=True)
    except Exception:
        pass
    try:
        await db.momo_deposits.insert_one(doc)
    except Exception as exc:
        if "duplicate" in str(exc).lower():
            raise HTTPException(409, "Cette demande de paiement existe déjà")
        raise
    result = {
        "id": dep_id, "status": "pending", "amount": fees["requested_amount"],
        "requested_amount": fees["requested_amount"],
        "charged_amount": fees["charged_amount"],
        "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
        "total_fee": fees["total_fee"], "fee_bearer": fees["fee_bearer"],
        "currency": currency, "mode": flow,
        "created_at": doc.get("created_at"),
        "pending_expires_at": doc.get("pending_expires_at"),
    }
    # PAR intentionally exposes only the hosted URL as a provider artifact;
    # PSR exposes token + mode for the PayDunya client SDK.
    if flow == "par_redirect":
        result["checkout_url"] = doc["checkout_url"]
    else:
        result["psr_token_url"] = (
            f"/api/deposits/paydunya/psr/{dep_id}/token/{psr_capability}")
    return result


@api.post("/deposits/mobile-money/par")
@api.post("/deposits/mobile-money/par-redirect")
@api.post("/deposits/paydunya/par")
@api.post("/deposits/paydunya/par-redirect")
async def create_paydunya_par(req: PayDunyaInvoiceRequest,
                               request: Request,
                               uid: str = Depends(get_current_user_id)):
    return await _create_paydunya_invoice_deposit(
        req, uid, "par_redirect", _paydunya_callback_base(request))


@api.post("/deposits/mobile-money/psr")
@api.post("/deposits/paydunya/psr")
async def create_paydunya_psr(req: PayDunyaInvoiceRequest,
                               request: Request,
                               uid: str = Depends(get_current_user_id)):
    return await _create_paydunya_invoice_deposit(
        req, uid, "psr", _paydunya_callback_base(request))


@api.get("/deposits/paydunya/psr/{deposit_id}/token/{capability}")
async def get_paydunya_psr_token(deposit_id: str, capability: str):
    """Return the server-created invoice token to the official PSR SDK.

    The URL is a short-lived bearer capability for the PayDunya SDK. It is
    stored only as a SHA-256 hash, has no user identity, and is consumed once.
    """
    cfg = await get_paydunya_config()
    if not paydunya.mode_is_enabled(cfg, "psr"):
        raise HTTPException(503, "Ce mode de paiement Mobile Money est désactivé")
    if not capability or len(capability) > 256:
        raise HTTPException(404, "Facture PSR introuvable ou indisponible")
    capability_hash = hashlib.sha256(capability.encode()).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    deposit = await db.momo_deposits.find_one(
        {
            "id": deposit_id,
            "provider": "paydunya",
            "paydunya_flow": "psr",
            "status": "pending",
            "psr_capability_hash": capability_hash,
            "psr_capability_used": {"$ne": True},
            "psr_capability_expires_at": {"$gt": now},
        },
        {"_id": 0, "paydunya_token": 1},
    )
    if not deposit or not deposit.get("paydunya_token"):
        raise HTTPException(404, "Facture PSR introuvable ou indisponible")
    claimed = await db.momo_deposits.update_one(
        {
            "id": deposit_id,
            "provider": "paydunya",
            "paydunya_flow": "psr",
            "status": "pending",
            "psr_capability_hash": capability_hash,
            "psr_capability_used": {"$ne": True},
            "psr_capability_expires_at": {"$gt": now},
        },
        {"$set": {"psr_capability_used": True,
                  "psr_capability_used_at": now_iso()}},
    )
    if claimed.modified_count != 1:
        raise HTTPException(404, "Facture PSR introuvable ou indisponible")
    response = {"success": True, "token": deposit["paydunya_token"]}
    if cfg.get("mode") != "live":
        response["mode"] = "test"
    return response


def _momo_pending_expiry(d: dict) -> Optional[datetime]:
    """Return the server-side deadline for an in-flight Mobile Money deposit."""
    raw = d.get("pending_expires_at")
    if raw:
        try:
            return _as_utc(raw)
        except (TypeError, ValueError):
            pass
    created = d.get("created_at")
    if created:
        try:
            return _as_utc(created) + timedelta(minutes=MOMO_PENDING_TIMEOUT_MINUTES)
        except (TypeError, ValueError):
            pass
    return None


async def _expire_momo_deposit_if_due(d: Optional[dict]) -> bool:
    """Fail an unresolved payment once its ten-minute verification window ends."""
    if not d or d.get("status") != "pending":
        return False
    expiry = _momo_pending_expiry(d)
    if not expiry or expiry > datetime.now(timezone.utc):
        return False
    now = now_iso()
    result = await db.momo_deposits.update_one(
        {"id": d["id"], "status": "pending"},
        {"$set": {
            "status": "failed",
            # A PayDunya hosted checkout remains payable after our initial UX
            # window. Keep reconciling it so a verified late payment is never
            # lost; the wallet credit path remains exactly-once.
            "retryable": d.get("provider") == "paydunya",
            "provider_status": "expired",
            "failed_reason": "expired",
            "failed_at": now,
        }},
    )
    link_payment_id = d.get("link_payment_id")
    if link_payment_id:
        await db.link_payments.update_one(
            {"id": link_payment_id, "status": "pending"},
            {"$set": {
                "status": "failed",
                "failed_reason": "expired",
                "failed_at": now,
            }},
        )
    return result.modified_count == 1


async def _reconcile_momo_deposit(dep_id: str) -> bool:
    """Reconcile a pending PayDunya deposit server-to-server."""
    d = await db.momo_deposits.find_one({"id": dep_id}, {"_id": 0})
    if not d:
        return False
    if d.get("provider") != "paydunya" or not d.get("paydunya_token"):
        return False
    if d.get("status") == "approved":
        return True
    if d.get("status") not in ("pending", "failed"):
        return False
    if d.get("status") in ("pending", "failed"):
        try:
            cfg = await get_paydunya_config(decrypt=True)
            response = await paydunya.confirm_invoice(cfg, d["paydunya_token"])
            if not paydunya.confirmation_valid(
                    response, master_key=(cfg.get("_credentials") or {}).get("master_key", ""),
                    token=d["paydunya_token"], amount=d.get("charged_amount", d.get("amount")),
                    currency=d.get("currency", "XOF"), deposit_id=d["id"]):
                logger.warning("PayDunya confirmation rejected for %s", dep_id)
                await _expire_momo_deposit_if_due(d)
                return False
            receipt_url = response.get("receipt_url")
            if isinstance(receipt_url, str) and receipt_url.startswith(
                    ("https://paydunya.com/", "https://app.paydunya.com/")):
                d["receipt_url"] = receipt_url
                await db.momo_deposits.update_one(
                    {"id": dep_id}, {"$set": {"receipt_url": receipt_url}})
        except paydunya.PayDunyaError as exc:
            # Configuration/credential failures must be visible to operators;
            # transient provider failures simply leave the row pending for retry.
            if exc.status == 500:
                raise
            return False
        except Exception:
            return False
    await _credit_momo_deposit(d)
    return True


async def _reconcile_mbiyo_deposit(dep_id: str) -> bool:
    """Verify a Mbiyo deposit server-to-server and credit it once."""
    d = await db.momo_deposits.find_one({"id": dep_id}, {"_id": 0})
    if not d or d.get("provider") != "mbiyo":
        return False
    if await _expire_momo_deposit_if_due(d):
        return False
    if d.get("status") == "approved":
        return True
    provider_id = str(d.get("mbiyo_transaction_id") or "")
    if not provider_id:
        return False
    cfg = await get_mbiyo_config(decrypt=True)
    response = await mbiyo.MbiyoClient(
        cfg.get("_api_key", ""), cfg.get("base_url", mbiyo.BASE_URL)
    ).status(provider_id)
    status = mbiyo.status_value(response)
    data = response.get("data") if isinstance(response.get("data"), dict) else response

    def response_value(*keys: str):
        return _provider_scalar(response, *keys)
    expected_amount = d.get("processed_amount", d.get("amount"))
    checks = {
        "currency": (response_value("currency"), d.get("currency")),
        "country_code": (response_value("country_code", "country"),
                         d.get("country")),
        "network": (response_value("network"), (d.get("operator_snapshot") or {}).get("network")),
        "phone_number": (response_value("phone_number", "customer_phone"),
                         d.get("phone_number")),
        "amount": (response_value("amount", "paid_amount", "transaction_amount"),
                   d.get("provider_submitted_amount", expected_amount)),
        "order_id": (response_value("order_id", "merchant_reference", "reference"),
                     d.get("id")),
    }
    for key, (received, expected) in checks.items():
        if received in (None, "") or expected in (None, ""):
            binding_already_verified = d.get("provider_binding_verified") is True
            if key in {"amount", "currency", "order_id"} and not binding_already_verified:
                await db.momo_deposits.update_one(
                    {"id": dep_id, "status": "pending"},
                    {"$set": {"status": "quarantined",
                              "reconciliation_mismatch": f"missing_{key}"}},
                )
                return False
            continue
        if key == "phone_number":
            mismatch = re.sub(r"\D", "", str(received))[-12:] != re.sub(r"\D", "", str(expected))[-12:]
        elif key == "amount":
            mismatch = abs(float(received) - float(expected)) > 1e-9
        else:
            mismatch = str(received).upper() != str(expected).upper()
        if mismatch:
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {"status": "quarantined", "reconciliation_mismatch": key}},
            )
            return False
    await db.momo_deposits.update_one(
        {"id": dep_id, "status": {"$ne": "approved"}},
        {"$set": _mbiyo_response_fields(response)},
    )
    await db.momo_deposits.update_one(
        {"id": dep_id, "status": {"$ne": "approved"}},
        {"$set": {"provider_status": status or "pending"}},
    )
    if status in mbiyo.SUCCESS_STATUSES:
        fresh = await db.momo_deposits.find_one({"id": dep_id}, {"_id": 0})
        if fresh:
            await _credit_momo_deposit(fresh)
        return True
    if status in mbiyo.FAILURE_STATUSES:
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": {"$ne": "approved"}},
            {"$set": {"status": "failed", "retryable": False}},
        )
    return False


async def _paydunya_reconcile_loop() -> None:
    """Repair paid deposits even when the browser and provider callback vanish."""
    while True:
        try:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
            cursor = db.momo_deposits.find(
                {
                    "provider": {"$in": ["paydunya", "mbiyo"]},
                    "created_at": {"$gt": cutoff},
                    "$or": [
                        {"status": "pending"},
                        {"status": "failed", "retryable": True},
                    ],
                },
                {"_id": 0, "id": 1, "provider": 1},
            ).sort("created_at", -1).limit(50)
            async for deposit in cursor:
                try:
                    if deposit.get("provider") == "mbiyo":
                        await _reconcile_mbiyo_deposit(deposit["id"])
                    else:
                        await _reconcile_momo_deposit(deposit["id"])
                except Exception:
                    logger.exception(
                        "Mobile Money deposit reconciliation failed for %s",
                        deposit.get("id"),
                    )
            due = now_iso()
            tokenless_grace = (
                datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
            withdrawal_cursor = db.transactions.find(
                {
                    "type": "transfer",
                    "metadata.transfer_type": "biz_to_mobile",
                    "status": {"$in": ["pending", "refund_pending"]},
                    "$or": [
                        {"status": "refund_pending"},
                        {"metadata.next_reconcile_at": {"$exists": False}},
                        {"metadata.next_reconcile_at": {"$lte": due}},
                    ],
                },
                {"_id": 0},
            ).sort("created_at", 1).limit(100)
            async for withdrawal in withdrawal_cursor:
                try:
                    withdrawal_meta = withdrawal.get("metadata") or {}
                    if withdrawal.get("status") == "refund_pending":
                        await _refund_mobile_withdrawal(
                            withdrawal["id"],
                            withdrawal_meta.get("failure_reason", ""))
                    elif withdrawal_meta.get("provider") == "mbiyo":
                        if withdrawal_meta.get("mbiyo_transaction_id"):
                            await _reconcile_mbiyo_withdrawal(withdrawal)
                        else:
                            await db.transactions.update_one(
                                {"id": withdrawal["id"], "status": "pending"},
                                {"$set": {"metadata.next_reconcile_at": (
                                    datetime.now(timezone.utc)
                                    + timedelta(seconds=60)).isoformat()}})
                    elif (withdrawal_meta.get("provider") == "paydunya"
                          and withdrawal_meta.get("paydunya_invoice_token")):
                        await _reconcile_mobile_withdrawal(withdrawal)
                    elif withdrawal_meta.get("paydunya_invoice_token"):
                        # Legacy PayDunya transactions created before the
                        # provider marker was added.
                        await _reconcile_mobile_withdrawal(withdrawal)
                    else:
                        debit_marker = await db.users.find_one(
                            {"id": withdrawal["user_id"],
                             "withdrawal_debit_ids": withdrawal["id"]},
                            {"_id": 0, "id": 1})
                        phase_at = (withdrawal_meta.get("debit_applied_at")
                                    or withdrawal_meta.get("debit_pending_at")
                                    or withdrawal.get("created_at", ""))
                        if debit_marker:
                            await db.transactions.update_one(
                                {"id": withdrawal["id"], "status": "pending"},
                                {"$set": {
                                    "metadata.debit_applied": True,
                                    "metadata.debit_phase": "applied",
                                    "metadata.debit_applied_at": phase_at,
                                }})
                            if phase_at and phase_at <= tokenless_grace:
                                await _refund_mobile_withdrawal(
                                    withdrawal["id"],
                                    "provider_token_not_created")
                        elif phase_at and phase_at <= tokenless_grace:
                            await db.transactions.update_one(
                                {"id": withdrawal["id"], "status": "pending"},
                                {"$set": {
                                    "status": "failed",
                                    "metadata.debit_phase": "not_applied",
                                    "metadata.failure_reason":
                                        "wallet_debit_not_applied",
                                }})
                except Exception:
                    attempts = int((withdrawal.get("metadata") or {}).get(
                        "reconcile_attempts", 0)) + 1
                    delay = min(30 * (2 ** min(attempts - 1, 5)), 900)
                    await db.transactions.update_one(
                        {"id": withdrawal["id"],
                         "status": {"$in": ["pending", "refund_pending"]}},
                        {"$set": {
                            "metadata.next_reconcile_at": (
                                datetime.now(timezone.utc)
                                + timedelta(seconds=delay)).isoformat(),
                            "metadata.reconcile_attempts": attempts,
                        }})
                    logger.exception(
                        "PayDunya withdrawal reconciliation failed for %s",
                        withdrawal.get("id"),
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("PayDunya background reconciliation cycle failed")
            try:
                await postgres_store.close()
                await postgres_store.connect()
            except Exception:
                logger.exception("Unable to restore the reconciliation database pool")
        await asyncio.sleep(30)


async def _claim_momo_flag(dep_id: str, flag: str) -> bool:
    """Claim a non-wallet side effect exactly once."""
    result = await db.momo_deposits.update_one(
        {"id": dep_id, flag: {"$ne": True}},
        {"$set": {flag: True, f"{flag}_claimed_at": now_iso()}})
    return result.modified_count > 0


async def _claim_transaction_flag(transaction_id: str, flag: str) -> bool:
    """Claim a supported transaction side effect exactly once."""
    if flag not in {"merchant_webhook_claimed", "merchant_failure_webhook_claimed"}:
        raise ValueError("Unsupported transaction claim flag")
    result = await db.transactions.update_one(
        {"id": transaction_id, flag: {"$ne": True}},
        {"$set": {flag: True, f"{flag}_claimed_at": now_iso()}},
    )
    return result.modified_count > 0


async def _upsert_momo_ledger(d: dict, *, amount: float, currency: str,
                              description: str, ledger_id: str,
                              metadata: dict, tx_type: str = "deposit") -> None:
    """Repairable deterministic ledger write (safe after a process crash)."""
    doc = {
        "id": ledger_id, "user_id": d["user_id"], "type": tx_type,
        "direction": "in", "amount": amount, "currency": currency,
        "status": "completed", "reference": f"BTP-PD-{d['id'][:16]}",
        "description": description, "created_at": d.get("created_at", now_iso()),
        "metadata": metadata,
    }
    try:
        await db.transactions.create_index("id", unique=True)
    except Exception:
        pass
    # A provider callback or an earlier reconciliation attempt can leave the
    # deterministic ledger row pending before the wallet credit is applied.
    # Repair that row when the credit succeeds so the dashboard cannot show a
    # stale pending status after the balance has already changed.
    await db.transactions.update_one(
        {"id": ledger_id},
        {
            "$setOnInsert": doc,
            "$set": {
                "status": "completed",
                "amount": amount,
                "currency": currency,
                "description": description,
                "metadata": metadata,
            },
        },
        upsert=True,
    )


async def _credit_momo_deposit(d: dict) -> None:
    """Crash-safe exactly-once wallet credit without Mongo transactions.

    The user update is the idempotency barrier: Mongo atomically evaluates the
    absent deposit id and performs both the increment and set insertion.  A
    retry after a crash repairs the deterministic ledger and status but cannot
    increment again.
    """
    dep_id, uid = d["id"], d["user_id"]
    currency = (d.get("currency") or "XOF").upper()
    gross = float(d.get("requested_amount", d.get("amount", 0)))
    gateway_fee = float(d.get("gateway_fee", 0))
    platform_fee = float(d.get("platform_fee", 0))
    fee = float(d.get("total_fee", gateway_fee + platform_fee))
    net = float(d.get("wallet_credit_amount", gross))
    field = f"balance_{currency.lower()}"
    mbiyo_currencies = {currency for currencies in mbiyo.CURRENCIES.values()
                        for currency in currencies}
    allowed = (mbiyo_currencies if d.get("provider") == "mbiyo"
               else PAYDUNYA_WALLET_CURRENCIES)
    if currency not in allowed:
        logger.error("Refusing gateway credit in unsupported currency %s", currency)
        return

    credited = await db.users.update_one(
        {"id": uid, "credited_deposit_ids": {"$ne": dep_id}},
        {"$inc": {field: net}, "$addToSet": {"credited_deposit_ids": dep_id}},
    )
    if credited.modified_count == 0:
        user = await db.users.find_one({"id": uid}, {"_id": 0, "credited_deposit_ids": 1})
        if not user or dep_id not in (user.get("credited_deposit_ids") or []):
            return

    metadata = {
        "provider": d.get("provider") or ("fedapay" if d.get("fedapay_id") else "paydunya"),
        "paydunya_token": d.get("paydunya_token"),
        "paydunya_reference": d.get("paydunya_reference") or d.get("fedapay_reference"),
        "operator": d.get("operator"),
        "operator_name": d.get("operator_name")
            or (d.get("operator_snapshot") or {}).get("name"),
        "country": d.get("country"),
        "country_code": d.get("country"),
        "country_label": d.get("country_label")
            or (d.get("operator_snapshot") or {}).get("country_label"),
        "phone_number": d.get("phone_number"),
        "customer_name": d.get("full_name"),
        "customer_email": d.get("email"),
        "provider_reference": d.get("paydunya_reference")
            or d.get("fedapay_reference") or d.get("mbiyo_transaction_id"),
        "amount_gross": gross,
        "charged_amount": d.get("charged_amount"), "fee": fee,
        "gateway_fee": gateway_fee, "platform_fee": platform_fee,
        "amount_net": net, "method": "mobile_money",
        "receipt_url": d.get("receipt_url"),
    }
    if d.get("source") != "link_payment":
        await _upsert_momo_ledger(
            d, amount=net, currency=currency,
            description=f"Dépôt Mobile Money ({d.get('operator')})",
            ledger_id=f"{d.get('provider', 'paydunya')}-deposit-{dep_id}",
            metadata=metadata)
    await db.momo_deposits.update_one(
        {"id": dep_id, "status": {"$in": ["pending", "approved", "failed"]}},
        {"$set": {"status": "approved", "approved_at": now_iso(),
                  "amount_gross": gross, "fee": fee,
                  "gateway_fee": gateway_fee, "platform_fee": platform_fee,
                  "amount_net": net}})

    if await _claim_momo_flag(dep_id, "notification_claimed"):
        await notify(uid, "deposit_success", "Dépôt Mobile Money confirmé",
                     f"Votre dépôt de {gross:,.0f} {currency} a été crédité.",
                     data={"deposit_id": dep_id, "amount": net, "currency": currency})
        await db.momo_deposits.update_one(
            {"id": dep_id}, {"$set": {"notification_sent": True}})
    if d.get("source") == "merchant_api" and await _claim_momo_flag(dep_id, "webhook_claimed"):
        await _deliver_webhook(uid, "mobile_money.payment.approved", {
            "payment_id": dep_id, "reference": d.get("reference"),
            "amount": _format_amount(gross), "amount_gross": _format_amount(gross),
            "amount_net": _format_amount(net), "fee": _format_amount(fee),
            "gateway_fee": _format_amount(gateway_fee),
            "platform_fee": _format_amount(platform_fee), "currency": currency,
            "country": d.get("country"), "operator": d.get("operator"),
            "customer_email": d.get("email"), "customer_phone": d.get("phone_number"),
            "provider_reference": d.get("paydunya_reference")
                or d.get("fedapay_reference") or d.get("mbiyo_transaction_id"),
            "approved_at": _format_iso(datetime.now(timezone.utc))})
        await db.momo_deposits.update_one(
            {"id": dep_id}, {"$set": {"webhook_sent": True}})
    elif d.get("source") == "link_payment" and d.get("link_payment_id"):
        await db.link_payments.update_one(
            {"id": d["link_payment_id"], "status": "pending"},
            {"$set": {"status": "paid", "paid_at": now_iso(),
                      "amount_net": net, "fee": fee}})
        await db.momo_deposits.update_one(
            {"id": dep_id}, {"$set": {"link_payment_claimed": True}})
        lp = await db.link_payments.find_one({"id": d["link_payment_id"]}, {"_id": 0})
        if lp:
            await _upsert_momo_ledger(
                d, amount=net, currency=currency,
                description=f"Paiement lien {lp.get('slug')}",
                ledger_id=f"paydunya-link-{dep_id}",
                metadata={**metadata, "link_id": lp["link_id"],
                          "link_payment_id": lp["id"]}, tx_type="link_payment")
        if lp:
            if lp.get("single_use_claim_id"):
                await db.payment_links.update_one(
                    {"id": lp["link_id"],
                     "single_use_claim_id": lp["single_use_claim_id"]},
                    {"$set": {"active": False}},
                )
            # The merchant link counter gets its own idempotency barrier so a
            # crash between this update and the deposit flag cannot lose the
            # accounting side effect or count it twice.
            await db.payment_links.update_one(
                {"id": lp["link_id"], "paydunya_payment_ids": {"$ne": dep_id}},
                {"$inc": {"paid_count": 1, "total_amount": gross},
                 "$addToSet": {"paydunya_payment_ids": dep_id}})
            await db.momo_deposits.update_one(
                {"id": dep_id}, {"$set": {"link_stats_claimed": True}})


async def _legacy_credit_momo_deposit_fedapay(d: dict) -> None:
    """Deprecated compatibility shim for old FedaPay webhook rows."""
    # Existing FedaPay rows are not routed through the PayDunya flow.  Keep
    # the old function name available for deployments with historical rows,
    # but apply their creation-time values rather than current tariffs.
    if d.get("provider") == "paydunya":
        return await _credit_momo_deposit(d)
    gross = float(d.get("amount", 0))
    fee = float(d.get("fee", round(
        gross * float(d.get("fee_pct_applied", 0)) / 100, 2)))
    old = dict(d)
    old.update({
        "requested_amount": gross, "charged_amount": gross,
        "gateway_fee": float(d.get("gateway_fee", fee)),
        "platform_fee": float(d.get("platform_fee", 0)),
        "total_fee": fee, "wallet_credit_amount": float(d.get("amount_net", gross - fee)),
    })
    return await _credit_momo_deposit(old)


def _public_momo_deposit(d: dict) -> dict:
    """Expose only generic challenge/status fields to a dashboard client."""
    flow = d.get("payment_flow") or {}
    auth_mode = d.get("auth_mode")
    expiry = _momo_pending_expiry(d)
    pending_remaining_seconds = (
        max(0, math.ceil((expiry - datetime.now(timezone.utc)).total_seconds()))
        if expiry else None
    )
    return {
        "id": d.get("id"), "status": d.get("status"),
        "created_at": d.get("created_at"),
        "pending_expires_at": d.get("pending_expires_at"),
        "pending_remaining_seconds": pending_remaining_seconds,
        "amount": d.get("amount"), "requested_amount": d.get("requested_amount"),
        "charged_amount": d.get("charged_amount"),
        "amount_net": d.get("amount_net") or d.get("wallet_credit_amount"),
        "gateway_fee": d.get("gateway_fee"), "platform_fee": d.get("platform_fee"),
        "total_fee": d.get("total_fee") or d.get("fee"),
        "fee_bearer": d.get("fee_bearer"), "currency": d.get("currency"),
        "operator": {"code": d.get("operator"), "label": d.get("operator_name")},
        "operator_name": d.get("operator_name"),
        "phone_number": d.get("phone_number"),
        "payment_flow": flow, "auth_mode": auth_mode,
        "otp_required": bool(d.get("otp_required") or auth_mode == "pin"),
        "challenge_status": (
            "required" if auth_mode == "pin" else
            "completed" if d.get("status") in ("approved", "paid") else "pending"
        ),
        "instructions": _plain_payment_instructions(d.get("instructions")),
        "checkout_url": d.get("redirect_url") or d.get("checkout_url"),
        "redirect_url": d.get("redirect_url") or d.get("checkout_url"),
        "payment_kind": (
            "redirect"
            if d.get("payment_fallback") == "hosted_checkout"
            or d.get("redirect_url")
            else "phone"
        ),
        "payment_fallback": d.get("payment_fallback"),
        "submission_unknown": bool(d.get("submission_unknown")),
        "prompt_sent": bool(d.get("prompt_sent")),
        "prompt_error": _public_payment_error(d.get("prompt_error")),
        "failed_reason": _public_payment_error(
            d.get("failed_reason") or d.get("prompt_error")
        ),
    }


@api.get("/deposits/mobile-money/pending")
async def get_latest_pending_momo_deposit(
    uid: str = Depends(get_current_user_id),
):
    """Restore the user's latest in-flight Mobile Money payment after refresh."""
    docs = await db.momo_deposits.find(
        {
            "user_id": uid,
            "provider": {"$in": ["mbiyo", "paydunya"]},
            "status": "pending",
            "created_at": {
                "$gt": (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
            },
        },
        {"_id": 0},
    ).sort("created_at", -1).limit(1).to_list(1)
    if not docs:
        return None
    d = docs[0]
    if d.get("provider") == "mbiyo" and d.get("status") == "pending":
        try:
            await _reconcile_mbiyo_deposit(d["id"])
        except Exception:
            logger.exception("Latest Mbiyo deposit reconciliation failed for %s", d.get("id"))
        d = await db.momo_deposits.find_one({"id": d["id"], "user_id": uid}, {"_id": 0}) or d
    return _public_momo_deposit(d)


@api.get("/deposits/mobile-money/{deposit_id}")
async def get_momo_deposit(deposit_id: str, uid: str = Depends(get_current_user_id)):
    d = await db.momo_deposits.find_one({"id": deposit_id, "user_id": uid}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Not found")
    if d.get("provider") == "mbiyo" and d.get("status") == "pending":
        try:
            await _reconcile_mbiyo_deposit(deposit_id)
        except Exception:
            logger.exception("Mbiyo status reconciliation failed for %s", deposit_id)
        d = await db.momo_deposits.find_one({"id": deposit_id, "user_id": uid}, {"_id": 0}) or d
    elif d.get("status") in ("pending", "approved") or (
            d.get("status") == "failed" and d.get("retryable")):
        await _reconcile_momo_deposit(deposit_id)
        d = await db.momo_deposits.find_one({"id": deposit_id, "user_id": uid}, {"_id": 0}) or d
    return _public_momo_deposit(d)


class MomoChallengeFinalizeRequest(BaseModel):
    otp: str = Field(..., min_length=1, max_length=64)


@api.post("/deposits/mobile-money/{deposit_id}/finalize")
async def finalize_momo_deposit(
    deposit_id: str,
    req: MomoChallengeFinalizeRequest,
    uid: str = Depends(get_current_user_id),
):
    d = await db.momo_deposits.find_one(
        {"id": deposit_id, "user_id": uid, "status": "pending"}, {"_id": 0}
    )
    if not d:
        raise HTTPException(404, "Dépôt introuvable ou déjà terminé")
    if d.get("auth_mode") != "pin" and not (
        d.get("endpoint_slug") == "wizall-money-senegal"
    ):
        raise HTTPException(409, "Cette transaction ne demande pas de code de finalisation")
    provider_ref = str(
        d.get("mbiyo_transaction_id") or d.get("provider_reference")
        or d.get("paydunya_reference") or ""
    )
    if not provider_ref:
        raise HTTPException(409, "Référence de transaction indisponible")
    try:
        if d.get("provider") == "mbiyo":
            cfg = await get_mbiyo_config(decrypt=True)
            response = await mbiyo.MbiyoClient(
                cfg.get("_api_key", ""), cfg.get("base_url", mbiyo.BASE_URL)
            ).finalize(provider_ref, req.otp)
        else:
            cfg = await get_paydunya_config(decrypt=True)
            response = await paydunya.wizall_confirm(
                cfg, authorization_code=req.otp,
                phone=str(d.get("phone_number") or ""),
                transaction_id=provider_ref,
            )
    except (mbiyo.MbiyoError, paydunya.PayDunyaError) as exc:
        raise HTTPException(400 if exc.status < 500 else 502,
                            "Le code de validation n’a pas été accepté.")
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    status = mbiyo.status_value(response) if d.get("provider") == "mbiyo" else ""
    fields = {
        "provider_response": {
            "transaction_id": _provider_reference(response),
            "status": status or data.get("status"),
        },
        "auth_mode": None,
        "challenge_status": "submitted",
        "instructions": _plain_payment_instructions(data.get("instructions")),
    }
    if _provider_reference(response):
        fields["provider_reference"] = _provider_reference(response)
    await db.momo_deposits.update_one({"id": deposit_id, "status": "pending"},
                                      {"$set": fields})
    fresh = await db.momo_deposits.find_one({"id": deposit_id}, {"_id": 0}) or d
    return _public_momo_deposit(fresh)


@api.get("/deposits/paydunya/return")
async def paydunya_payment_return(token: str = "", ref: str = ""):
    """Confirm a hosted payment before returning to the dashboard."""
    lookup = (
        {"provider": "paydunya", "id": ref}
        if ref else
        {"provider": "paydunya", "paydunya_token": token}
    )
    d = await db.momo_deposits.find_one(lookup, {"_id": 0})
    if not d:
        return RedirectResponse(
            url="/dashboard?paydunya=not_found", status_code=303)
    for attempt in range(3):
        if await _reconcile_momo_deposit(d["id"]):
            return RedirectResponse(
                url="/dashboard?paydunya=completed", status_code=303)
        if attempt < 2:
            await asyncio.sleep(1)
    return RedirectResponse(
        url="/dashboard?paydunya=pending", status_code=303)


@api.post("/webhooks/paydunya")
async def paydunya_webhook(request: Request):
    """PayDunya form webhook.

    PayDunya signs the static form hash with SHA-512(master key), rather than
    using a configurable webhook secret.  We still confirm the invoice over
    the API before changing any wallet balance.
    """
    try:
        form = dict(await request.form())
    except Exception:
        raw = await request.body()
        try:
            form = json.loads(raw)
        except Exception:
            from urllib.parse import parse_qs
            form = {k: v[-1] for k, v in parse_qs(raw.decode()).items()}
    payload, supplied_hash = paydunya.parse_webhook(form)
    cfg = await get_paydunya_config(decrypt=True)
    master = (cfg.get("_credentials") or {}).get("master_key", "")
    if not paydunya.verify_static_hash(supplied_hash or payload.get("hash", ""), master):
        raise HTTPException(400, "Invalid PayDunya webhook hash")
    token = paydunya.invoice_token(payload)
    dep = await db.momo_deposits.find_one(
        {"provider": "paydunya", "paydunya_token": token}, {"_id": 0})
    event_id = f"paydunya:{token}:{payload.get('status', '')}:{payload.get('response_code', '')}"
    prior_event = await db.webhook_events.find_one(
        {"event_id": event_id}, {"_id": 0, "processed": 1})
    if prior_event and prior_event.get("processed"):
        return {"received": True, "duplicate": True}
    try:
        await db.webhook_events.create_index("event_id", unique=True, sparse=True)
    except Exception:
        pass
    if not prior_event:
        try:
            await db.webhook_events.insert_one({
                "event_id": event_id, "type": "paydunya",
                "payload": payload, "received_at": now_iso(), "processed": False})
        except Exception:
            # A concurrent callback may have won the unique insert.  It is
            # safe to continue and let the pending->approved guard decide.
            prior_event = await db.webhook_events.find_one(
                {"event_id": event_id}, {"_id": 0, "processed": 1})
            if prior_event and prior_event.get("processed"):
                return {"received": True, "duplicate": True}
    confirmed = False
    if dep and dep.get("status") in ("pending", "approved", "failed"):
        confirmed = await _reconcile_momo_deposit(dep["id"])
    if confirmed:
        await db.webhook_events.update_one(
            {"event_id": event_id}, {"$set": {"processed": True, "processed_at": now_iso()}})
    return {"received": True}


@api.api_route("/webhooks/mbiyo", methods=["GET", "POST", "HEAD"])
async def mbiyo_webhook(request: Request, ref: str = Query("")):
    """Signed, idempotent Mbiyo callback. Status is re-read from Mbiyo."""
    if request.method == "HEAD":
        return {"ok": True}
    raw = await request.body()
    cfg = await get_mbiyo_config(decrypt=True)
    signature = (
        request.headers.get("Signature")
        or request.headers.get("X-Mbiyo-Signature")
        or request.headers.get("X-Signature")
        or ""
    )
    if not mbiyo.verify_signature(raw, signature, cfg.get("_webhook_secret", "")):
        raise HTTPException(400, "Signature Mbiyo invalide")
    try:
        content_type = str(request.headers.get("content-type") or "").lower()
        if "application/x-www-form-urlencoded" in content_type:
            from urllib.parse import parse_qs
            payload = {
                key: values[-1] if len(values) == 1 else values
                for key, values in parse_qs(raw.decode("utf-8")).items()
            }
        else:
            payload = json.loads(raw or b"{}")
    except Exception:
        raise HTTPException(400, "Payload Mbiyo invalide")
    provider_id = str(_mbiyo_transaction_id(payload) or "")
    if not provider_id and ref:
        local_tx = await db.transactions.find_one(
            {"id": ref, "metadata.provider": "mbiyo"},
            {"_id": 0, "metadata.mbiyo_transaction_id": 1},
        )
        local_dep = await db.momo_deposits.find_one(
            {"id": ref, "provider": "mbiyo"},
            {"_id": 0, "mbiyo_transaction_id": 1},
        )
        provider_id = str(
            (local_tx or {}).get("metadata", {}).get("mbiyo_transaction_id")
            or (local_dep or {}).get("mbiyo_transaction_id")
            or ""
        )
    if not provider_id:
        return {"received": True}
    provider_event_id = _provider_scalar(payload, "event_id", "eventId", "webhook_id")
    payload_digest = hashlib.sha256(raw).hexdigest()[:24]
    event_id = (
        f"mbiyo:event:{provider_event_id}"
        if provider_event_id else f"mbiyo:{provider_id}:{payload_digest}"
    )
    try:
        await db.webhook_events.create_index("event_id", unique=True, sparse=True)
        await db.webhook_events.insert_one({"event_id": event_id, "type": "mbiyo",
                                            "payload": payload, "processed": False,
                                            "received_at": now_iso()})
    except DuplicateKeyError:
        existing = await db.webhook_events.find_one({"event_id": event_id, "processed": True})
        if existing:
            return {"received": True, "duplicate": True}
        # An earlier delivery may have arrived before its local transaction
        # could be bound. Keep retrying the same verified event.
    try:
        verified = await mbiyo.MbiyoClient(
            cfg.get("_api_key", ""), cfg.get("base_url", mbiyo.BASE_URL)).status(provider_id)
    except mbiyo.MbiyoError:
        raise HTTPException(503, "Vérification Mbiyo temporairement indisponible")
    status = mbiyo.status_value(verified)
    dep = await db.momo_deposits.find_one(
        {"provider": "mbiyo", "mbiyo_transaction_id": provider_id}, {"_id": 0})
    tx = await db.transactions.find_one(
        {"metadata.provider": "mbiyo",
         "metadata.mbiyo_transaction_id": provider_id}, {"_id": 0})
    verified_order_id = str(_provider_scalar(
        verified, "order_id", "merchant_reference", "reference") or "")
    # A transport failure can hide the provider transaction ID from the
    # initiation response. The signed callback carries both that ID and our
    # local order ID, allowing a one-time, server-verified binding.
    if not dep and not tx and ref and hmac.compare_digest(verified_order_id, ref):
        dep = await db.momo_deposits.find_one(
            {"id": ref, "provider": "mbiyo", "status": "pending",
             "mbiyo_transaction_id": {"$in": [None, ""]}},
            {"_id": 0},
        )
        if dep:
            await db.momo_deposits.update_one(
                {"id": ref, "provider": "mbiyo", "status": "pending",
                 "mbiyo_transaction_id": {"$in": [None, ""]}},
                {"$set": {"mbiyo_transaction_id": provider_id,
                          "provider_reference": provider_id,
                          "provider_binding_verified": True,
                          "submission_unknown": False}},
            )
            dep["mbiyo_transaction_id"] = provider_id
        else:
            tx = await db.transactions.find_one(
                {"id": ref, "metadata.provider": "mbiyo", "status": "pending",
                 "metadata.mbiyo_transaction_id": {"$in": [None, ""]}},
                {"_id": 0},
            )
            if tx:
                await db.transactions.update_one(
                    {"id": ref, "metadata.provider": "mbiyo", "status": "pending",
                     "metadata.mbiyo_transaction_id": {"$in": [None, ""]}},
                    {"$set": {"metadata.mbiyo_transaction_id": provider_id,
                              "metadata.submission_unknown": False}},
                )
                tx.setdefault("metadata", {})["mbiyo_transaction_id"] = provider_id
    matched = bool(dep or tx)
    if dep:
        await _reconcile_mbiyo_deposit(dep["id"])
    if tx:
        await _reconcile_mbiyo_withdrawal(tx)
    if matched:
        await db.webhook_events.update_one(
            {"event_id": event_id},
            {"$set": {"processed": True, "processed_at": now_iso()}})
    return {"received": True}


@api.head("/webhooks/paydunya/disbursement")
@api.get("/webhooks/paydunya/disbursement")
@api.post("/webhooks/paydunya/disbursement")
async def paydunya_disbursement_webhook(request: Request, ref: str = Query("")):
    """Receive a payout notification, then verify it with PayDunya.

    Callback fields are deliberately ignored for settlement.  PayDunya's
    status endpoint is the source of truth, which prevents a forged callback
    from completing a withdrawal.
    """
    if not ref:
        raise HTTPException(400, "Missing withdrawal reference")
    tx = await db.transactions.find_one(
        {"reference": ref, "type": "transfer",
         "metadata.transfer_type": "biz_to_mobile",
         "metadata.provider": {"$ne": "mbiyo"}}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Withdrawal not found")
    if tx.get("status") in ("completed", "failed"):
        return {"received": True, "status": tx["status"]}
    try:
        outcome = await _reconcile_mobile_withdrawal(tx)
    except paydunya.PayDunyaError:
        # A callback is a notification; a temporary verification outage must
        # be retried rather than treated as a provider failure.
        raise HTTPException(503, "PayDunya status verification unavailable")
    except Exception:
        raise HTTPException(503, "PayDunya status verification unavailable")
    return {"received": True, "status": outcome}


@api.post("/webhooks/fedapay")
async def fedapay_webhook(request: Request):
    """Receive signed webhooks from FedaPay."""
    raw = await request.body()
    sig = request.headers.get("X-FEDAPAY-SIGNATURE") or request.headers.get("x-fedapay-signature")
    try:
        event = fedapay.verify_webhook(raw, sig)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Invalid webhook: {e}")

    ev_name = event.get("name") or event.get("event") or event.get("type") or ""
    entity = event.get("entity") or event.get("data") or {}
    eid = str(event.get("id") or entity.get("id") or "")

    # Deduplicate
    try:
        await db.webhook_events.insert_one({
            "event_id": f"fedapay:{eid}:{ev_name}",
            "type": ev_name,
            "payload": event,
            "received_at": now_iso(),
            "processed": False,
        })
    except DuplicateKeyError:
        return {"received": True, "duplicate": True}

    try:
        if ev_name in ("transaction.approved",):
            tx_id = entity.get("id")
            d = await db.momo_deposits.find_one({"fedapay_id": tx_id})
            if d:
                await _legacy_credit_momo_deposit_fedapay(d)
        elif ev_name in ("transaction.canceled", "transaction.declined", "transaction.refunded"):
            tx_id = entity.get("id")
            d = await db.momo_deposits.find_one({"fedapay_id": tx_id})
            await db.momo_deposits.update_one(
                {"fedapay_id": tx_id, "status": "pending"},
                {"$set": {"status": "failed",
                          "failed_reason": ev_name.split(".", 1)[-1],
                          "failed_at": now_iso()}}
            )
            if d and d.get("source") == "merchant_api":
                reason = ev_name.split(".", 1)[-1]
                event = f"mobile_money.payment.{reason}"  # canceled | declined | refunded
                await _deliver_webhook(d["user_id"], event, {
                    "payment_id": d["id"], "reference": d.get("reference"),
                    "amount": _format_amount(d.get("amount", 0)),
                    "currency": d.get("currency"),
                    "country": d.get("country"),
                    "operator": d.get("operator"),
                    "reason": reason,
                })
        elif ev_name in ("payout.sent",):
            po_id = entity.get("id")
            tx = await db.transactions.find_one({"metadata.fedapay_payout_id": po_id})
            if tx and tx.get("status") != "completed":
                await db.transactions.update_one(
                    {"id": tx["id"]},
                    {"$set": {"status": "completed",
                              "metadata.fedapay_status": "sent"}}
                )
                await notify(tx["user_id"], "withdrawal_success",
                             "Retrait Mobile Money confirmé",
                             f"Votre retrait de {tx['amount']:,.0f} {tx.get('currency','')} a été envoyé au bénéficiaire.",
                             data={"transaction_id": tx["id"], "reference": tx.get("reference"),
                                   "amount": tx["amount"], "transfer_type": "biz_to_mobile"})
        elif ev_name in ("payout.failed", "payout.canceled"):
            po_id = entity.get("id")
            tx = await db.transactions.find_one({"metadata.fedapay_payout_id": po_id})
            if tx and tx.get("status") not in ("failed", "completed"):
                meta = tx.get("metadata") or {}
                total_debit = float(meta.get("total_debit", tx.get("amount", 0)))
                currency = tx.get("currency", "XOF")
                field = f"balance_{currency.lower()}"
                await _refund_wallet_once(
                    tx["user_id"], field, total_debit,
                    f"fedapay-payout:{tx['id']}")
                await db.transactions.update_one(
                    {"id": tx["id"]},
                    {"$set": {"status": "failed",
                              "metadata.fedapay_status": ev_name.split(".", 1)[-1],
                              "metadata.refunded": True}}
                )
                await notify(tx["user_id"], "withdrawal_failed",
                             "Retrait Mobile Money échoué",
                             "Votre retrait a échoué. Le montant a été remboursé sur votre portefeuille.",
                             data={"transaction_id": tx["id"], "reference": tx.get("reference")})
    except Exception as e:
        logger.exception("fedapay webhook processing error: %s", e)

    return {"received": True}


# ==================== IZICHANGEPAY WEBHOOK ====================
async def _crypto_fee_pct(coin: str) -> float:
    """Return the DEPOSIT fee percentage (as a float, e.g. 4.0) configured
    in the Admin Panel for a given coin. Falls back to transfer_config
    (retro-compat for pre-split installs) then to 4.0.
    Used only for incoming crypto (deposits, link payments, merchant API pay-in).
    Outgoing crypto (biz_to_crypto payouts) reads transfer_config.crypto.fees
    directly.
    """
    coin_up = (coin or "").upper()
    dep_cfg = await get_deposit_config()
    dep_fees = (((dep_cfg.get("crypto") or {}).get("fees")) or {})
    if coin_up in dep_fees:
        return float(dep_fees[coin_up])
    cfg = await get_transfer_config()
    fees = ((cfg.get("crypto") or {}).get("fees") or {})
    return float(fees.get(coin_up, 4.0))


def _apply_fee(amount: float, fee_pct: float) -> tuple[float, float]:
    """Return (fee, net) — fee = amount * pct/100, net = amount - fee.
    All values rounded to 6 decimals for USDT/crypto precision.
    """
    fee = round(float(amount) * (float(fee_pct) / 100.0), 6)
    net = round(float(amount) - fee, 6)
    return fee, net


async def _crypto_platform_fee(coin: str, direction: str, gross: float) -> tuple[float, float]:
    """Return (gateway_fee, platform_fee) in amount for a crypto tx.
    direction = "deposit" reads deposit_config.crypto, "withdrawal" reads
    transfer_config.crypto. Falls back to 0 platform if not configured.
    """
    coin_up = (coin or "").upper()
    if direction == "deposit":
        cfg = await get_deposit_config()
    else:
        cfg = await get_transfer_config()
    section = (cfg.get("crypto") or {})
    fees = section.get("fees") or {}
    fees_g = section.get("fees_gateway") or {}
    fees_p = section.get("fees_platform") or {}
    total = float(fees.get(coin_up, 4.0))
    gw_pct = float(fees_g[coin_up]) if coin_up in fees_g else total
    pf_pct = float(fees_p[coin_up]) if coin_up in fees_p else 0.0
    gateway_fee = round(float(gross) * (gw_pct / 100.0), 6)
    platform_fee = round(float(gross) * (pf_pct / 100.0), 6)
    return gateway_fee, platform_fee


def _momo_platform_fee(op_cfg: dict, gross: float) -> tuple[float, float]:
    """Return (gateway_fee, platform_fee) in amount for a MoMo tx from the
    operator config entry (deposit_config or transfer_config operators list).
    """
    total = float(op_cfg.get("fee_pct", 0) or 0)
    gw_pct = float(op_cfg.get("gateway_fee_pct", total)) if op_cfg.get("gateway_fee_pct") is not None else total
    pf_pct = float(op_cfg.get("platform_fee_pct", 0)) if op_cfg.get("platform_fee_pct") is not None else 0.0
    gateway_fee = round(float(gross) * (gw_pct / 100.0), 2)
    platform_fee = round(float(gross) * (pf_pct / 100.0), 2)
    return gateway_fee, platform_fee


async def _refund_mobile_withdrawal(tx_id: str, reason: str = "") -> bool:
    """Mark a mobile payout failed and refund its debit exactly once."""
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    if not tx or tx.get("type") != "transfer":
        return False
    meta = tx.get("metadata") or {}
    if tx.get("status") in ("completed", "failed") or meta.get("refunded"):
        return False
    if tx.get("status") == "pending":
        provider_status_field = (
            "metadata.mbiyo_status"
            if meta.get("provider") == "mbiyo"
            else "metadata.paydunya_status"
        )
        claimed = await db.transactions.update_one(
            {"id": tx_id, "status": "pending"},
            {"$set": {"status": "refund_pending",
                      provider_status_field: "failed",
                      "metadata.failure_reason": reason[:300]}})
        if not claimed.modified_count:
            tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
            if not tx or tx.get("status") != "refund_pending":
                return False
    elif tx.get("status") != "refund_pending":
        return False
    currency = str(tx.get("currency") or "XOF").upper()
    field = f"balance_{currency.lower()}"
    credited = await db.users.update_one(
        {"id": tx["user_id"], "withdrawal_refund_ids": {"$ne": tx_id}},
        {"$inc": {field: float(meta.get("total_debit", tx.get("amount", 0)))},
         "$addToSet": {"withdrawal_refund_ids": tx_id}})
    await db.transactions.update_one(
        {"id": tx_id, "status": "refund_pending"},
        {"$set": {"status": "failed", "metadata.refunded": True,
                  "metadata.refunded_at": now_iso()}})
    if credited.modified_count:
        await notify(tx["user_id"], "withdrawal_failed",
                     "Retrait Mobile Money échoué",
                     "Votre retrait a échoué. Le montant a été remboursé sur votre portefeuille.",
                     data={"transaction_id": tx_id, "reference": tx.get("reference")})
    if meta.get("source") == "merchant_api":
        claimed = await db.transactions.update_one(
            {"id": tx_id, "metadata.source": "merchant_api",
             "metadata.webhook_claimed": {"$ne": True}},
            {"$set": {"metadata.webhook_claimed": True}},
        )
        if claimed.modified_count:
            await _deliver_webhook(tx["user_id"], "push.failed", {
                "id": tx_id, "status": "failed", "amount": tx.get("amount"),
                "currency": tx.get("currency"), "reference": tx.get("reference"),
                "source": "merchant_api",
            })
    return True


async def _complete_mbiyo_withdrawal(tx_id: str, provider_status: str) -> bool:
    """Complete a verified Mbiyo payout exactly once."""
    current = await db.transactions.find_one({"id": tx_id}, {"_id": 0, "status": 1})
    if current and current.get("status") == "completed":
        await db.transactions.update_one(
            {"id": tx_id},
            {"$set": {"metadata.mbiyo_status": provider_status},
             "$unset": {"metadata.next_reconcile_at": ""}},
        )
        return True
    changed = await db.transactions.update_one(
        {"id": tx_id, "status": "pending"},
        {"$set": {
            "status": "completed",
            "metadata.mbiyo_status": provider_status,
            "metadata.completed_at": now_iso(),
        },
         "$unset": {"metadata.next_reconcile_at": ""}},
    )
    if not changed.modified_count:
        # Keep the verified provider state for diagnosis without silently
        # reversing a refund that may already have reached the wallet.
        await db.transactions.update_one(
            {"id": tx_id},
            {"$set": {"metadata.mbiyo_status": provider_status,
                      "metadata.reconciliation_conflict": True}},
        )
        return False
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    if tx:
        await notify(
            tx["user_id"], "withdrawal_success",
            "Retrait Mobile Money confirmé",
            f"Votre retrait de {tx.get('amount', 0):,.0f} {tx.get('currency', '')} a été envoyé au bénéficiaire.",
            data={"transaction_id": tx_id, "reference": tx.get("reference"),
                  "amount": tx.get("amount"), "transfer_type": "biz_to_mobile"},
        )
        if (tx.get("metadata") or {}).get("source") == "merchant_api":
            claimed = await db.transactions.update_one(
                {"id": tx_id, "metadata.source": "merchant_api",
                 "metadata.webhook_claimed": {"$ne": True}},
                {"$set": {"metadata.webhook_claimed": True}},
            )
            if claimed.modified_count:
                await _deliver_webhook(tx["user_id"], "push.succeeded", {
                    "id": tx_id, "status": "completed",
                    "amount": tx.get("amount"), "currency": tx.get("currency"),
                    "reference": tx.get("reference"), "source": "merchant_api",
                })
    return True


async def _reconcile_mbiyo_withdrawal(tx: dict) -> str:
    """Read a Mbiyo payout status and apply its idempotent terminal outcome."""
    if not tx:
        return ""
    meta = tx.get("metadata") or {}
    provider_id = str(meta.get("mbiyo_transaction_id") or "")
    if not provider_id:
        return "pending"
    cfg = await get_mbiyo_config(decrypt=True)
    response = await mbiyo.MbiyoClient(
        cfg.get("_api_key", ""), cfg.get("base_url", mbiyo.BASE_URL)
    ).status(provider_id)
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    meta = tx.get("metadata") or {}
    response_meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    def response_value(key: str):
        return data.get(key) if data.get(key) not in (None, "") else response_meta.get(key)
    checks = {
        "currency": (response_value("currency"), tx.get("currency")),
        "country_code": (response_value("country_code") or response_value("country"),
                         meta.get("country") or meta.get("country_code")),
        "network": (response_value("network"), meta.get("network")),
        "phone_number": (response_value("phone_number") or response_value("recipient_phone"),
                         meta.get("recipient_phone")),
        "amount": (response_value("amount"), meta.get("recipient_gets")),
        "order_id": (response_value("order_id") or response_value("reference"),
                     tx.get("id")),
    }
    for key, (received, expected) in checks.items():
        if received in (None, "") or expected in (None, ""):
            if key in {"amount", "currency", "order_id"}:
                await db.transactions.update_one(
                    {"id": tx["id"], "status": "pending"},
                    {"$set": {"metadata.quarantined": True,
                              "metadata.reconciliation_mismatch": f"missing_{key}"}},
                )
                return "mismatch"
            continue
        if key == "phone_number":
            normalize = lambda value: re.sub(r"\D", "", str(value))[-12:]
            mismatch = normalize(received) != normalize(expected)
        elif key == "amount":
            mismatch = abs(float(received) - float(expected)) > 1e-9
        else:
            mismatch = str(received).upper() != str(expected).upper()
        if mismatch:
            await db.transactions.update_one(
                {"id": tx["id"], "status": "pending"},
                {"$set": {"metadata.reconciliation_mismatch": key,
                          "metadata.quarantined": True}},
            )
            return "mismatch"
    status = mbiyo.status_value(response)
    if status in mbiyo.SUCCESS_STATUSES:
        await _complete_mbiyo_withdrawal(tx["id"], status)
        return "completed"
    if status in mbiyo.FAILURE_STATUSES:
        await _refund_mobile_withdrawal(tx["id"], status)
        return "failed"
    await db.transactions.update_one(
        {"id": tx["id"], "status": "pending"},
        {"$set": {
            "metadata.mbiyo_status": status or "pending",
            "metadata.next_reconcile_at": (
                datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(),
        }},
    )
    return "pending"


def _disbursement_status(payload: dict) -> str:
    """Normalize a status from any documented PayDunya response envelope."""
    if not isinstance(payload, dict):
        return ""
    for key in ("status", "disbursement_status", "transaction_status"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower().replace("-", "_").replace(" ", "_")
    for value in payload.values():
        if isinstance(value, dict):
            found = _disbursement_status(value)
            if found:
                return found
    return ""


def _disbursement_value(payload: dict, *keys):
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if payload.get(key) not in (None, ""):
            return payload[key]
    for value in payload.values():
        if isinstance(value, dict):
            found = _disbursement_value(value, *keys)
            if found not in (None, ""):
                return found
    return None


async def _reconcile_mobile_withdrawal(tx: dict) -> str:
    """Verify payout state server-to-server and apply an idempotent outcome."""
    if not tx:
        return ""
    meta = tx.get("metadata") or {}
    token = str(meta.get("paydunya_invoice_token") or "")
    provider_id = str(meta.get("paydunya_disbursement_id") or "")
    if not token and not provider_id:
        return "pending"
    cfg = await get_paydunya_config(decrypt=True)
    response = await paydunya.check_disbursement_status(
        cfg, invoice_token=token, provider_id=provider_id)
    returned_token = paydunya.disbursement_token(response)
    returned_amount = _disbursement_value(response, "amount")
    returned_mode = str(_disbursement_value(
        response, "withdraw_mode") or "")
    returned_reference = str(_disbursement_value(
        response, "disburse_id") or "")
    response_code = str(_disbursement_value(
        response, "response_code") or "").zfill(2)
    expected_amount = float(meta.get("recipient_gets", tx.get("amount", 0)))
    expected_mode = str(meta.get("paydunya_withdraw_mode") or "")
    try:
        amount_matches = abs(float(returned_amount) - expected_amount) < 0.005
    except (TypeError, ValueError):
        amount_matches = False
    if (response_code != "00" or not returned_token
            or not hmac.compare_digest(returned_token, token)
            or not amount_matches or returned_mode != expected_mode
            or not returned_reference
            or not hmac.compare_digest(returned_reference, str(tx["reference"]))):
        raise paydunya.PayDunyaError(502, "Référence de retrait PayDunya incohérente")
    status = _disbursement_status(response)
    if status in {"completed", "complete", "success", "successful", "sent",
                  "paid", "succeeded"}:
        changed = await db.transactions.update_one(
            {"id": tx["id"], "status": "pending"},
            {"$set": {"status": "completed",
                      "metadata.paydunya_status": status}})
        if changed.modified_count:
            await notify(tx["user_id"], "withdrawal_success",
                         "Retrait Mobile Money confirmé",
                         f"Votre retrait de {tx['amount']:,.0f} {tx.get('currency', '')} a été envoyé au bénéficiaire.",
                         data={"transaction_id": tx["id"], "reference": tx.get("reference"),
                               "amount": tx["amount"], "transfer_type": "biz_to_mobile"})
            if meta.get("source") == "merchant_api" and await _claim_transaction_flag(
                    tx["id"], "merchant_webhook_claimed"):
                await _deliver_webhook(tx["user_id"], "push.succeeded", {
                    "payout_id": tx["id"],
                    "reference": meta.get("merchant_reference") or tx.get("reference"),
                    "amount": _format_amount(tx.get("amount", 0)),
                    "currency": tx.get("currency"),
                    "status": "completed",
                    "completed_at": _format_iso(datetime.now(timezone.utc)),
                })
        return "completed"
    if status in {"failed", "failure", "cancelled", "canceled", "rejected",
                  "declined", "error", "refunded"}:
        await _refund_mobile_withdrawal(tx["id"], status)
        return "failed"
    await db.transactions.update_one(
        {"id": tx["id"], "status": "pending"},
        {"$set": {
            "metadata.paydunya_status": status or "pending",
            "metadata.next_reconcile_at": (
                datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(),
        }})
    return "pending"


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
    merchant_ref = intent.get("merchantReference") or intent.get("merchant_reference")
    if status in ("expired", "failed", "rejected", "canceled", "cancelled", "irregular"):
        if merchant_ref:
            link_payment = await db.link_payments.find_one(
                {"id": merchant_ref, "status": {"$nin": ["paid", "failed", "expired"]}},
                {"_id": 0})
            if link_payment:
                await db.link_payments.update_one(
                    {"id": merchant_ref, "status": {"$nin": ["paid", "failed", "expired"]}},
                    {"$set": {"status": "expired" if status == "expired" else "failed",
                              "failed_at": now_iso(),
                              "provider_status": status}},
                )
                await _release_single_use_link(
                    link_payment["link_id"], link_payment.get("single_use_claim_id"))
        return
    if status not in ("completed", "confirmed", "paid", "success", "successful"):
        return
    tx_hash = intent.get("txHash") or intent.get("txhash") or intent.get("transactionHash")
    if not merchant_ref:
        return

    # 1) Crypto deposit
    d = await db.crypto_deposits.find_one({"id": merchant_ref, "status": {"$ne": "confirmed"}})
    if d:
        gross = float(d["amount"])
        fee_pct = await _crypto_fee_pct(d.get("coin", "USDT"))
        fee, net = _apply_fee(gross, fee_pct)
        gateway_fee, platform_fee = await _crypto_platform_fee(d.get("coin", "USDT"), "deposit", gross)
        operation_id = f"izipay:deposit:{merchant_ref}"
        await _credit_wallet_once(d["user_id"], "balance_usdt", net, operation_id)
        await db.crypto_deposits.update_one(
            {"id": merchant_ref, "status": {"$ne": "confirmed"}},
            {"$set": {"status": "confirmed", "updated_at": now_iso(),
                      "izipay_intent_id": intent_id, "tx_hash": tx_hash,
                      "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                      "amount_net": net, "credit_operation_id": operation_id}}
        )
        await record_tx(d["user_id"], "deposit", "in", net, "USDT",
                        status="completed",
                        description=f"Dépôt crypto {d.get('coin','')} · {d.get('network','')}",
                        metadata={"izipay_intent_id": intent_id,
                                  "coin": d.get("coin"), "network": d.get("network"),
                                  "asset_code": d.get("asset_code"), "tx_hash": tx_hash,
                                  "deposit_address": d.get("deposit_address"),
                                  "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                                  "gateway_fee": gateway_fee, "platform_fee": platform_fee,
                                  "amount_net": net, "source": "reconcile"},
                        operation_id=operation_id)
        return

    # 2) Payment link
    lp = await db.link_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
    if lp:
        gross = float(lp.get("charged_amount", lp["amount"]))
        if "charged_amount" in lp:
            fee_pct = float(lp.get("fee_pct", 0))
            fee = float(lp.get("fee", 0))
            net = float(lp.get("wallet_credit_amount", lp.get("amount")))
        else:
            fee_pct = await _crypto_fee_pct(lp.get("coin", "USDT"))
            fee, net = _apply_fee(gross, fee_pct)
        gateway_fee, platform_fee = await _crypto_platform_fee(lp.get("coin", "USDT"), "deposit", gross)
        link = await db.payment_links.find_one({"id": lp["link_id"]})
        if link:
            operation_id = f"izipay:link:{merchant_ref}"
            await _credit_wallet_once(link["user_id"], "balance_usdt", net, operation_id)
            await db.link_payments.update_one(
                {"id": merchant_ref, "status": {"$ne": "paid"}},
                {"$set": {"status": "paid", "paid_at": now_iso(),
                          "izipay_intent_id": intent_id, "tx_hash": tx_hash,
                          "amount_gross": gross, "fee": fee, "fee_pct": fee_pct,
                          "amount_net": net, "credit_operation_id": operation_id}}
            )
            await db.payment_links.update_one(
                {"id": link["id"], "link_payment_operation_ids": {"$ne": merchant_ref}},
                {"$inc": {"payments_received": 1, "total_received": net},
                 "$addToSet": {"link_payment_operation_ids": merchant_ref}}
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
                                      "amount_net": net, "source": "reconcile"},
                            operation_id=operation_id)

    # 3) Merchant API crypto payment
    mp = await db.merchant_payments.find_one(
        {"id": merchant_ref, "status": {"$ne": "paid"}}, {"_id": 0})
    if mp:
        gross = float(mp.get("amount_gross", mp["amount"]))
        if mp.get("fee") is not None and mp.get("amount_net") is not None:
            fee_pct = float(mp.get("fee_pct") or 0)
            fee = float(mp["fee"])
            net = float(mp["amount_net"])
            gateway_fee = float(mp.get("gateway_fee") or 0)
            platform_fee = float(mp.get("platform_fee") or 0)
        else:
            fee_pct = await _crypto_fee_pct(mp.get("coin", "USDT"))
            fee, net = _apply_fee(gross, fee_pct)
            gateway_fee, platform_fee = await _crypto_platform_fee(
                mp.get("coin", "USDT"), "deposit", gross)
        operation_id = f"izipay:merchant-payment:{merchant_ref}"
        await _credit_wallet_once(mp["merchant_id"], "balance_usdt", net, operation_id)
        await db.merchant_payments.update_one(
            {"id": merchant_ref, "status": {"$ne": "paid"}},
            {"$set": {"status": "paid", "paid_at": now_iso(),
                      "izipay_intent_id": intent_id, "tx_hash": tx_hash,
                      "amount_gross": gross, "fee": fee,
                      "fee_pct": fee_pct, "amount_net": net,
                      "gateway_fee": gateway_fee, "platform_fee": platform_fee,
                      "credit_operation_id": operation_id}},
        )
        await record_tx(
            mp["merchant_id"], "payment", "in", net, "USDT",
            status="completed", description="Paiement API marchand",
            metadata={"merchant_payment_id": mp["id"],
                      "external_reference": mp.get("reference"),
                      "provider_reference": mp.get("izipay_intent_id"),
                      "izipay_intent_id": intent_id, "coin": mp.get("coin"),
                      "tx_hash": tx_hash, "customer_email": mp.get("customer_email"),
                      "amount_gross": gross, "fee": fee,
                      "gateway_fee": gateway_fee, "platform_fee": platform_fee,
                      "fee_pct": fee_pct, "amount_net": net,
                      "source": "reconcile"},
            operation_id=operation_id)
        await _deliver_webhook(mp["merchant_id"], "payment.completed", {
            "payment_id": mp["id"],
            "reference": mp.get("reference"),
            "amount_gross": _format_amount(gross),
            "amount_net": _format_amount(net),
            "fee": _format_amount(fee),
            "fee_pct": fee_pct, "coin": mp.get("coin"), "tx_hash": tx_hash,
            "customer_email": mp.get("customer_email"),
            "paid_at": _format_iso(datetime.now(timezone.utc)),
        })


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
    except DuplicateKeyError:
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
                    gateway_fee, platform_fee = await _crypto_platform_fee(d.get("coin", "USDT"), "deposit", gross)
                    operation_id = f"izipay:deposit:{merchant_ref}"
                    await _credit_wallet_once(d["user_id"], "balance_usdt", net, operation_id)
                    await db.crypto_deposits.update_one(
                        {"id": merchant_ref, "status": {"$ne": "confirmed"}},
                        {"$set": {"status": "confirmed", "updated_at": now_iso(),
                                  "izipay_intent_id": intent_id,
                                  "tx_hash": tx_hash,
                                  "amount_gross": gross, "fee": fee,
                                  "fee_pct": fee_pct, "amount_net": net,
                                  "gateway_fee": gateway_fee,
                                  "platform_fee": platform_fee,
                                  "credit_operation_id": operation_id}}
                    )
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
                                              "gateway_fee": gateway_fee, "platform_fee": platform_fee,
                                              "amount_net": net},
                                    operation_id=operation_id)
                # 2) Payment link payment?
                link_pay = await db.link_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
                if link_pay:
                    tx_hash = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
                    gross = float(link_pay.get("charged_amount", link_pay["amount"]))
                    if "charged_amount" in link_pay:
                        fee_pct = float(link_pay.get("fee_pct", 0))
                        fee = float(link_pay.get("fee", 0))
                        net = float(link_pay.get("wallet_credit_amount", link_pay.get("amount")))
                    else:
                        fee_pct = await _crypto_fee_pct(link_pay.get("coin", "USDT"))
                        fee, net = _apply_fee(gross, fee_pct)
                    gateway_fee, platform_fee = await _crypto_platform_fee(link_pay.get("coin", "USDT"), "deposit", gross)
                    link = await db.payment_links.find_one({"id": link_pay["link_id"]})
                    operation_id = f"izipay:link:{merchant_ref}"
                    if link:
                        await _credit_wallet_once(link["user_id"], "balance_usdt", net, operation_id)
                    await db.link_payments.update_one(
                        {"id": merchant_ref, "status": {"$ne": "paid"}},
                        {"$set": {"status": "paid", "paid_at": now_iso(),
                                  "izipay_intent_id": intent_id,
                                  "tx_hash": tx_hash,
                                  "amount_gross": gross, "fee": fee,
                                  "fee_pct": fee_pct, "amount_net": net,
                                  "credit_operation_id": operation_id}}
                    )
                    # Credit merchant NET amount
                    if link:
                        await db.payment_links.update_one(
                            {"id": link["id"],
                             "link_payment_operation_ids": {"$ne": merchant_ref}},
                            {"$inc": {"payments_received": 1, "total_received": net},
                             "$addToSet": {"link_payment_operation_ids": merchant_ref}}
                        )
                        if link_pay.get("single_use_claim_id"):
                            await db.payment_links.update_one(
                                {"id": link["id"],
                                 "single_use_claim_id": link_pay["single_use_claim_id"]},
                                {"$set": {"active": False}},
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
                                                  "gateway_fee": gateway_fee,
                                                  "platform_fee": platform_fee,
                                                  "deposit_address": link_pay.get("deposit_address"),
                                                  "amount_gross": gross,
                                                   "fee": fee, "fee_pct": fee_pct,
                                                   "amount_net": net},
                                         operation_id=operation_id)
                # 3) Merchant API payment?
                mp = await db.merchant_payments.find_one({"id": merchant_ref, "status": {"$ne": "paid"}})
                if mp:
                    gross = float(mp["amount"])
                    if mp.get("fee") is not None and mp.get("amount_net") is not None:
                        fee_pct = float(mp.get("fee_pct") or 0)
                        fee = float(mp["fee"])
                        net = float(mp["amount_net"])
                        gateway_fee = float(mp.get("gateway_fee") or 0)
                        platform_fee = float(mp.get("platform_fee") or 0)
                    else:
                        fee_pct = await _crypto_fee_pct(mp.get("coin", "USDT"))
                        fee, net = _apply_fee(gross, fee_pct)
                        gateway_fee, platform_fee = await _crypto_platform_fee(
                            mp.get("coin", "USDT"), "deposit", gross)
                    tx_hash = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
                    operation_id = f"izipay:merchant-payment:{merchant_ref}"
                    await _credit_wallet_once(mp["merchant_id"], "balance_usdt", net, operation_id)
                    await db.merchant_payments.update_one(
                        {"id": merchant_ref, "status": {"$ne": "paid"}},
                        {"$set": {"status": "paid", "paid_at": now_iso(),
                                  "izipay_intent_id": intent_id,
                                  "tx_hash": tx_hash,
                                  "amount_gross": gross, "fee": fee,
                                  "fee_pct": fee_pct, "amount_net": net,
                                  "credit_operation_id": operation_id}}
                    )
                    await record_tx(mp["merchant_id"], "payment", "in", net, "USDT",
                                    status="completed", description="Paiement API marchand",
                                    metadata={"merchant_payment_id": mp["id"],
                                              "external_reference": mp.get("reference"),
                                              "provider_reference": mp.get("izipay_intent_id"),
                                              "izipay_intent_id": intent_id,
                                              "coin": mp.get("coin"), "tx_hash": tx_hash,
                                              "customer_email": mp.get("customer_email"),
                                              "amount_gross": gross, "fee": fee,
                                              "gateway_fee": gateway_fee, "platform_fee": platform_fee,
                                               "fee_pct": fee_pct, "amount_net": net},
                                     operation_id=operation_id)
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
                link_pay = await db.link_payments.find_one(
                    {"id": merchant_ref, "status": {"$ne": "paid"}}, {"_id": 0})
                await db.link_payments.update_one(
                    {"id": merchant_ref, "status": {"$ne": "paid"}},
                    {"$set": {"status": "expired"}})
                if link_pay:
                    await _release_single_use_link(
                        link_pay["link_id"], link_pay.get("single_use_claim_id"))
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
                link_pay = await db.link_payments.find_one(
                    {"id": merchant_ref, "status": {"$ne": "paid"}}, {"_id": 0})
                await db.link_payments.update_one(
                    {"id": merchant_ref, "status": {"$ne": "paid"}},
                    {"$set": {"status": "failed"}})
                if link_pay:
                    await _release_single_use_link(
                        link_pay["link_id"], link_pay.get("single_use_claim_id"))
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
                    await _refund_wallet_once(
                        tx["user_id"], field, total_debit,
                        f"izipay-payout:{tx['id']}")
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
async def start_link_payment(req: LinkPayRequest, request: Request):
    """Public endpoint: a customer opening a payment link pays with crypto.
    Uses direct intent (no redirect) — deposit address + amount are shown in-app.
    """
    await _require_turnstile(req.turnstile_token, request, "payment")
    if not izipay.is_configured():
        raise HTTPException(503, "Passerelle crypto non configurée")
    link = await db.payment_links.find_one({"slug": req.slug, "active": True})
    if not link:
        raise HTTPException(404, "Lien introuvable ou inactif")
    if link.get("currency") not in ("USDT", "UNIVERSAL"):
        raise HTTPException(400, "Ce lien n'accepte pas les paiements crypto (devise différente de USDT/UNIVERSAL)")

    amount = await _ensure_link_can_be_paid(
        link, req.amount if link.get("amount_type") == "free" else None
    )
    single_use_claim = await _claim_single_use_link(link)
    fee_pct = await _crypto_fee_pct(req.asset_code.split(".")[0])
    fee, fee_net = _apply_fee(amount, fee_pct)
    customer_pays_fee = link.get("fee_bearer", "customer") != "owner"
    charged_amount = round(amount + fee, 6) if customer_pays_fee else amount
    wallet_credit_amount = amount if customer_pays_fee else fee_net

    lp_id = new_id()
    parts = (req.full_name or "").strip().split(maxsplit=1)
    first = parts[0] if parts else "Client"
    last = parts[1] if len(parts) > 1 else first

    try:
        intent = await izipay.create_direct_intent(
            requested_coin=req.asset_code,
            amount=f"{charged_amount:.6f}",
            first_name=first, last_name=last, email=req.email,
            refund_address=req.refund_address.strip(),
            merchant_reference=lp_id,
            metadata={"link_id": link["id"], "kind": "link_payment"},
        )
    except izipay.IziPayError as e:
        await _release_single_use_link(link["id"], single_use_claim)
        print(f"izipay link pay rejected [{e.code}] {e.message}")
        msg = (e.message or "").lower()
        if "address" in msg or "adresse" in msg:
            user_msg = "Adresse de remboursement invalide."
        else:
            user_msg = "La passerelle crypto a refusé la demande. Réessayez."
        raise HTTPException(400 if e.status < 500 else 502, user_msg)

    doc = {
        "id": lp_id, "link_id": link["id"], "slug": req.slug,
        "amount": amount, "charged_amount": charged_amount,
        "wallet_credit_amount": wallet_credit_amount, "fee": fee,
        "fee_pct": fee_pct, "fee_bearer": "client" if customer_pays_fee else "merchant",
        "asset_code": req.asset_code,
        "coin": req.asset_code.split(".")[0],
        "network": req.asset_code.split(".")[1] if "." in req.asset_code else None,
        "customer_email": req.email, "customer_name": req.full_name,
        "status": intent.get("status") or "pending",
        "izipay_intent_id": intent.get("id"),
        "deposit_address": intent.get("depositAddress"),
        "memo": intent.get("memo"),
        "memo_type": intent.get("memoType"),
        "amount_to_send": intent.get("amountToSend") or intent.get("amountCryptoExpected"),
        "single_use_claim_id": single_use_claim,
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
    # Mobile Money: reconcile PayDunya server-to-server (legacy FedaPay rows
    # remain readable, but are not used by newly-created links).
    if lp.get("method") == "mobile_money" and lp.get("status") == "pending":
        d = await db.momo_deposits.find_one({"id": lp.get("momo_deposit_id")}, {"_id": 0})
        if d:
            if d.get("provider") == "paydunya" and d.get("status") in ("pending", "approved"):
                await _reconcile_momo_deposit(d["id"])
                lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
            elif d.get("provider") == "mbiyo" and d.get("status") in ("pending", "approved"):
                await _reconcile_mbiyo_deposit(d["id"])
                lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
            elif d.get("status") == "approved":
                await db.link_payments.update_one(
                    {"id": payment_id, "status": "pending"},
                    {"$set": {"status": "paid",
                              "amount_net": d.get("amount_net"),
                              "fee": d.get("fee"),
                              "paid_at": now_iso()}}
                )
                lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
            elif d.get("status") == "failed":
                await db.link_payments.update_one(
                    {"id": payment_id, "status": "pending"},
                    {"$set": {"status": "failed"}}
                )
                lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
        return _public_link_payment_status(lp)
    if lp.get("status") not in ("paid", "expired", "failed") and lp.get("izipay_intent_id"):
        await _reconcile_intent(lp["izipay_intent_id"])
        lp = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
    return _public_link_payment_status(lp)


class LinkChallengeFinalizeRequest(MomoChallengeFinalizeRequest):
    finalize_capability: str = Field(..., min_length=20, max_length=128)


@api.post("/links/payments/{payment_id}/mobile-money/finalize")
@api.post("/links/payments/{payment_id}/finalize")
async def finalize_link_payment(
    payment_id: str,
    req: LinkChallengeFinalizeRequest,
    request: Request,
):
    lp = await db.link_payments.find_one(
        {"id": payment_id, "method": "mobile_money", "status": "pending"},
        {"_id": 0},
    )
    if not lp:
        raise HTTPException(404, "Paiement introuvable ou déjà terminé")
    expires = lp.get("finalize_capability_expires_at")
    expected = str(lp.get("finalize_capability_hash") or "")
    if (not expected or not expires or
            datetime.fromisoformat(expires.replace("Z", "+00:00")) < datetime.now(timezone.utc)
            or not hmac.compare_digest(
                expected, hashlib.sha256(req.finalize_capability.encode()).hexdigest())):
        raise HTTPException(403, "Capacité de finalisation invalide ou expirée")
    d = await db.momo_deposits.find_one(
        {"id": lp.get("momo_deposit_id"), "status": "pending"}, {"_id": 0}
    )
    if not d or (d.get("auth_mode") != "pin"
                 and d.get("endpoint_slug") != "wizall-money-senegal"):
        raise HTTPException(409, "Cette transaction ne demande pas de code de finalisation")
    provider_ref = str(d.get("mbiyo_transaction_id")
                       or d.get("provider_reference")
                       or d.get("paydunya_reference") or "")
    try:
        if d.get("provider") == "mbiyo":
            cfg = await get_mbiyo_config(decrypt=True)
            response = await mbiyo.MbiyoClient(
                cfg.get("_api_key", ""), cfg.get("base_url", mbiyo.BASE_URL)
            ).finalize(provider_ref, req.otp)
        else:
            cfg = await get_paydunya_config(decrypt=True)
            response = await paydunya.wizall_confirm(
                cfg, authorization_code=req.otp,
                phone=str(d.get("phone_number") or ""),
                transaction_id=provider_ref,
            )
    except (mbiyo.MbiyoError, paydunya.PayDunyaError):
        raise HTTPException(400, "Le code de validation n’a pas été accepté.")
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    new_ref = _provider_reference(response)
    await db.momo_deposits.update_one(
        {"id": d["id"], "status": "pending"},
        {"$set": {"auth_mode": None, "challenge_status": "submitted",
                  "instructions": _plain_payment_instructions(data.get("instructions")),
                  **({"provider_reference": new_ref} if new_ref else {})}},
    )
    await db.link_payments.update_one(
        {"id": payment_id, "status": "pending"},
        {"$set": {"auth_mode": None, "challenge_status": "submitted",
                  "instructions": _plain_payment_instructions(data.get("instructions")),
                  "finalize_capability_hash": None,
                  "finalize_capability_expires_at": None}},
    )
    fresh = await db.link_payments.find_one({"id": payment_id}, {"_id": 0})
    return _public_link_payment_status(fresh or lp)


class LinkPayMoMoRequest(BaseModel):
    slug: str
    amount: Optional[float] = None
    full_name: str
    email: str
    country: str  # ISO-2
    operator: str
    phone_number: str
    otp: Optional[str] = Field(None, min_length=1, max_length=32)
    fee_bearer: Literal["sender", "receiver", "client", "merchant"] = "sender"
    turnstile_token: Optional[str] = Field(None, min_length=1, max_length=2048)


@api.post("/links/pay/mobile-money")
async def start_link_payment_momo(req: LinkPayMoMoRequest, request: Request):
    """Public endpoint: a customer paying a payment link via Mobile Money.

    PayDunya SoftPay flow.  The merchant is credited only after the same
    server-side confirmation/reconciliation used by wallet deposits.
    """
    await _require_turnstile(req.turnstile_token, request, "payment")
    cfg = await get_paydunya_config(decrypt=True)
    link = await db.payment_links.find_one({"slug": req.slug, "active": True})
    if not link:
        raise HTTPException(404, "Lien introuvable ou inactif")

    amount = await _ensure_link_can_be_paid(
        link, req.amount if link.get("amount_type") == "free" else None
    )

    link_currency = str(link.get("currency") or "XOF").upper()
    route_provider = await _resolve_deposit_provider(
        req.country, req.operator, link_currency)
    if route_provider == "mbiyo":
        mb_cfg = await get_mbiyo_config(decrypt=True)
        mb_op = _active_mbiyo_operator(
            mb_cfg.get("catalog") or [], req.country, req.operator)
        if not mb_op:
            raise HTTPException(400, "Cet opérateur est désactivé.")
        single_use_claim = await _claim_single_use_link(link)
        dep_id = None
        lp_id = new_id()
        try:
            mb_req = MobileMoneyDepositRequest(
                amount=amount, currency=str(mb_op.get("currency") or "XOF"),
                email=req.email, full_name=req.full_name, country=req.country,
                operator=req.operator, phone_number=req.phone_number, otp=req.otp,
                fee_bearer=req.fee_bearer,
            )
            result = await _create_mbiyo_deposit(
                mb_req, request, link["user_id"],
                record_context={
                    "source": "link_payment",
                    "link_payment_id": lp_id,
                    "single_use_claim_id": single_use_claim,
                },
            )
            dep_id = result["id"]
            dep = await db.momo_deposits.find_one({"id": dep_id}, {"_id": 0})
            finalize_capability = None
            if result.get("auth_mode") == "pin":
                finalize_capability, capability_hash, capability_expires = _new_finalize_capability()
            await db.momo_deposits.update_one(
                {"id": dep_id},
                {"$set": {"source": "link_payment", "link_payment_id": None,
                          "single_use_claim_id": single_use_claim}},
            )
            lp = {
                "id": lp_id, "link_id": link["id"], "slug": req.slug,
                "method": "mobile_money", "amount": amount,
                "charged_amount": result.get("charged_amount"),
                "currency": result.get("currency"),
                "country": req.country, "operator": req.operator,
                "operator_name": mb_op.get("name"),
                "customer_email": req.email, "customer_name": req.full_name,
                "customer_phone": req.phone_number,
                "status": "paid" if result.get("status") == "approved" else "pending",
                "momo_deposit_id": dep_id, "fee_bearer": result.get("fee_bearer"),
                "payment_flow": result.get("payment_flow") or mbiyo.payment_flow(mb_op, amount),
                "auth_mode": result.get("auth_mode"),
                "instructions": result.get("instructions"),
                "redirect_url": result.get("redirect_url"),
                "checkout_url": result.get("checkout_url"),
                "prompt_sent": True, "single_use_claim_id": single_use_claim,
                **({"finalize_capability_hash": capability_hash,
                    "finalize_capability_expires_at": capability_expires}
                   if finalize_capability else {}),
                 "created_at": result.get("created_at") or now_iso(),
                 "pending_expires_at": result.get("pending_expires_at"),
            }
            await db.momo_deposits.update_one(
                {"id": dep_id},
                {"$set": {"link_payment_id": lp_id}},
            )
            await db.link_payments.insert_one(lp)
            if result.get("status") == "approved":
                # Immediate provider success can precede creation of the local
                # link-payment row. Re-run the exactly-once credit finalizer now
                # so its idempotent link ledger/counter side effects are repaired.
                fresh_dep = await db.momo_deposits.find_one(
                    {"id": dep_id}, {"_id": 0})
                if fresh_dep:
                    await _credit_momo_deposit(fresh_dep)
            public_result = _public_link_payment_status(lp)
            if finalize_capability:
                public_result["finalize_capability"] = finalize_capability
            return public_result
        except Exception:
            if not dep_id:
                await _release_single_use_link(link["id"], single_use_claim)
            raise

    if not cfg.get("enabled") or not paydunya.mode_is_enabled(cfg, "softpay_direct"):
        raise HTTPException(503, "Le paiement direct Mobile Money est désactivé")

    admin_op = next((op for op in cfg.get("catalog", [])
                     if op.get("country", "").upper() == req.country.upper()
                     and op.get("code", "").lower() == req.operator.lower()
                     and op.get("active", True)
                     and not op.get("archived", False)
                     and not op.get("hidden", False)), None)
    if not admin_op:
        raise HTTPException(400, "Cet opérateur est désactivé.")
    payment_flow = paydunya.payment_flow(admin_op, amount)
    if (payment_flow.get("otp_required") and payment_flow.get("before_submit")
            and not req.otp):
        raise HTTPException(
            400,
            detail={"message": "Générez le code indiqué puis saisissez-le avant de lancer le paiement.",
                    "code": "OTP_REQUIRED", "payment_flow": payment_flow},
        )
    currency = (admin_op.get("currency") or "XOF").upper()
    if currency not in PAYDUNYA_WALLET_CURRENCIES:
        raise HTTPException(400, "Devise PayDunya non prise en charge par le portefeuille")
    min_amt = float(admin_op.get("min", 100))
    max_amt = float(admin_op.get("max", 0)) or None
    if amount < min_amt:
        raise HTTPException(400, f"Montant minimum : {int(min_amt)} {currency}")
    if max_amt and amount > max_amt:
        raise HTTPException(400, f"Montant maximum : {int(max_amt)} {currency}")
    # The payment link owner chooses who bears the fees when creating the
    # link. Never trust a public checkout request to override that setting.
    bearer = "merchant" if link.get("fee_bearer") == "owner" else "client"
    fees = paydunya.calculate_fees(amount, admin_op, bearer)
    phone = req.phone_number
    if req.country.upper() == "TG":
        try:
            phone = paydunya.normalize_togo_phone(phone)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    single_use_claim = await _claim_single_use_link(link)
    lp_id = new_id()
    dep_id = new_id()
    finalize_capability = None
    parts = (req.full_name or "").strip().split(" ", 1)
    first = parts[0] or "Client"
    last = parts[1] if len(parts) > 1 else first

    try:
        invoice = await paydunya.create_invoice(
            cfg, amount=fees["charged_amount"], currency=currency, token=dep_id,
            customer={"firstname": first, "lastname": last, "email": req.email,
                      "phone_number": phone},
            callback_url=(
                f"{(os.environ.get('OFFICIAL_DOMAIN') or _paydunya_callback_base(request)).rstrip('/')}"
                f"/api/webhooks/paydunya?ref={dep_id}"
            ),
            description=f"Lien Biz-transPay {link.get('title') or req.slug}",
        )
        token = paydunya.invoice_token(invoice)
        if not token:
            raise paydunya.PayDunyaError(502, "PayDunya did not return an invoice token")
    except paydunya.PayDunyaError as exc:
        await _release_single_use_link(link["id"], single_use_claim)
        raise HTTPException(400 if exc.status < 500 else 502,
            "La passerelle Mobile Money a refusé la demande.")
    ref = invoice.get("reference") or invoice.get("invoice_id")
    checkout_url = paydunya.checkout_url(invoice)

    # Persist both local records before triggering SoftPay.  This makes a
    # callback immediately after the provider request observable locally.
    created_at = now_iso()
    pending_expires_at = (
        datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        + timedelta(minutes=MOMO_PENDING_TIMEOUT_MINUTES)
    ).isoformat()
    momo_doc = {
        "id": dep_id,
        "user_id": link["user_id"],  # credit the merchant
        "amount": fees["requested_amount"], "requested_amount": fees["requested_amount"],
        "charged_amount": fees["charged_amount"],
        "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
        "total_fee": fees["total_fee"], "wallet_credit_amount": fees["wallet_credit_amount"],
        "fee_snapshot": {**fees, "gateway_fee_pct": float(admin_op.get("gateway_fee_pct", admin_op.get("fee_pct", 0))),
                         "gateway_fee_fixed": float(admin_op.get("gateway_fee_fixed", 0)),
                         "platform_fee_pct": float(admin_op.get("platform_fee_pct", 0)),
                         "platform_fee_fixed": float(admin_op.get("platform_fee_fixed", 0))},
        "operator_snapshot": dict(admin_op),
        "currency": currency,
        "email": req.email, "full_name": req.full_name,
        "country": req.country, "operator": req.operator,
        "operator_name": admin_op.get("name"),
        "endpoint_slug": admin_op.get("endpoint_slug"),
        "payment_flow": payment_flow,
        "auth_mode": "pin" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else None,
        "otp_required": admin_op.get("endpoint_slug") == "wizall-money-senegal",
        "challenge_status": "required" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else "pending",
        "mode": "softpay_direct", "provider": "paydunya",
        "provider_mode": cfg.get("mode", "test"), "phone_number": phone,
        "fee_bearer": fees["fee_bearer"], "paydunya_token": token,
        "paydunya_reference": ref, "checkout_url": checkout_url,
        "status": "pending", "prompt_sent": False,
         "created_at": created_at, "pending_expires_at": pending_expires_at,
         "source": "link_payment",
        "link_payment_id": lp_id,
    }
    doc = {
        "id": lp_id, "link_id": link["id"], "slug": req.slug,
        "method": "mobile_money",
        "amount": fees["requested_amount"], "charged_amount": fees["charged_amount"],
        "currency": currency,
        "country": req.country, "operator": req.operator,
        "customer_email": req.email, "customer_name": req.full_name,
        "customer_phone": phone,
        "status": "pending",
        "momo_deposit_id": dep_id,
        "paydunya_token": token, "paydunya_reference": ref,
        "checkout_url": checkout_url,
         "single_use_claim_id": single_use_claim,
        "fee_bearer": fees["fee_bearer"],
        "prompt_sent": False,
         "payment_flow": payment_flow,
         "auth_mode": "pin" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else None,
         "otp_required": admin_op.get("endpoint_slug") == "wizall-money-senegal",
         "challenge_status": "required" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else "pending",
         "created_at": created_at,
         "pending_expires_at": pending_expires_at,
    }
    try:
        await db.momo_deposits.create_index("paydunya_token", unique=True, sparse=True)
        if await db.momo_deposits.find_one({"paydunya_token": token}, {"_id": 1}):
            raise HTTPException(409, "Cette facture PayDunya existe déjà")
        await db.momo_deposits.insert_one(momo_doc)
        try:
            await db.link_payments.insert_one(dict(doc))
        except Exception:
            await db.momo_deposits.update_one(
                {"id": dep_id}, {"$set": {"status": "failed",
                                          "retryable": True,
                                          "prompt_error": "local link record failed"}})
            raise
        softpay = await paydunya.softpay_payment(
            cfg, invoice_token=token, operator=admin_op, phone=phone,
            amount=fees["charged_amount"], currency=currency,
            customer_name=req.full_name, customer_email=req.email, otp=req.otp or "")
        ref = ref or softpay.get("reference")
        redirect_url = paydunya.checkout_url(softpay)
        provider_ref = _provider_reference(softpay)
        ref = ref or provider_ref
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"prompt_sent": True, "paydunya_reference": ref,
                      "provider_reference": provider_ref,
                      "redirect_url": redirect_url or None}})
        await db.link_payments.update_one(
            {"id": lp_id, "status": "pending"},
            {"$set": {"prompt_sent": True, "paydunya_reference": ref,
                      "provider_reference": provider_ref,
                      "redirect_url": redirect_url or None,
                      "payment_flow": payment_flow,
                      "auth_mode": "pin" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else None,
                      "otp_required": admin_op.get("endpoint_slug") == "wizall-money-senegal",
                      "challenge_status": "required" if admin_op.get("endpoint_slug") == "wizall-money-senegal" else "pending"}})
        if admin_op.get("endpoint_slug") == "wizall-money-senegal":
            finalize_capability, capability_hash, capability_expires = _new_finalize_capability()
            await db.link_payments.update_one(
                {"id": lp_id, "status": "pending"},
                {"$set": {"finalize_capability_hash": capability_hash,
                          "finalize_capability_expires_at": capability_expires}},
            )
        doc["prompt_sent"] = True
        doc["payment_flow"] = payment_flow
        doc["redirect_url"] = redirect_url or None
        doc["provider_reference"] = provider_ref
    except HTTPException:
        raise
    except paydunya.PayDunyaError as exc:
        safe_error = str(exc.message or "SoftPay provider error")[:240]
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"status": "failed", "retryable": True,
                      "prompt_error": safe_error, "failed_at": now_iso()}})
        await db.link_payments.update_one(
            {"id": lp_id, "status": "pending"},
            {"$set": {"status": "failed", "prompt_error": safe_error}})
        raise HTTPException(400 if exc.status < 500 else 502,
                            "La passerelle Mobile Money a refusé la demande.")
    except Exception as exc:
        await db.momo_deposits.update_one(
            {"id": dep_id, "status": "pending"},
            {"$set": {"status": "failed", "retryable": True,
                      "prompt_error": str(exc)[:240], "failed_at": now_iso()}})
        await db.link_payments.update_one(
            {"id": lp_id, "status": "pending"},
            {"$set": {"status": "failed", "prompt_error": str(exc)[:240]}})
        raise HTTPException(502, "Échec du déclenchement du paiement Mobile Money")
    doc.pop("_id", None)
    result = _public_link_payment_status(doc)
    if finalize_capability:
        result["finalize_capability"] = finalize_capability
    return result


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
    # Try the new multi-key collection first (per-key active flag + names)
    mkey = await db.merchant_keys.find_one({"secret_hash": h, "env": env})
    if mkey:
        if not mkey.get("active", True):
            raise BizAPIError(403, "This API key is disabled", "API_KEY_DISABLED")
        user = await db.users.find_one({"id": mkey["user_id"]})
        if not user or user.get("is_banned") or user.get("is_blocked"):
            raise BizAPIError(403, "Merchant account inactive", "ACCOUNT_INACTIVE")
        if user.get("account_type") != "merchant":
            raise BizAPIError(403, "Merchant API access is reserved for merchant accounts.",
                              "MERCHANT_ACCOUNT_REQUIRED")
        try:
            await db.merchant_keys.update_one(
                {"id": mkey["id"]},
                {"$set": {"last_used_at": now_iso()}}
            )
        except Exception:
            pass
        user["_api_env"] = env
        user["_api_key_id"] = mkey["id"]
        user["_api_scopes"] = mkey.get("scopes") or [
            "checkout:create", "direct:create", "push:create", "payments:read"
        ]
        return user
    # Fallback to legacy single-doc schema
    keys = await db.api_keys.find_one({f"keys.{env}.secret_hash": h})
    if not keys:
        keys = await db.api_keys.find_one({"secret_key": secret})
        if not keys:
            raise BizAPIError(401, "Invalid API key", "INVALID_API_KEY")
    if keys.get("suspended"):
        raise BizAPIError(403, "API keys suspended by administrator", "API_KEY_SUSPENDED")
    user = await db.users.find_one({"id": keys["user_id"]})
    if not user or user.get("is_banned") or user.get("is_blocked"):
        raise BizAPIError(403, "Merchant account inactive", "ACCOUNT_INACTIVE")
    if user.get("account_type") != "merchant":
        raise BizAPIError(403, "Merchant API access is reserved for merchant accounts.",
                          "MERCHANT_ACCOUNT_REQUIRED")
    try:
        await db.api_keys.update_one(
            {"user_id": keys["user_id"]},
            {"$set": {f"keys.{env}.last_used_at": now_iso()}}
        )
    except Exception:
        pass
    user["_api_env"] = env  # attach environment so downstream can vary behaviour
    # Keys issued by the legacy schema predate scopes.  Treat them as fully
    # enabled so existing integrations continue to work unchanged.
    user["_api_scopes"] = [
        "checkout:create", "direct:create", "push:create", "payments:read"
    ]
    return user


def _require_merchant_scope(merchant: dict, scope: str) -> None:
    """Enforce product scopes without weakening legacy key compatibility."""
    # A missing field denotes a legacy key; an explicitly empty list denotes
    # a deliberately restricted key and must not gain implicit privileges.
    scopes = merchant.get("_api_scopes")
    if scopes is None:
        scopes = ["checkout:create", "direct:create", "push:create", "payments:read"]
    if "*" not in scopes and scope not in scopes:
        raise BizAPIError(
            403,
            f"This API key does not allow the {scope} operation.",
            "API_SCOPE_REQUIRED",
            details={"required_scope": scope},
        )


class MerchantPaymentRequest(BaseModel):
    amount: float
    payment_method: Literal["crypto", "mobile_money"] = "crypto"
    coin: str = "USDT"
    accepted_networks: Optional[list[str]] = None
    currency: Optional[str] = None
    country: Optional[str] = Field(None, min_length=2, max_length=2)
    operator: Optional[str] = Field(None, min_length=2, max_length=64)
    customer_phone: Optional[str] = Field(None, min_length=6, max_length=32)
    customer_name: str = Field("Client", min_length=1, max_length=120)
    fee_bearer: Literal["client", "merchant"] = "client"
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


@api.get("/v1/diagnostic")
async def v1_diagnostic(request: Request):
    """Merchant-authenticated integration diagnostic.

    Requires a valid `sk_(test|live)_…` key. Reports:
      - the environment your key belongs to (test or live)
      - whether the crypto gateway (upstream) is configured & reachable
      - the number of active coin/network pairs currently accepted

    Use this from your integration to verify credentials + upstream health
    *before* trying to create a real payment. The diagnostic response NEVER
    exposes any upstream secret.
    """
    merchant = await _authenticate_merchant(request)
    env = merchant.get("_api_env") or "test"
    gateway_configured = bool(izipay.is_configured())
    gateway_reachable = False
    assets_active = 0
    upstream_error: Optional[str] = None
    if gateway_configured:
        try:
            assets = await izipay.list_assets()
            gateway_reachable = True
            assets_active = sum(1 for a in (assets or []) if a.get("isActive"))
        except Exception as e:
            upstream_error = str(e)[:200]
    return {
        "status": "ok" if (gateway_configured and gateway_reachable) else "degraded",
        "environment": env,
        "merchant_id": merchant["id"],
        "account_type": merchant.get("account_type"),
        "kyc_status": merchant.get("kyc_status"),
        "gateway": {
            "configured": gateway_configured,
            "reachable": gateway_reachable,
            "active_coins_count": assets_active,
            "error": upstream_error,
        },
        "timestamp": _format_iso(datetime.now(timezone.utc)),
    }


def _serialize_payment(mp: dict) -> dict:
    """Normalize a merchant_payment document for the /v1/payments API surface."""
    return {
        "id": mp.get("id"),
        "environment": mp.get("environment"),
        "status": mp.get("status"),
        "coin": mp.get("coin"),
        "amount": _format_amount(mp.get("amount", 0)),
        "amount_gross": _format_amount(mp.get("amount_gross", 0)) if mp.get("amount_gross") is not None else None,
        "amount_net": _format_amount(mp.get("amount_net", 0)) if mp.get("amount_net") is not None else None,
        "fee": _format_amount(mp.get("fee", 0)) if mp.get("fee") is not None else None,
        "fee_pct": mp.get("fee_pct"),
        "gateway_fee": _format_amount(mp.get("gateway_fee", 0))
            if mp.get("gateway_fee") is not None else None,
        "platform_fee": _format_amount(mp.get("platform_fee", 0))
            if mp.get("platform_fee") is not None else None,
        "reference": mp.get("reference"),
        "customer_email": mp.get("customer_email"),
        "payment_url": mp.get("payment_url"),
        "checkout_url": mp.get("checkout_url") or mp.get("payment_url"),
        "simulation_endpoint": mp.get("simulation_endpoint"),
        "deposit_address": mp.get("deposit_address"),
        "amount_to_send": mp.get("amount_to_send"),
        "tx_hash": mp.get("tx_hash"),
        "accepted_networks": mp.get("accepted_networks") or ["TRC20", "BEP20", "ERC20"],
        "expires_at": _format_iso(mp.get("expires_at", "")) if mp.get("expires_at") else None,
        "created_at": _format_iso(mp.get("created_at", "")) if mp.get("created_at") else None,
        "paid_at": _format_iso(mp.get("paid_at", "")) if mp.get("paid_at") else None,
        "canceled_at": _format_iso(mp.get("canceled_at", "")) if mp.get("canceled_at") else None,
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
    _require_merchant_scope(merchant, "checkout:create")
    owner = _developer_owner(merchant)
    if payload.payment_method == "mobile_money":
        missing = [
            name for name, value in (
                ("currency", payload.currency),
                ("country", payload.country),
                ("operator", payload.operator),
                ("customer_phone", payload.customer_phone),
            )
            if not value
        ]
        if missing:
            raise BizAPIError(
                400,
                "Missing Mobile Money fields: " + ", ".join(missing),
                "MISSING_REQUIRED_FIELD",
                details={"missing_fields": missing},
            )
        try:
            mobile_payload = DeveloperCheckoutRequest(
                amount=payload.amount,
                currency=str(payload.currency).upper(),
                country=str(payload.country).upper(),
                operator=payload.operator,
                customer_phone=payload.customer_phone,
                customer_email=payload.customer_email,
                customer_name=payload.customer_name,
                fee_bearer=payload.fee_bearer,
                reference=payload.reference,
                return_url=payload.return_url,
                metadata=payload.metadata,
            )
        except Exception as exc:
            raise BizAPIError(
                400, "Invalid Mobile Money payment request.",
                "INVALID_PAYMENT_REQUEST",
                details={"reason": str(exc)[:240]},
            )
        return await _developer_checkout(
            mobile_payload, request, "bizpay_checkout",
            idem_path="/api/v1/payments",
        )

    # ---- Idempotency ----------------------------------------------------
    idem_key = (request.headers.get("Idempotency-Key")
                or request.headers.get("idempotency-key") or "").strip()
    idem_fingerprint = _request_fingerprint(payload)
    if idem_key:
        if len(idem_key) > 255:
            raise BizAPIError(400, "Idempotency-Key must be 255 characters or fewer.",
                              "IDEMPOTENCY_KEY_TOO_LONG")

    if merchant.get("_api_env") == "test":
        cached = await _idempotency_claim(
            owner, idem_key, "POST", "/api/v1/payments", idem_fingerprint
        ) if idem_key else None
        if cached and cached.get("body") is not None:
            return JSONResponse(status_code=cached.get("status_code", 200),
                                content=cached["body"])
        if payload.amount < 1:
            raise BizAPIError(400, "Minimum amount: 1", "AMOUNT_TOO_SMALL")
        fee_pct = await _crypto_fee_pct(payload.coin)
        fee, amount_net = _apply_fee(payload.amount, fee_pct)
        gateway_fee, platform_fee = await _crypto_platform_fee(
            payload.coin, "deposit", payload.amount)
        mp_id = new_id()
        now = now_iso()
        doc = {
            "id": mp_id, "merchant_id": merchant["id"],
            "environment": "test", "product": "bizpay_checkout",
            "source": "merchant_api", "amount": payload.amount,
            "amount_gross": payload.amount, "amount_net": amount_net,
            "fee": fee, "fee_pct": fee_pct,
            "gateway_fee": gateway_fee, "platform_fee": platform_fee,
            "coin": payload.coin.upper(), "reference": payload.reference or mp_id,
            "merchant_reference": payload.reference or mp_id,
            "status": "initiated", "payment_url": f"/checkout/{mp_id}",
            "simulation_endpoint": f"/api/v1/test/payments/{mp_id}/complete",
            "customer_email": payload.customer_email, "metadata": payload.metadata or {},
            "created_at": now,
        }
        await db.merchant_payments.insert_one(doc)
        body = _serialize_payment(doc)
        if idem_key:
            await _idempotency_store(owner, idem_key, "POST", "/api/v1/payments", 200, body)
        return body
    if not izipay.is_configured():
        raise BizAPIError(503, "Crypto gateway not configured", "GATEWAY_UNAVAILABLE")
    if payload.amount < 1:
        raise BizAPIError(400, "Minimum amount: 1 USDT", "AMOUNT_TOO_SMALL")
    fee_pct = await _crypto_fee_pct(payload.coin)
    fee, amount_net = _apply_fee(payload.amount, fee_pct)
    gateway_fee, platform_fee = await _crypto_platform_fee(
        payload.coin, "deposit", payload.amount)
    if idem_key:
        cached = await _idempotency_claim(
            owner, idem_key, "POST", "/api/v1/payments",
            idem_fingerprint)
        if cached and cached.get("body") is not None:
            return JSONResponse(status_code=cached.get("status_code", 200),
                                content=cached["body"])

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
        await _idempotency_release(owner, idem_key, idem_fingerprint)
        # Log full detail server-side.
        logger.warning("v1/payments gateway rejected [%s] %s", e.code, e.message)
        # Surface the upstream reason to the merchant so they can fix
        # the request (invalid amount range, unsupported coin, etc.).
        hint = None
        emsg = (e.message or "").lower()
        if "address" in emsg or "adresse" in emsg:
            hint = "Adresse crypto invalide."
        elif "amount" in emsg or "minimum" in emsg or "maximum" in emsg:
            hint = "Montant hors de la plage acceptée par la passerelle."
        elif "coin" in emsg or "asset" in emsg or "network" in emsg:
            hint = "Crypto ou réseau non supporté. Vérifiez `coin` et `accepted_networks`."
        elif "unauthorized" in emsg or "api key" in emsg or "credentials" in emsg or e.status == 401:
            hint = ("Clé passerelle upstream invalide côté serveur. "
                    "Contactez le support Biz-transPay.")
        raise BizAPIError(
            400 if e.status < 500 else 502,
            f"Crypto gateway rejected the request: {e.message}",
            "GATEWAY_ERROR" if e.status >= 500 else "GATEWAY_REJECTED",
            details={
                "upstream_status": e.status,
                "upstream_code": e.code,
                "upstream_message": e.message,
                "hint": hint,
            },
        )
    except Exception as exc:  # ambiguous upstream outcome: retain reservation
        pending = {
            "id": mp_id, "merchant_id": merchant["id"],
            "environment": "live", "product": "bizpay_checkout",
            "source": "merchant_api", "amount": payload.amount,
            "amount_gross": payload.amount, "amount_net": amount_net,
            "fee": fee, "fee_pct": fee_pct,
            "gateway_fee": gateway_fee, "platform_fee": platform_fee,
            "coin": payload.coin.upper(), "reference": payload.reference or mp_id,
            "merchant_reference": payload.reference or mp_id,
            "status": "pending", "provider_status_unknown": True,
            "metadata": payload.metadata or {}, "created_at": now_iso(),
        }
        await db.merchant_payments.insert_one(pending)
        body = _serialize_payment(pending)
        if idem_key:
            await _idempotency_store(owner, idem_key, "POST",
                                     "/api/v1/payments", 200, body)
        logger.warning("ambiguous checkout upstream outcome: %s", exc)
        raise BizAPIError(502, "Payment status is pending reconciliation.",
                          "PAYMENT_STATUS_UNKNOWN")

    expires_dt = datetime.now(timezone.utc) + timedelta(minutes=10)
    doc = {
        "id": mp_id,
        "merchant_id": merchant["id"],
        "environment": "live",
        "product": "bizpay_checkout",
        "source": "merchant_api",
        "amount": payload.amount,
        "amount_gross": payload.amount,
        "amount_net": amount_net,
        "fee": fee,
        "fee_pct": fee_pct,
        "gateway_fee": gateway_fee,
        "platform_fee": platform_fee,
        "coin": payload.coin.upper(),
        "reference": payload.reference or mp_id,
        "merchant_reference": payload.reference or mp_id,
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

    body = _serialize_payment(doc)
    if idem_key:
        try:
            await _idempotency_store(owner, idem_key, "POST",
                                     "/api/v1/payments", 200, body)
        except Exception:
            pass
    return body


@api.post("/v1/test/payments/{payment_id}/complete")
async def complete_sandbox_payment(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    if merchant.get("_api_env") != "test":
        raise BizAPIError(403, "This simulation is only available with test keys.",
                          "TEST_KEY_REQUIRED")
    collection = db.merchant_payments
    doc = await collection.find_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         "environment": "test", "product": "bizpay_checkout"}, {"_id": 0})
    if not doc:
        collection = db.momo_deposits
        doc = await collection.find_one(
            {"id": payment_id, "merchant_id": merchant["id"],
             "environment": "test",
             "product": {"$in": ["bizpay_checkout", "bizpay_direct"]}},
            {"_id": 0})
    if not doc:
        raise BizAPIError(404, "Test payment not found.", "PAYMENT_NOT_FOUND")
    await collection.update_one(
        {"id": payment_id, "merchant_id": merchant["id"], "environment": "test",
         "status": {"$nin": ["paid", "failed", "canceled"]}},
        {"$set": {"status": "paid", "updated_at": now_iso(),
                  "completed_at": now_iso()}},
    )
    fresh = await collection.find_one(
        {"id": payment_id, "merchant_id": merchant["id"], "environment": "test"},
        {"_id": 0},
    ) or doc
    # Claiming on the transaction document makes webhook emission safe even
    # when the completion endpoint is retried concurrently.
    claim = await collection.update_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         "environment": "test", "test_webhook_claimed": {"$ne": True}},
        {"$set": {"test_webhook_claimed": True}},
    )
    if claim.modified_count:
        await _deliver_webhook(merchant["id"], "payment.completed", {
            "id": payment_id, "status": "paid", "amount": fresh.get("amount"),
            "currency": fresh.get("currency") or fresh.get("coin"),
            "reference": fresh.get("reference"),
            "environment": "test", "source": "merchant_api",
        })
    return _serialize_payment(fresh)


@api.post("/v1/bizpay/checkout")
async def bizpay_checkout(payload: MerchantPaymentRequest, request: Request):
    """Hosted BizPay checkout alias; the historical payments route remains
    available for existing integrations."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "checkout:create")
    if not (request.headers.get("Idempotency-Key") or "").strip():
        raise BizAPIError(400, "Idempotency-Key is required for checkout.",
                          "IDEMPOTENCY_KEY_REQUIRED")
    return await merchant_create_payment(payload, request)


@api.get("/v1/bizpay/checkout/{payment_id}")
async def bizpay_checkout_details(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    return await merchant_get_payment(payment_id, request)


@api.get("/v1/bizpay/checkout/{payment_id}/status")
async def bizpay_checkout_status(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    return await merchant_get_payment_status(payment_id, request)


@api.get("/v1/payments")
async def merchant_list_payments(request: Request,
                                  limit: int = Query(50, ge=1, le=200),
                                  offset: int = Query(0, ge=0),
                                  status: Optional[str] = None,
                                  reference: Optional[str] = None):
    """Paginated list of the merchant's payments. Filter by `status` or
    `reference` if provided. `offset` allows page-based pagination."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    q: dict = {"merchant_id": merchant["id"],
               "environment": merchant.get("_api_env", "test")}
    if status:
        q["status"] = status
    if reference:
        q["reference"] = reference
    total = await db.merchant_payments.count_documents(q)
    docs = await db.merchant_payments.find(q, {"_id": 0}) \
        .sort("created_at", -1).skip(offset).limit(limit + 1).to_list(limit + 1)
    has_more = len(docs) > limit
    docs = docs[:limit]

    # Best-effort background reconcile for pending payments in the page —
    # fire-and-forget so the response stays snappy.
    pending_ids = [d["izipay_intent_id"] for d in docs
                   if d.get("status") not in ("paid", "expired", "failed", "canceled")
                   and d.get("izipay_intent_id")]
    for intent_id in pending_ids[:10]:  # cap to avoid spamming upstream
        asyncio.create_task(_safe_reconcile(intent_id))

    return {
        "data": [_serialize_payment(d) for d in docs],
        "count": len(docs),
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
    }


@api.get("/v1/payments/search")
async def merchant_search_payment(request: Request,
                                    reference: str = Query(..., min_length=1)):
    """Search the most recent payment carrying this merchant `reference`.
    Returns 404 if no payment matches. Sync with upstream before returning."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    mp = await db.merchant_payments.find_one(
        {"merchant_id": merchant["id"], "environment": merchant.get("_api_env", "test"),
         "reference": reference},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if not mp:
        raise BizAPIError(404, "No payment found for this reference",
                          "PAYMENT_NOT_FOUND")
    if mp.get("status") not in ("paid", "expired", "failed", "canceled") \
            and mp.get("izipay_intent_id"):
        await _reconcile_intent(mp["izipay_intent_id"])
        mp = await db.merchant_payments.find_one(
            {"merchant_id": merchant["id"], "environment": merchant.get("_api_env", "test"),
             "reference": reference},
            {"_id": 0},
            sort=[("created_at", -1)],
        ) or mp
    return _serialize_payment(mp)


@api.get("/v1/payments/{payment_id}")
async def merchant_get_payment(payment_id: str, request: Request):
    """Full details for a single payment. Triggers an upstream sync when the
    payment is still pending so the returned data is always fresh."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    _require_merchant_scope(merchant, "payments:read")
    momo = await db.momo_deposits.find_one(
        {"id": payment_id, "user_id": merchant["id"],
         **_api_environment_clause(merchant),
         "product": {"$in": ["bizpay_checkout", "bizpay_direct"]}}, {"_id": 0})
    if momo:
        if momo.get("status") == "pending":
            if momo.get("provider") == "mbiyo":
                await _reconcile_mbiyo_deposit(payment_id)
            else:
                await _reconcile_momo_deposit(payment_id)
            momo = await db.momo_deposits.find_one(
                {"id": payment_id, "user_id": merchant["id"],
                 "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or momo
        return _developer_payment_view(momo)
    mp = await db.merchant_payments.find_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         **_api_environment_clause(merchant)}, {"_id": 0})
    if not mp:
        raise BizAPIError(404, "Payment not found", "PAYMENT_NOT_FOUND")
    if mp.get("status") not in ("paid", "expired", "failed", "canceled") \
            and mp.get("izipay_intent_id"):
        await _reconcile_intent(mp["izipay_intent_id"])
        mp = await db.merchant_payments.find_one(
            {"id": payment_id, "merchant_id": merchant["id"],
             "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or mp
    return _serialize_payment(mp)


@api.get("/v1/payments/{payment_id}/status")
async def merchant_get_payment_status(payment_id: str, request: Request):
    """Lightweight status endpoint. Returns `{id, status, updated_at}` — cheaper
    than the full resource, ideal for repeated polling. Auto-syncs upstream."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    _require_merchant_scope(merchant, "payments:read")
    momo = await db.momo_deposits.find_one(
        {"id": payment_id, "user_id": merchant["id"],
         **_api_environment_clause(merchant),
         "product": {"$in": ["bizpay_checkout", "bizpay_direct"]}}, {"_id": 0})
    if momo:
        if momo.get("status") == "pending":
            if momo.get("provider") == "mbiyo":
                await _reconcile_mbiyo_deposit(payment_id)
            else:
                await _reconcile_momo_deposit(payment_id)
            momo = await db.momo_deposits.find_one(
                {"id": payment_id, "user_id": merchant["id"],
                 "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or momo
        return {"id": momo["id"],
                "status": "paid" if momo.get("status") == "approved" else momo.get("status"),
                "updated_at": _format_iso(momo.get("updated_at")
                                           or momo.get("created_at", ""))}
    mp = await db.merchant_payments.find_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         **_api_environment_clause(merchant)}, {"_id": 0})
    if not mp:
        raise BizAPIError(404, "Payment not found", "PAYMENT_NOT_FOUND")
    if mp.get("status") not in ("paid", "expired", "failed", "canceled") \
            and mp.get("izipay_intent_id"):
        await _reconcile_intent(mp["izipay_intent_id"])
        mp = await db.merchant_payments.find_one(
            {"id": payment_id, "merchant_id": merchant["id"],
             "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or mp
    return {
        "id": mp["id"],
        "status": mp.get("status"),
        "updated_at": _format_iso(mp.get("paid_at") or mp.get("canceled_at")
                                   or mp.get("created_at", "")),
    }


@api.get("/v1/payments/{payment_id}/completed")
async def merchant_check_completed(payment_id: str, request: Request):
    """Returns `{completed, status}`. `completed` is `true` only when the
    payment status is `paid`. Auto-syncs with upstream."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    momo = await db.momo_deposits.find_one(
        {"id": payment_id, "user_id": merchant["id"],
         **_api_environment_clause(merchant),
         "product": {"$in": ["bizpay_checkout", "bizpay_direct"]}}, {"_id": 0})
    if momo:
        if momo.get("status") == "pending":
            if momo.get("provider") == "mbiyo":
                await _reconcile_mbiyo_deposit(payment_id)
            else:
                await _reconcile_momo_deposit(payment_id)
            momo = await db.momo_deposits.find_one(
                {"id": payment_id, "user_id": merchant["id"],
                 "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or momo
        public_status = "paid" if momo.get("status") == "approved" else momo.get("status")
        return {
            "id": momo["id"],
            "completed": public_status == "paid",
            "status": public_status,
        }
    mp = await db.merchant_payments.find_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         "environment": merchant.get("_api_env", "test")}, {"_id": 0})
    if not mp:
        raise BizAPIError(404, "Payment not found", "PAYMENT_NOT_FOUND")
    if mp.get("status") not in ("paid", "expired", "failed", "canceled") \
            and mp.get("izipay_intent_id"):
        await _reconcile_intent(mp["izipay_intent_id"])
        mp = await db.merchant_payments.find_one(
            {"id": payment_id, "merchant_id": merchant["id"],
             "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or mp
    return {
        "id": mp["id"],
        "completed": mp.get("status") == "paid",
        "status": mp.get("status"),
    }


@api.post("/v1/payments/{payment_id}/cancel")
async def merchant_cancel_payment(payment_id: str, request: Request):
    """Cancel a pending payment. Only payments in `initiated` or `confirming`
    state can be canceled — if the customer has already paid, `409` is
    returned. Always re-syncs with upstream first."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "checkout:create")
    mp = await db.merchant_payments.find_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         "environment": merchant.get("_api_env", "test")}, {"_id": 0})
    if not mp:
        raise BizAPIError(404, "Payment not found", "PAYMENT_NOT_FOUND")
    # Force a fresh sync so we do not cancel something that just got paid.
    if mp.get("izipay_intent_id") and mp.get("status") not in (
            "paid", "expired", "failed", "canceled"):
        await _reconcile_intent(mp["izipay_intent_id"])
        mp = await db.merchant_payments.find_one(
            {"id": payment_id, "merchant_id": merchant["id"],
             "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or mp

    status = mp.get("status")
    if status == "paid":
        raise BizAPIError(409, "Cannot cancel a payment that has been paid.",
                          "PAYMENT_ALREADY_PAID")
    if status in ("canceled", "expired", "failed"):
        # Already terminal — return current state (idempotent cancel).
        return _serialize_payment(mp)

    await db.merchant_payments.update_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         "environment": merchant.get("_api_env", "test")},
        {"$set": {"status": "canceled", "canceled_at": now_iso()}},
    )
    mp = await db.merchant_payments.find_one(
        {"id": payment_id, "merchant_id": merchant["id"],
         "environment": merchant.get("_api_env", "test")}, {"_id": 0}) or mp
    return _serialize_payment(mp)


async def _safe_reconcile(intent_id: str) -> None:
    """Wrap _reconcile_intent so a stray exception in a background task
    never propagates and crashes the caller."""
    try:
        await _reconcile_intent(intent_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("background reconcile failed for %s: %s", intent_id, e)


# ==================== BIZPAY DIRECT (Mobile Money, no redirect) ====================
class BizPayDirectRequest(BaseModel):
    amount: float = Field(..., gt=0)
    currency: Literal["XOF", "XAF", "CDF", "USD", "GMD", "GNF", "UGX",
                      "TZS", "KES", "RWF", "GHS", "NGN", "ZAR", "ZMW", "EGP"]
    country: str = Field(..., min_length=2, max_length=2)
    operator: str = Field(..., min_length=2, max_length=64)
    customer_phone: str = Field(..., min_length=6, max_length=32)
    customer_email: Optional[str] = None
    reference: Optional[str] = Field(None, min_length=1, max_length=128)
    return_url: Optional[str] = None
    metadata: Optional[dict] = None


class DeveloperCheckoutRequest(BaseModel):
    amount: float = Field(..., gt=0)
    currency: Literal["XOF", "XAF", "CDF", "USD", "GMD", "GNF", "UGX",
                      "TZS", "KES", "RWF", "GHS", "NGN", "ZAR", "ZMW", "EGP"]
    country: str = Field(..., min_length=2, max_length=2)
    operator: str = Field(..., min_length=2, max_length=64)
    customer_phone: Optional[str] = Field(None, min_length=6, max_length=32)
    customer_email: Optional[str] = None
    customer_name: str = Field("Client", min_length=1, max_length=120)
    fee_bearer: Literal["client", "merchant"] = "client"
    reference: Optional[str] = Field(None, min_length=1, max_length=128)
    return_url: Optional[str] = None
    metadata: Optional[dict] = None


async def _developer_operator(merchant: dict, payload: Any) -> tuple[dict, dict]:
    environment = merchant.get("_api_env", "test")
    # Sandbox only needs the admin catalogue.  Decrypting credentials here
    # must never make a test request depend on provider secrets.
    try:
        mb_cfg = await get_mbiyo_config(decrypt=environment == "live")
    except (AttributeError, TypeError):
        mb_cfg = {}
    mb_op = _active_mbiyo_operator(
        mb_cfg.get("catalog") or [], payload.country, payload.operator)
    if mb_op and str(mb_op.get("currency", "")).upper() != payload.currency.upper():
        mb_op = None
    cfg = await get_paydunya_config(decrypt=environment == "live")
    if cfg.get("enabled") and (
        environment != "live" or _paydunya_credentials_configured(cfg)
    ):
        op = next((item for item in cfg.get("catalog", [])
                   if str(item.get("country", "")).upper() == payload.country.upper()
                   and str(item.get("code", "")).lower() == payload.operator.lower()
                   and str(item.get("currency", payload.currency)).upper() == payload.currency.upper()
                   and item.get("active", True)
                   and not item.get("archived", False)
                   and not item.get("hidden", False)), None)
    else:
        op = None
    if op:
        # PayDunya is the first configured provider in the public catalogue.
        currency = str(op.get("currency") or payload.currency).upper()
        if currency != payload.currency.upper():
            raise BizAPIError(400, "The currency is not supported by this method.",
                              "CURRENCY_NOT_SUPPORTED")
        cfg["_gateway_provider"] = "paydunya"
        return cfg, op
    mbiyo_ready = mb_cfg.get("enabled", False) and (
        environment != "live" or bool(mb_cfg.get("_api_key"))
    )
    if mb_op and mbiyo_ready:
        mb_cfg["_gateway_provider"] = "mbiyo"
        return mb_cfg, mb_op
    if not cfg.get("enabled"):
        raise BizAPIError(503, "Payment service is temporarily unavailable.",
                          "PAYMENT_SERVICE_UNAVAILABLE")
    if not op:
        raise BizAPIError(400, "The selected payment method is unavailable.",
                          "PAYMENT_METHOD_UNAVAILABLE")
    currency = str(op.get("currency") or payload.currency).upper()
    if currency != payload.currency.upper():
        raise BizAPIError(400, "The currency is not supported by this method.",
                          "CURRENCY_NOT_SUPPORTED")
    if payload.amount < float(op.get("min", 100)):
        raise BizAPIError(400, "Amount is below the minimum allowed.",
                          "AMOUNT_TOO_SMALL")
    maximum = float(op.get("max", 0) or 0)
    if maximum and payload.amount > maximum:
        raise BizAPIError(400, "Amount exceeds the maximum allowed.",
                          "AMOUNT_TOO_LARGE")
    cfg["_gateway_provider"] = "paydunya"
    return cfg, op


async def _developer_withdrawal_operator(merchant: dict,
                                         payload: Any) -> tuple[dict, dict]:
    """Resolve a sandbox Mobile Money withdrawal from the withdrawal catalog.

    Test keys may inspect admin pricing, but must not decrypt or call a
    provider credential.  The live transfer path remains responsible for
    choosing the actual provider.
    """
    try:
        mb_cfg = await get_mbiyo_config(decrypt=merchant.get("_api_env") == "live")
    except (AttributeError, TypeError):
        mb_cfg = {}
    mb_op = _active_mbiyo_operator(
        mb_cfg.get("catalog") or [], payload.country, payload.operator)
    if mb_op and str(mb_op.get("currency", "")).upper() != payload.currency.upper():
        mb_op = None
    cfg = await get_transfer_config()
    mobile_money = cfg.get("mobile_money") or {}
    environment = merchant.get("_api_env", "test")
    if not mobile_money.get("enabled"):
        raise BizAPIError(503, "Withdrawal service is temporarily unavailable.",
                          "WITHDRAWAL_SERVICE_UNAVAILABLE")
    op = _active_operator(
        mobile_money.get("operators") or [], payload.country, payload.operator)
    if op and (
            (environment == "live"
             and not (cfg.get("paydunya") or {}).get("enabled"))
            or (environment == "live" and not op.get("withdraw_mode"))
            or str(op.get("currency") or "").upper() != payload.currency.upper()):
        op = None
    if op:
        return cfg, op
    mbiyo_ready = mb_cfg.get("enabled", False) and (
        merchant.get("_api_env", "test") != "live" or bool(mb_cfg.get("_api_key"))
    )
    if mb_op and mbiyo_ready:
        mb_cfg["_gateway_provider"] = "mbiyo"
        return mb_cfg, mb_op
    if not op and not mb_op:
        raise BizAPIError(400, "The selected withdrawal method is unavailable.",
                          "PAYMENT_METHOD_UNAVAILABLE")
    if payload.currency.upper() not in PAYDUNYA_WALLET_CURRENCIES:
        raise BizAPIError(400, "The currency is not supported by this method.",
                          "CURRENCY_NOT_SUPPORTED")
    currency = str(op.get("currency") or payload.currency).upper()
    if currency != payload.currency.upper():
        raise BizAPIError(400, "The currency is not supported by this method.",
                          "CURRENCY_NOT_SUPPORTED")
    if payload.amount < float(op.get("min", 0) or 0):
        raise BizAPIError(400, "Amount is below the minimum allowed.",
                          "AMOUNT_TOO_SMALL")
    maximum = float(op.get("max", 0) or 0)
    if maximum and payload.amount > maximum:
        raise BizAPIError(400, "Amount exceeds the maximum allowed.",
                          "AMOUNT_TOO_LARGE")
    return cfg, op


def _developer_owner(merchant: dict) -> str:
    """Partition idempotency and new records by merchant and environment."""
    return f"{merchant['id']}:{merchant.get('_api_env', 'test')}"


def _api_environment_clause(merchant: dict) -> dict:
    """Live keys may read pre-API rows; sandbox must remain isolated."""
    if merchant.get("_api_env", "test") == "live":
        return {"$or": [{"environment": "live"},
                        {"environment": {"$exists": False}}]}
    return {"environment": "test"}


def _sandbox_checkout_url(payment_id: str) -> str:
    # There is no hosted customer UI in the API service.  Never advertise a
    # route that could 404; callers use simulation_endpoint instead.
    return None


def _developer_payment_view(doc: dict) -> dict:
    public_status = "paid" if doc.get("status") == "approved" else doc.get("status", "pending")
    return {
        "id": doc["id"], "object": "payment", "product": doc.get("product"),
        "status": public_status,
        "amount": _format_amount(doc.get("amount", 0)),
        "requested_amount": _format_amount(
            doc.get("requested_amount", doc.get("amount", 0))),
        "charged_amount": _format_amount(
            doc.get("charged_amount", doc.get("amount", 0))),
        "wallet_credit_amount": _format_amount(
            doc.get("wallet_credit_amount", doc.get("amount_net", doc.get("amount", 0)))),
        "gateway_fee": _format_amount(doc.get("gateway_fee", 0))
            if doc.get("gateway_fee") is not None else None,
        "platform_fee": _format_amount(doc.get("platform_fee", 0))
            if doc.get("platform_fee") is not None else None,
        "fee": _format_amount(doc.get("total_fee", doc.get("fee", 0)))
            if doc.get("total_fee", doc.get("fee")) is not None else None,
        "fee_bearer": doc.get("fee_bearer"),
        "currency": doc.get("currency"), "reference": doc.get("reference"),
        "checkout_url": doc.get("checkout_url"),
        "country": doc.get("country"), "operator": doc.get("operator"),
        "created_at": _format_iso(doc.get("created_at", "")),
        "updated_at": _format_iso(doc.get("updated_at") or doc.get("created_at", "")),
        "metadata": doc.get("metadata") or {},
        "simulation_endpoint": doc.get("simulation_endpoint"),
    }


async def _developer_checkout(payload: DeveloperCheckoutRequest, request: Request,
                              product: str,
                              idem_path: str = "/api/v1/checkout") -> dict:
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "checkout:create")
    idem = (request.headers.get("Idempotency-Key") or "").strip()
    if not idem:
        raise BizAPIError(400, "Idempotency-Key is required.", "IDEMPOTENCY_KEY_REQUIRED")
    fp = _request_fingerprint(payload)
    owner = _developer_owner(merchant)
    local_id = None
    cached = await _idempotency_claim(owner, idem, "POST", idem_path, fp)
    if cached and cached.get("body") is not None:
        return cached["body"]
    try:
        if payload.reference and await db.momo_deposits.find_one(
            {"user_id": merchant["id"], "environment": merchant.get("_api_env", "test"),
             "merchant_reference": payload.reference},
            {"_id": 1},
        ):
            raise BizAPIError(409, "Reference already used.", "REFERENCE_ALREADY_USED")
        resolved_cfg, resolved_op = await _developer_operator(merchant, payload)
        if resolved_cfg.get("_gateway_provider") == "mbiyo" and merchant.get("_api_env") == "live":
            mb_req = MobileMoneyDepositRequest(
                amount=payload.amount, currency=payload.currency,
                email=payload.customer_email or "customer@checkout.invalid",
                full_name=payload.customer_name, country=payload.country,
                operator=payload.operator, phone_number=payload.customer_phone or "",
                fee_bearer=payload.fee_bearer,
                idempotency_key=idem,
            )
            result = await _create_mbiyo_deposit(
                mb_req, request, merchant["id"],
                record_context={
                    "merchant_id": merchant["id"],
                    "source": "merchant_api",
                    "environment": "live",
                    "product": product,
                    "reference": payload.reference,
                    "merchant_reference": payload.reference,
                    "metadata": payload.metadata or {},
                },
            )
            await db.momo_deposits.update_one(
                {"id": result["id"]},
                {"$set": {"merchant_id": merchant["id"], "source": "merchant_api",
                          "environment": "live", "product": product,
                           "reference": payload.reference or result["id"],
                           "merchant_reference": payload.reference or result["id"],
                           "metadata": payload.metadata or {}}},
            )
            doc = await db.momo_deposits.find_one({"id": result["id"]}, {"_id": 0})
            body = _developer_payment_view(doc)
            await _idempotency_store(owner, idem, "POST", idem_path, 200, body)
            return body
        req = PayDunyaInvoiceRequest(
            amount=payload.amount, currency=payload.currency,
            email=payload.customer_email or "customer@checkout.invalid",
            full_name=payload.customer_name, country=payload.country,
            operator=payload.operator, phone_number=payload.customer_phone,
            fee_bearer=payload.fee_bearer,
            return_url=payload.return_url,
            description=f"BizPay Checkout {payload.reference or ''}".strip(),
        )
        if merchant.get("_api_env") == "test":
            _, op = await _developer_operator(merchant, payload)
            fees = paydunya.calculate_fees(payload.amount, op, payload.fee_bearer)
            dep_id = new_id()
            now = now_iso()
            doc = {
                "id": dep_id, "user_id": merchant["id"],
                "merchant_id": merchant["id"], "source": "merchant_api",
                "reference": payload.reference or dep_id,
                "merchant_reference": payload.reference or dep_id,
                "environment": "test", "product": product,
                "amount": payload.amount,
                "requested_amount": fees["requested_amount"],
                "charged_amount": fees["charged_amount"],
                "wallet_credit_amount": fees["wallet_credit_amount"],
                "gateway_fee": fees["gateway_fee"],
                "platform_fee": fees["platform_fee"],
                "total_fee": fees["total_fee"],
                "fee_snapshot": fees,
                "fee_bearer": fees["fee_bearer"],
                "currency": payload.currency,
                "country": payload.country.upper(), "operator": payload.operator,
                "status": "pending", "checkout_url": _sandbox_checkout_url(dep_id),
                "simulation_endpoint": f"/api/v1/test/payments/{dep_id}/complete",
                "metadata": payload.metadata or {}, "created_at": now,
                "updated_at": now,
            }
            await db.momo_deposits.insert_one(doc)
        else:
            result = await _create_paydunya_invoice_deposit(
                req, merchant["id"], "par_redirect", _paydunya_callback_base(request)
            )
            local_id = result.get("id")
            await db.momo_deposits.update_one(
                {"id": result["id"], "user_id": merchant["id"]},
                {"$set": {"merchant_id": merchant["id"],
                          "source": "merchant_api",
                          "reference": payload.reference or result["id"],
                          "merchant_reference": payload.reference or result["id"],
                          "environment": "live", "product": product,
                          "metadata": payload.metadata or {}}},
            )
            doc = await db.momo_deposits.find_one({"id": result["id"]}, {"_id": 0})
        body = _developer_payment_view(doc)
        await _idempotency_store(owner, idem, "POST", idem_path, 200, body)
        return body
    except Exception:
        if local_id:
            doc = await db.momo_deposits.find_one(
                {"id": local_id, "user_id": merchant["id"],
                 "environment": merchant.get("_api_env", "test")}, {"_id": 0})
            if doc:
                await db.momo_deposits.update_one(
                    {"id": local_id, "user_id": merchant["id"]},
                    {"$set": {"source": "merchant_api",
                              "environment": merchant.get("_api_env", "test"),
                              "product": product, "status": "pending",
                              "provider_status_unknown": True,
                              "merchant_reference": payload.reference or local_id,
                              "updated_at": now_iso()}},
                )
                doc.update({"source": "merchant_api",
                            "environment": merchant.get("_api_env", "test"),
                            "product": product, "status": "pending",
                            "provider_status_unknown": True})
                try:
                    await _idempotency_store(
                        owner, idem, "POST", idem_path, 200,
                        _developer_payment_view(doc))
                except Exception:
                    pass
        else:
            await _idempotency_release(owner, idem, fp)
        raise


@api.post("/v1/checkout")
async def developer_checkout(payload: DeveloperCheckoutRequest, request: Request):
    return await _developer_checkout(payload, request, "bizpay_checkout")


@api.post("/v1/direct-payments")
async def developer_direct_payment(payload: BizPayDirectRequest, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "direct:create")
    idem = (request.headers.get("Idempotency-Key") or "").strip()
    if not idem:
        raise BizAPIError(400, "Idempotency-Key is required.", "IDEMPOTENCY_KEY_REQUIRED")
    fp = _request_fingerprint(payload)
    owner = _developer_owner(merchant)
    cached = await _idempotency_claim(owner, idem, "POST",
                                      "/api/v1/direct-payments", fp)
    if cached and cached.get("body") is not None:
        return cached["body"]
    try:
        cfg, op = await _developer_operator(merchant, payload)
        if payload.reference and await db.momo_deposits.find_one(
            {"user_id": merchant["id"], "environment": merchant.get("_api_env", "test"),
             "merchant_reference": payload.reference},
            {"_id": 1},
        ):
            raise BizAPIError(409, "Reference already used.", "REFERENCE_ALREADY_USED")
        fees = paydunya.calculate_fees(payload.amount, op, "client")
        dep_id = new_id()
        if cfg.get("_gateway_provider") == "mbiyo" and merchant.get("_api_env") == "live":
            mb_req = MobileMoneyDepositRequest(
                amount=payload.amount, currency=payload.currency,
                email=payload.customer_email or "customer@direct.invalid",
                full_name="Client", country=payload.country, operator=payload.operator,
                phone_number=payload.customer_phone or "",
                idempotency_key=idem,
            )
            result = await _create_mbiyo_deposit(
                mb_req, request, merchant["id"],
                record_context={
                    "merchant_id": merchant["id"],
                    "source": "merchant_api",
                    "environment": "live",
                    "product": "bizpay_direct",
                    "reference": payload.reference,
                    "merchant_reference": payload.reference,
                    "metadata": payload.metadata or {},
                },
            )
            await db.momo_deposits.update_one(
                {"id": result["id"]},
                {"$set": {"merchant_id": merchant["id"], "source": "merchant_api",
                          "environment": "live", "product": "bizpay_direct",
                           "reference": payload.reference or result["id"],
                           "merchant_reference": payload.reference or result["id"],
                           "metadata": payload.metadata or {}}},
            )
            doc = await db.momo_deposits.find_one({"id": result["id"]}, {"_id": 0})
            body = _developer_payment_view(doc)
            await _idempotency_store(owner, idem, "POST", "/api/v1/direct-payments", 200, body)
            return body
        if merchant.get("_api_env") == "test":
            now = now_iso()
            doc = {
                "id": dep_id, "user_id": merchant["id"],
                "merchant_id": merchant["id"], "source": "merchant_api",
                "reference": payload.reference or dep_id,
                "merchant_reference": payload.reference or dep_id,
                "environment": "test", "product": "bizpay_direct",
                "amount": payload.amount, "requested_amount": fees["requested_amount"],
                "charged_amount": fees["charged_amount"],
                "wallet_credit_amount": fees["wallet_credit_amount"],
                "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
                "total_fee": fees["total_fee"], "fee_bearer": fees["fee_bearer"],
                "fee_snapshot": fees,
                "currency": payload.currency, "country": payload.country.upper(),
                "operator": payload.operator, "phone_number": payload.customer_phone,
                "status": "pending", "metadata": payload.metadata or {},
                "simulation_endpoint": f"/api/v1/test/payments/{dep_id}/complete",
                "created_at": now, "updated_at": now,
            }
            await db.momo_deposits.insert_one(doc)
            body = _developer_payment_view(doc)
            await _idempotency_store(owner, idem, "POST",
                                     "/api/v1/direct-payments", 200, body)
            return body
        base = _paydunya_callback_base(request)
        customer_name = "Client"
        try:
            invoice = await paydunya.create_invoice(
                cfg, amount=fees["charged_amount"], currency=payload.currency,
                token=dep_id,
                customer={"firstname": customer_name,
                          "lastname": customer_name,
                          "email": payload.customer_email or "customer@direct.invalid",
                          "phone_number": payload.customer_phone},
                callback_url=f"{base}/api/webhooks/paydunya?ref={dep_id}",
                return_url=payload.return_url or f"{base}/api/v1/payments/{dep_id}",
                cancel_url=payload.return_url or "",
                description=f"BizPay Direct {payload.reference or ''}".strip(),
            )
            token = paydunya.invoice_token(invoice)
            if not token:
                raise BizAPIError(502, "Payment service returned an invalid transaction.",
                                  "PAYMENT_SERVICE_ERROR")
            now = now_iso()
            doc = {
                "id": dep_id, "user_id": merchant["id"], "merchant_id": merchant["id"],
                "source": "merchant_api",
                "reference": payload.reference or dep_id,
                "merchant_reference": payload.reference,
                "environment": "live",
                "product": "bizpay_direct", "amount": payload.amount,
                "requested_amount": fees["requested_amount"],
                "charged_amount": fees["charged_amount"],
                "wallet_credit_amount": fees["wallet_credit_amount"],
                "gateway_fee": fees["gateway_fee"], "platform_fee": fees["platform_fee"],
                "total_fee": fees["total_fee"], "fee_snapshot": fees,
                "currency": payload.currency, "country": payload.country.upper(),
                "operator": payload.operator, "operator_snapshot": dict(op),
                "phone_number": payload.customer_phone,
                "email": payload.customer_email, "paydunya_token": token,
                "checkout_url": paydunya.checkout_url(invoice), "status": "pending",
                "provider": "paydunya", "provider_mode": cfg.get("mode", "test"),
                "paydunya_flow": "softpay_direct", "prompt_sent": False,
                "metadata": payload.metadata or {}, "created_at": now, "updated_at": now,
            }
            await db.momo_deposits.insert_one(doc)
            await paydunya.softpay_payment(
                cfg, invoice_token=token, operator=op,
                phone=payload.customer_phone, amount=fees["charged_amount"],
                currency=payload.currency, customer_name=customer_name,
                customer_email=payload.customer_email or "customer@direct.invalid",
            )
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {"prompt_sent": True, "updated_at": now_iso()}},
            )
            doc["prompt_sent"] = True
            body = _developer_payment_view(doc)
            await _idempotency_store(owner, idem, "POST",
                                     "/api/v1/direct-payments", 200, body)
            return body
        except paydunya.PayDunyaError as exc:
            await db.momo_deposits.update_one(
                {"id": dep_id, "status": "pending"},
                {"$set": {"status": "failed", "prompt_error": "Payment service error",
                          "updated_at": now_iso()}},
            )
            raise BizAPIError(400 if exc.status < 500 else 502,
                              "Payment service rejected the transaction.",
                              "PAYMENT_SERVICE_ERROR")
    except Exception:
        # Do not release after a provider call may have accepted the request.
        # A timeout is persisted as pending/unknown for reconciliation.
        if "doc" in locals() and doc.get("paydunya_token"):
            await db.momo_deposits.update_one(
                {"id": doc["id"], "environment": "live"},
                {"$set": {"status": "pending", "provider_status_unknown": True,
                          "prompt_sent": False, "updated_at": now_iso()}},
            )
            durable = await db.momo_deposits.find_one(
                {"id": doc["id"], "environment": "live"}, {"_id": 0}
            ) or doc
            await _idempotency_store(
                owner, idem, "POST", "/api/v1/direct-payments", 200,
                _developer_payment_view(durable),
            )
        else:
            await _idempotency_release(owner, idem, fp)
        raise


class BizPushRequest(BaseModel):
    amount: float = Field(..., gt=0)
    currency: Literal["XOF", "XAF", "CDF", "USD", "GMD", "GNF", "UGX",
                      "TZS", "KES", "RWF", "GHS", "NGN", "ZAR", "ZMW", "EGP"]
    country: str = Field(..., min_length=2, max_length=2)
    operator: str = Field(..., min_length=2, max_length=64)
    beneficiary_phone: str = Field(..., min_length=6, max_length=32)
    beneficiary_name: Optional[str] = None
    beneficiary_email: Optional[str] = None
    reference: Optional[str] = Field(None, min_length=1, max_length=128)
    metadata: Optional[dict] = None


def _developer_push_view(result: dict) -> dict:
    tx = result.get("transaction") or {}
    meta = tx.get("metadata") or {}
    return {
        "id": tx.get("id"), "object": "payout", "product": "bizpush",
        "status": tx.get("status"), "amount": _format_amount(tx.get("amount", 0)),
        "currency": tx.get("currency"), "reference": tx.get("reference"),
        "fee": result.get("fee", meta.get("fee", 0)),
        "total_debit": result.get("total_debit", meta.get("total_debit")),
        "created_at": _format_iso(tx.get("created_at", "")),
        "updated_at": _format_iso(tx.get("updated_at") or tx.get("created_at", "")),
        "metadata": tx.get("public_metadata") or {},
    }


@api.post("/v1/push")
async def developer_push(payload: BizPushRequest, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "push:create")
    idem = (request.headers.get("Idempotency-Key") or "").strip()
    if not idem:
        raise BizAPIError(400, "Idempotency-Key is required.", "IDEMPOTENCY_KEY_REQUIRED")
    fp = _request_fingerprint(payload)
    owner = _developer_owner(merchant)
    cached = await _idempotency_claim(owner, idem, "POST", "/api/v1/push", fp)
    if cached and cached.get("body") is not None:
        return cached["body"]
    try:
        if merchant.get("_api_env") == "test":
            _, op = await _developer_withdrawal_operator(merchant, payload)
            fees = paydunya.calculate_fees(payload.amount, op, "sender")
            tx_id = new_id()
            now = now_iso()
            reference = payload.reference or tx_id
            doc = {
                "id": tx_id, "user_id": merchant["id"], "type": "transfer",
                "direction": "out", "amount": payload.amount,
                "currency": payload.currency, "status": "pending",
                "counterparty": payload.beneficiary_phone, "reference": reference,
                "created_at": now, "updated_at": now,
                "metadata": {
                    "source": "merchant_api", "environment": "test",
                    "product": "bizpush", "country": payload.country.upper(),
                    "operator": payload.operator,
                    "recipient_phone": payload.beneficiary_phone,
                    "fee": fees["total_fee"],
                    "gateway_fee": fees["gateway_fee"],
                    "platform_fee": fees["platform_fee"],
                    "recipient_gets": fees["wallet_credit_amount"],
                    "total_debit": fees["charged_amount"],
                    "fee_snapshot": fees,
                    "public_metadata": payload.metadata or {},
                },
            }
            await db.transactions.insert_one(doc)
            body = _developer_push_view({
                "transaction": doc, "fee": fees["total_fee"],
                "total_debit": fees["charged_amount"]
            })
            await _idempotency_store(owner, idem, "POST", "/api/v1/push", 200, body)
            return body
        request.state.merchant_api = True
        transfer_req = TransferRequest(
            transfer_type="biz_to_mobile", recipient=payload.beneficiary_phone,
            recipient_name=payload.beneficiary_name or "",
            recipient_phone=payload.beneficiary_phone,
            country=payload.country, operator=payload.operator,
            amount=payload.amount, currency=payload.currency,
            description=f"BizPUSH {payload.reference or ''}".strip(),
            idempotency_key=idem,
            metadata={**(payload.metadata or {}),
                      "source": "merchant_api", "environment": "live",
                      "product": "bizpush",
                      "merchant_reference": payload.reference},
        )
        result = await transfer(transfer_req, request, merchant["id"])
        tx = result.get("transaction") or {}
        if tx.get("id"):
            await db.transactions.update_one(
                {"id": tx["id"], "user_id": merchant["id"]},
                {"$set": {
                    "metadata.source": "merchant_api",
                    "metadata.environment": "live",
                    "metadata.product": "bizpush",
                    "metadata.public_metadata": payload.metadata or {},
                    "metadata.merchant_reference": payload.reference or tx.get("reference"),
                }},
            )
            result["transaction"] = await db.transactions.find_one(
                {"id": tx["id"], "user_id": merchant["id"]}, {"_id": 0}
            ) or tx
        body = _developer_push_view(result)
        # Never persist or return provider metadata through this public shape.
        await _idempotency_store(owner, idem, "POST", "/api/v1/push", 200, body)
        return body
    except Exception:
        await _idempotency_release(owner, idem, fp)
        raise


@api.get("/v1/push/{push_id}")
async def developer_push_details(push_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    tx = await db.transactions.find_one(
        {"id": push_id, "user_id": merchant["id"],
         "metadata.environment": merchant.get("_api_env", "test"),
         "metadata.source": "merchant_api", "metadata.product": "bizpush"},
        {"_id": 0},
    )
    if not tx:
        raise BizAPIError(404, "Push not found.", "PUSH_NOT_FOUND")
    if tx.get("status") == "pending" and (tx.get("metadata") or {}).get("provider") == "mbiyo":
        await _reconcile_mbiyo_withdrawal(tx)
        tx = await db.transactions.find_one({"id": push_id}, {"_id": 0}) or tx
    return _developer_push_view({"transaction": tx})


@api.get("/v1/push/{push_id}/status")
async def developer_push_status(push_id: str, request: Request):
    item = await developer_push_details(push_id, request)
    return {"id": item["id"], "status": item["status"],
            "updated_at": item["updated_at"]}


def _serialize_direct_payment(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "object": "payment",
        "product": "bizpay_direct",
        "status": doc.get("status", "pending"),
        "amount": _format_amount(doc.get("amount", 0)),
        "currency": doc.get("currency"),
        "reference": doc.get("reference"),
        "country": doc.get("country"),
        "operator": doc.get("operator"),
        "created_at": _format_iso(doc.get("created_at", "")),
        "updated_at": _format_iso(doc.get("updated_at") or doc.get("created_at", "")),
        "metadata": doc.get("metadata") or {},
    }


async def _merchant_direct_status(payment_id: str, merchant: dict,
                                  request_obj: Optional[Request] = None) -> dict:
    # Legacy namespaced reads delegate to the authoritative merchant API
    # payment reader, which is backed by momo_deposits for fiat flows.
    return await merchant_get_payment(
        payment_id,
        request_obj or Request({"type": "http", "method": "GET",
                                "path": f"/api/v1/payments/{payment_id}",
                                "headers": [], "query_string": b""}),
    )


@api.post("/v1/bizpay/direct")
async def bizpay_direct_payment(payload: BizPayDirectRequest, request: Request):
    # Backward-compatible alias. The authoritative contract is the short
    # /v1/direct-payments route and it always uses the configured connector.
    return await developer_direct_payment(payload, request)


@api.get("/v1/bizpay/direct/{payment_id}")
async def bizpay_direct_details(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    return await _merchant_direct_status(payment_id, merchant, request)


@api.get("/v1/bizpay/direct")
async def bizpay_direct_list(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: Optional[str] = None,
    reference: Optional[str] = None,
):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    query = {"user_id": merchant["id"],
             "environment": merchant.get("_api_env", "test"),
             "product": "bizpay_direct"}
    if status:
        query["status"] = status
    if reference:
        query["reference"] = reference
    total = await db.momo_deposits.count_documents(query)
    rows = await db.momo_deposits.find(query, {"_id": 0}) \
        .sort("created_at", -1).skip(offset).limit(limit + 1).to_list(limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "data": [_developer_payment_view(row) for row in rows],
        "count": len(rows), "total": total, "offset": offset,
        "limit": limit, "has_more": has_more,
    }


@api.get("/v1/bizpay/direct/{payment_id}/status")
async def bizpay_direct_status(payment_id: str, request: Request):
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    return await _merchant_direct_status(payment_id, merchant, request)


# =====================================================================
# V1 PAYOUTS API — Public merchant crypto withdrawals via IziChange
# =====================================================================
# Merchants call our /v1/payouts endpoints with their Biz-transPay API keys.
# We validate, deduct their balance (pessimistic debit + refund on failure),
# and forward the request to the configured server-side connector internally.
# Merchants never see provider credentials; callbacks and status reconciliation
# remain authoritative for asynchronous operations.


class PayoutCreate(BaseModel):
    amount: float = Field(..., gt=0, description="Amount of crypto to send")
    coin: str = Field("USDT", min_length=2, max_length=10)
    network: str = Field(..., min_length=2, max_length=16,
                          description="On-chain network — e.g. TRC20, BEP20, ERC20")
    destination_address: str = Field(..., min_length=6)
    reference: Optional[str] = Field(None, max_length=128,
                                       description="Your internal reference for this payout")
    beneficiary_name: Optional[str] = Field(None, max_length=128)
    beneficiary_email: Optional[str] = None
    fee_bearer: Optional[str] = Field(
        "sender", description="'sender' (merchant covers fee, default) or 'recipient'")
    metadata: Optional[dict] = None


def _serialize_payout(po: dict) -> dict:
    if not po:
        return {}
    return {
        "id": po.get("id"),
        "environment": po.get("environment"),
        "object": "payout",
        "status": po.get("status"),
        "amount": _format_amount(po.get("amount", 0)),
        "amount_net": _format_amount(po.get("amount_net", 0))
            if po.get("amount_net") is not None else None,
        "fee": _format_amount(po.get("fee", 0))
            if po.get("fee") is not None else None,
        "fee_pct": po.get("fee_pct"),
        "total_debit": _format_amount(po.get("total_debit", 0))
            if po.get("total_debit") is not None else None,
        "coin": po.get("coin"),
        "network": po.get("network"),
        "asset_code": po.get("asset_code"),
        "destination_address": po.get("destination_address"),
        "reference": po.get("reference"),
        "beneficiary_name": po.get("beneficiary_name"),
        "beneficiary_email": po.get("beneficiary_email"),
        "provider_id": po.get("izipay_payout_id"),
        "provider_status": po.get("izipay_status"),
        "metadata": po.get("metadata") or {},
        "created_at": _format_iso(po.get("created_at", "")) if po.get("created_at") else None,
        "sent_at": _format_iso(po.get("sent_at", "")) if po.get("sent_at") else None,
        "completed_at": _format_iso(po.get("completed_at", "")) if po.get("completed_at") else None,
        "failed_at": _format_iso(po.get("failed_at", "")) if po.get("failed_at") else None,
        "error_code": po.get("error_code"),
    }


_TERMINAL_PAYOUT_STATUSES = ("completed", "confirmed", "failed", "canceled")


def _map_izipay_payout_status(izi_status: str, current: Optional[str] = None) -> str:
    """Map upstream IziChange payout statuses to our public API taxonomy."""
    if not izi_status:
        return current or "pending"
    s = str(izi_status).lower()
    if s in ("completed", "confirmed", "success", "successful", "sent_success"):
        return "completed"
    if s in ("failed", "rejected", "error"):
        return "failed"
    if s in ("canceled", "cancelled"):
        return "canceled"
    if s in ("sent", "sending", "broadcasted"):
        return "sent"
    if s in ("processing", "pending", "waiting", "queued"):
        return "processing"
    return current or "processing"


async def _reconcile_payout(izipay_payout_id: str) -> None:
    """Pull the latest state from IziChange for a payout and update our doc."""
    if not izipay_payout_id or not izipay.is_configured():
        return
    try:
        data = await izipay.get_payout(izipay_payout_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("izipay.get_payout failed for %s: %s", izipay_payout_id, e)
        return
    upstream_status = (data.get("status") or "").lower()
    po = await db.merchant_payouts.find_one({"izipay_payout_id": izipay_payout_id})
    if not po:
        return
    new_status = _map_izipay_payout_status(upstream_status, po.get("status"))
    updates: dict = {"izipay_status": upstream_status}
    if new_status != po.get("status"):
        updates["status"] = new_status
        if new_status == "sent" and not po.get("sent_at"):
            updates["sent_at"] = now_iso()
        if new_status == "completed" and not po.get("completed_at"):
            updates["completed_at"] = now_iso()
        if new_status == "failed" and not po.get("failed_at"):
            updates["failed_at"] = now_iso()
            updates["error_code"] = data.get("errorCode") or data.get("code")
            updates["error_message"] = data.get("errorMessage") or data.get("message")
            # Refund on newly discovered terminal failure.
            refund_id = f"merchant-payout:{po['id']}"
            refunded = await _refund_wallet_once(
                po["merchant_id"], "balance_usdt",
                float(po.get("total_debit") or 0), refund_id)
            if refunded:
                updates["refunded_at"] = now_iso()
    await db.merchant_payouts.update_one({"id": po["id"]}, {"$set": updates})


async def _safe_reconcile_payout(izipay_payout_id: str) -> None:
    try:
        await _reconcile_payout(izipay_payout_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("background payout reconcile failed for %s: %s",
                       izipay_payout_id, e)


@api.post("/v1/payouts")
async def merchant_create_payout(payload: PayoutCreate, request: Request):
    """Create a crypto payout on behalf of the merchant. Deducts balance
    pessimistically then forwards to IziChange. If IziChange refuses,
    the balance is refunded and 502/400 is returned.
    """
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "push:create")
    uid = merchant["id"]
    owner = _developer_owner(merchant)

    # ---------- Idempotency ----------
    idem_key = (request.headers.get("Idempotency-Key") or "").strip()
    idem_fingerprint = _request_fingerprint(payload)
    cached = None
    if idem_key and len(idem_key) > 255:
        raise BizAPIError(400, "Idempotency-Key too long (max 255 chars).",
                          "IDEMPOTENCY_KEY_TOO_LONG")
    if merchant.get("_api_env") == "test":
        cached = await _idempotency_claim(owner, idem_key, "POST",
                                          "/api/v1/payouts", idem_fingerprint) if idem_key else None
        if cached and cached.get("body") is not None:
            return cached["body"]
        cfg = await get_transfer_config()
        fees_map = ((cfg.get("crypto") or {}).get("fees") or {})
        fees_gw_fixed = ((cfg.get("crypto") or {}).get("fees_gateway_fixed") or {})
        coin_upper = payload.coin.upper().strip()
        fee_pct = float(fees_map.get(coin_upper, 4.0))
        gw_fixed = float(fees_gw_fixed.get(coin_upper, 0) or 0)
        fee = round(payload.amount * (fee_pct / 100.0) + gw_fixed, 6)
        gateway_fee, platform_fee = await _crypto_platform_fee(
            coin_upper, "withdrawal", payload.amount)
        gateway_fee = round(gateway_fee + gw_fixed, 6)
        fee_bearer = (payload.fee_bearer or "sender").lower()
        if fee_bearer not in ("sender", "recipient"):
            raise BizAPIError(400, "fee_bearer must be 'sender' or 'recipient'.",
                              "INVALID_FEE_BEARER")
        total_debit = round(payload.amount + fee, 6) \
            if fee_bearer == "sender" else float(payload.amount)
        recipient_gets = float(payload.amount) \
            if fee_bearer == "sender" else round(payload.amount - fee, 6)
        po_id = new_id()
        now = now_iso()
        doc = {
            "id": po_id, "merchant_id": uid, "environment": "test",
            "source": "merchant_api", "product": "bizpush",
            "status": "pending", "amount": payload.amount,
            "amount_net": recipient_gets, "fee": fee, "fee_pct": fee_pct,
            "fee_bearer": fee_bearer, "gateway_fee": gateway_fee,
            "platform_fee": platform_fee, "total_debit": total_debit,
            "coin": coin_upper, "network": payload.network.upper(),
            "asset_code": f"{coin_upper}.{payload.network.upper()}",
            "destination_address": payload.destination_address,
            "reference": payload.reference or po_id, "metadata": payload.metadata or {},
            "created_at": now,
        }
        await db.merchant_payouts.insert_one(doc)
        body = _serialize_payout(doc)
        if idem_key:
            await _idempotency_store(owner, idem_key, "POST", "/api/v1/payouts", 200, body)
        return body
    # ---------- Validate coin/network via IziChange assets ----------
    coin_upper = payload.coin.upper().strip()
    net_upper = payload.network.upper().strip()
    asset_code = f"{coin_upper}.{net_upper}"
    if not izipay.is_configured():
        raise BizAPIError(503, "Crypto gateway not configured.", "GATEWAY_UNAVAILABLE")
    try:
        assets = await izipay.list_assets()
    except Exception as e:  # noqa: BLE001
        logger.warning("izipay.list_assets failed: %s", e)
        raise BizAPIError(502, "Upstream gateway is unreachable.", "GATEWAY_UNREACHABLE")
    asset = next((a for a in assets
                   if (a.get("assetCode") or "").upper() == asset_code
                   and a.get("isActive")), None)
    if not asset:
        raise BizAPIError(400,
                          f"The pair {coin_upper}/{net_upper} is not available for payouts.",
                          "INVALID_ASSET",
                          details={"coin": coin_upper, "network": net_upper})

    min_amt = float(asset.get("minimum") or 0)
    max_amt = float(asset.get("maximum") or 10 ** 12)
    if payload.amount < min_amt:
        raise BizAPIError(400,
                          f"Amount below minimum for {coin_upper}/{net_upper} ({min_amt}).",
                          "AMOUNT_TOO_SMALL",
                          details={"min": min_amt, "max": max_amt})
    if payload.amount > max_amt:
        raise BizAPIError(400,
                          f"Amount above maximum for {coin_upper}/{net_upper} ({max_amt}).",
                          "AMOUNT_TOO_LARGE",
                          details={"min": min_amt, "max": max_amt})

    # ---------- Validate destination address ----------
    import re as _re
    regex = _NETWORK_REGEX.get(net_upper)
    dest = payload.destination_address.strip()
    if regex and not _re.match(regex, dest):
        raise BizAPIError(400,
                          f"Invalid destination address for network {net_upper}.",
                          "INVALID_DESTINATION_ADDRESS",
                          details={"network": net_upper})

    # ---------- Compute fee ----------
    cfg = await get_transfer_config()
    fees_map = ((cfg.get("crypto") or {}).get("fees") or {})
    fees_gw_fixed = ((cfg.get("crypto") or {}).get("fees_gateway_fixed") or {})
    fee_pct = float(fees_map.get(coin_upper, 4.0))
    gw_fixed = float(fees_gw_fixed.get(coin_upper, 0) or 0)
    fee = round(payload.amount * (fee_pct / 100.0) + gw_fixed, 6)
    gateway_fee, platform_fee = await _crypto_platform_fee(coin_upper, "withdrawal", payload.amount)
    gateway_fee = round(gateway_fee + gw_fixed, 6)
    fee_bearer = (payload.fee_bearer or "sender").lower()
    if fee_bearer not in ("sender", "recipient"):
        raise BizAPIError(400, "fee_bearer must be 'sender' or 'recipient'.",
                          "INVALID_FEE_BEARER")
    total_debit = round(payload.amount + fee, 6) if fee_bearer == "sender" else float(payload.amount)
    recipient_gets = float(payload.amount) if fee_bearer == "sender" \
        else round(payload.amount - fee, 6)

    # ---------- Balance check ----------
    merchant_doc = await db.users.find_one({"id": uid}, {"_id": 0})
    if not merchant_doc:
        raise BizAPIError(401, "Merchant not found.", "MERCHANT_NOT_FOUND")
    if merchant_doc.get("withdrawals_blocked"):
        raise BizAPIError(403, "Withdrawals are disabled on this account.",
                          "WITHDRAWALS_BLOCKED")
    if float(merchant_doc.get("balance_usdt", 0)) < total_debit:
        raise BizAPIError(400, "Insufficient balance (fees included).",
                          "INSUFFICIENT_BALANCE",
                          details={"required": total_debit,
                                   "available": float(merchant_doc.get("balance_usdt", 0))})

    if idem_key:
        cached = await _idempotency_claim(
            owner, idem_key, "POST", "/api/v1/payouts", idem_fingerprint)
        if cached is not None:
            return cached.get("body") if isinstance(cached, dict) else cached

    # ---------- Persist doc & debit balance ----------
    po_id = new_id()
    now = now_iso()
    doc = {
        "id": po_id,
        "merchant_id": uid,
        "environment": "live",
        "source": "merchant_api",
        "api_key_id": merchant.get("api_key_id"),
        "api_key_env": merchant.get("env"),
        "coin": coin_upper,
        "network": net_upper,
        "asset_code": asset_code,
        "destination_address": dest,
        "amount": float(payload.amount),
        "amount_net": recipient_gets,
        "fee": fee,
        "fee_pct": fee_pct,
        "fee_bearer": fee_bearer,
        "total_debit": total_debit,
        "reference": payload.reference,
        "beneficiary_name": payload.beneficiary_name,
        "beneficiary_email": payload.beneficiary_email,
        "metadata": payload.metadata or {},
        "status": "pending",
        "izipay_payout_id": None,
        "izipay_status": None,
        "created_at": now,
    }
    # Debit balance atomically (only if funds still available).  The payout
    # id is also a durable debit barrier for retries and reconciliation.
    if not await _debit_wallet_once(
            uid, "balance_usdt", total_debit, f"merchant-payout:{po_id}"):
        raise BizAPIError(400, "Insufficient balance (concurrent debit).",
                          "INSUFFICIENT_BALANCE")

    try:
        await db.merchant_payouts.insert_one(doc)
    except Exception:
        await _refund_wallet_once(uid, "balance_usdt", total_debit,
                                  f"merchant-payout:{po_id}")
        await _idempotency_release(owner, idem_key, idem_fingerprint)
        raise BizAPIError(500, "Could not persist payout.",
                          "PAYOUT_PERSISTENCE_ERROR")

    # ---------- Forward to IziChange ----------
    try:
        upstream = await izipay.create_payout(
            asset_code=asset_code,
            amount=f"{recipient_gets:.6f}",
            destination_address=dest,
            merchant_reference=po_id,
            metadata={"merchant_id": uid, "payout_id": po_id,
                      "merchant_ref": payload.reference or ""},
            idempotency_key=f"mpo-{po_id}",
        )
    except izipay.IziPayError as e:
        # Refund merchant balance on gateway rejection.
        await _refund_wallet_once(uid, "balance_usdt", total_debit,
                                  f"merchant-payout:{po_id}")
        await db.merchant_payouts.update_one({"id": po_id}, {"$set": {
            "status": "failed",
            "failed_at": now_iso(),
            "refunded_at": now_iso(),
            "error_code": e.code,
            "error_message": e.message,
        }})
        await _idempotency_release(owner, idem_key, idem_fingerprint)
        # Classify error for the merchant.
        msg = (e.message or "").lower()
        if "address" in msg or "adresse" in msg:
            code = "INVALID_DESTINATION_ADDRESS"
            user_msg = f"Invalid destination address for {coin_upper}/{net_upper}."
        elif "balance" in msg or "insufficient" in msg:
            code = "GATEWAY_INSUFFICIENT_FUNDS"
            user_msg = "Upstream gateway rejected the payout (funds)."
        else:
            code = "GATEWAY_REJECTED"
            user_msg = "The crypto gateway refused the payout. Please try again."
        raise BizAPIError(400 if e.status < 500 else 502,
                          user_msg, code,
                          details={"gateway_code": e.code, "gateway_message": e.message})
    except Exception as e:  # noqa: BLE001
        # Network / unknown error — refund and 502.
        await _refund_wallet_once(uid, "balance_usdt", total_debit,
                                  f"merchant-payout:{po_id}")
        await db.merchant_payouts.update_one({"id": po_id}, {"$set": {
            "status": "failed",
            "failed_at": now_iso(),
            "refunded_at": now_iso(),
            "error_message": str(e),
        }})
        await _idempotency_release(owner, idem_key, idem_fingerprint)
        raise BizAPIError(502, "The crypto gateway is temporarily unreachable.",
                          "GATEWAY_UNREACHABLE")

    upstream_id = upstream.get("id") or upstream.get("payoutId")
    upstream_status = (upstream.get("status") or "pending").lower()
    mapped_status = _map_izipay_payout_status(upstream_status, "pending")
    upd_fields: dict = {
        "izipay_payout_id": upstream_id,
        "izipay_status": upstream_status,
        "status": mapped_status,
    }
    if mapped_status == "sent":
        upd_fields["sent_at"] = now_iso()
    await db.merchant_payouts.update_one({"id": po_id}, {"$set": upd_fields})

    # Log an internal transaction record too for admin visibility.
    tx_status = "completed" if mapped_status == "completed" else ("failed" if mapped_status == "failed" else "pending")
    await db.transactions.insert_one({
        "id": new_id(),
        "user_id": uid,
        "type": "transfer",
        "direction": "out",
        "amount": float(payload.amount),
        "currency": "USDT",
        "status": tx_status,
        "reference": po_id,
        "counterparty": dest,
        "description": f"Payout API — {coin_upper}/{net_upper}",
        "metadata": {
            "transfer_type": "biz_to_crypto",
            "source": "public_api",
            "merchant_payout_id": po_id,
            "izipay_payout_id": upstream_id,
            "crypto": coin_upper, "network": net_upper,
            "asset_code": asset_code, "wallet_address": dest,
            "amount_gross": float(payload.amount),
            "fee": fee, "fee_pct": fee_pct,
            "gateway_fee": gateway_fee, "platform_fee": platform_fee,
            "gateway_fee_fixed": gw_fixed,
            "amount_net": recipient_gets,
            "fee_bearer": fee_bearer,
            "total_debit": total_debit,
        },
        "created_at": now_iso(),
    })

    final = await db.merchant_payouts.find_one({"id": po_id}, {"_id": 0}) or doc
    body = _serialize_payout(final)
    if idem_key:
        try:
            await _idempotency_store(owner, idem_key, "POST",
                                     "/api/v1/payouts", 200, body)
        except Exception:
            pass
    return body


@api.post("/v1/bizpush/payouts")
async def bizpush_payout(payload: PayoutCreate, request: Request):
    """Stable BizPUSH name for the existing payout contract."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "push:create")
    if not (request.headers.get("Idempotency-Key") or "").strip():
        raise BizAPIError(400, "Idempotency-Key is required for payouts.",
                          "IDEMPOTENCY_KEY_REQUIRED")
    return await merchant_create_payout(payload, request)


@api.get("/v1/payouts")
async def merchant_list_payouts(request: Request,
                                  limit: int = Query(50, ge=1, le=200),
                                  offset: int = Query(0, ge=0),
                                  status: Optional[str] = None,
                                  reference: Optional[str] = None):
    """Paginated list of the merchant's payouts."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    q: dict = {"merchant_id": merchant["id"], **_api_environment_clause(merchant)}
    if status:
        q["status"] = status
    if reference:
        q["reference"] = reference
    total = await db.merchant_payouts.count_documents(q)
    docs = await db.merchant_payouts.find(q, {"_id": 0}) \
        .sort("created_at", -1).skip(offset).limit(limit + 1).to_list(limit + 1)
    has_more = len(docs) > limit
    docs = docs[:limit]
    pending = [d["izipay_payout_id"] for d in docs
                if d.get("status") not in _TERMINAL_PAYOUT_STATUSES
                and d.get("izipay_payout_id")]
    for pid in pending[:10]:
        asyncio.create_task(_safe_reconcile_payout(pid))
    return {
        "data": [_serialize_payout(d) for d in docs],
        "count": len(docs),
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
    }


@api.get("/v1/payouts/search")
async def merchant_search_payout(request: Request,
                                    reference: str = Query(..., min_length=1)):
    """Search the most recent payout carrying this merchant reference."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    po = await db.merchant_payouts.find_one(
        {"merchant_id": merchant["id"], "reference": reference,
         **_api_environment_clause(merchant)},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if not po:
        raise BizAPIError(404, "No payout found for this reference.",
                          "PAYOUT_NOT_FOUND")
    if po.get("status") not in _TERMINAL_PAYOUT_STATUSES \
            and po.get("izipay_payout_id"):
        await _reconcile_payout(po["izipay_payout_id"])
        po = await db.merchant_payouts.find_one(
            {"merchant_id": merchant["id"], "reference": reference,
             **_api_environment_clause(merchant)},
            {"_id": 0},
            sort=[("created_at", -1)],
        ) or po
    return _serialize_payout(po)


@api.get("/v1/payouts/{payout_id}")
async def merchant_get_payout(payout_id: str, request: Request):
    """Full details for a single payout. Auto-syncs upstream when pending."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    po = await db.merchant_payouts.find_one(
        {"id": payout_id, "merchant_id": merchant["id"],
         **_api_environment_clause(merchant)}, {"_id": 0})
    if not po:
        raise BizAPIError(404, "Payout not found.", "PAYOUT_NOT_FOUND")
    if po.get("status") not in _TERMINAL_PAYOUT_STATUSES \
            and po.get("izipay_payout_id"):
        await _reconcile_payout(po["izipay_payout_id"])
        po = await db.merchant_payouts.find_one(
            {"id": payout_id, "merchant_id": merchant["id"],
             **_api_environment_clause(merchant)}, {"_id": 0}) or po
    return _serialize_payout(po)


@api.get("/v1/payouts/{payout_id}/status")
async def merchant_get_payout_status(payout_id: str, request: Request):
    """Lightweight status. Auto-syncs upstream."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    po = await db.merchant_payouts.find_one(
        {"id": payout_id, "merchant_id": merchant["id"],
         **_api_environment_clause(merchant)}, {"_id": 0})
    if not po:
        raise BizAPIError(404, "Payout not found.", "PAYOUT_NOT_FOUND")
    if po.get("status") not in _TERMINAL_PAYOUT_STATUSES \
            and po.get("izipay_payout_id"):
        await _reconcile_payout(po["izipay_payout_id"])
        po = await db.merchant_payouts.find_one(
            {"id": payout_id, "merchant_id": merchant["id"],
             **_api_environment_clause(merchant)}, {"_id": 0}) or po
    return {
        "id": po["id"],
        "status": po.get("status"),
        "updated_at": _format_iso(po.get("completed_at") or po.get("sent_at")
                                    or po.get("failed_at") or po.get("created_at", "")),
    }


@api.get("/v1/payouts/{payout_id}/completed")
async def merchant_check_payout_completed(payout_id: str, request: Request):
    """Returns `{completed, status}`. `completed` is true only for status='completed'."""
    merchant = await _authenticate_merchant(request)
    _require_merchant_scope(merchant, "payments:read")
    po = await db.merchant_payouts.find_one(
        {"id": payout_id, "merchant_id": merchant["id"],
         **_api_environment_clause(merchant)}, {"_id": 0})
    if not po:
        raise BizAPIError(404, "Payout not found.", "PAYOUT_NOT_FOUND")
    if po.get("status") not in _TERMINAL_PAYOUT_STATUSES \
            and po.get("izipay_payout_id"):
        await _reconcile_payout(po["izipay_payout_id"])
        po = await db.merchant_payouts.find_one(
            {"id": payout_id, "merchant_id": merchant["id"],
             **_api_environment_clause(merchant)}, {"_id": 0}) or po
    return {
        "id": po["id"],
        "completed": po.get("status") == "completed",
        "status": po.get("status"),
    }



# ==================== EXCHANGE / CONVERSION ====================

# All conversion rates and fees are admin-configurable — nothing hardcoded.
# The `platform_config.conversion_rates` map holds `<FROM>_<TO>` keys with
# the current rate: 1 unit of FROM produces `rate` units of TO.
DEFAULT_PLATFORM_CONFIG = {
    "id": "platform_config",
    "conversion_fee": {
        "enabled": True,
        "type": "percent",  # "percent" | "fixed"
        "value": 0.5,       # 0.5% or fixed amount
        "min_fee": 0,
        "max_fee": None,
    },
    "conversion_rates": {
        "USDT_XOF": 600.0,
        "USDT_XAF": 600.0,
        "XOF_USDT": 0.00165,
        "XAF_USDT": 0.00165,
        "XOF_XAF": 1.0,
        "XAF_XOF": 1.0,
    },
    "conversion_limits": {
        "USDT_XOF": {"min": 1, "max": 5000},
        "USDT_XAF": {"min": 1, "max": 5000},
        "XOF_USDT": {"min": 500, "max": 3000000},
        "XAF_USDT": {"min": 500, "max": 3000000},
        "XOF_XAF": {"min": 500, "max": 5000000},
        "XAF_XOF": {"min": 500, "max": 5000000},
    },
    "conversion_pairs_enabled": {
        "USDT_XOF": True, "USDT_XAF": True,
        "XOF_USDT": True, "XAF_USDT": True,
        "XOF_XAF": True, "XAF_XOF": True,
    },
    "auto_withdrawals_disabled": False,
}


SUPPORTED_CONVERSION_PAIRS = [
    ("USDT", "XOF"), ("USDT", "XAF"),
    ("XOF", "USDT"), ("XAF", "USDT"),
    ("XOF", "XAF"), ("XAF", "XOF"),
]


def _balance_field(currency: str) -> str:
    c = (currency or "").upper()
    return {"USDT": "balance_usdt", "XOF": "balance_xof", "XAF": "balance_xaf"}.get(c)


async def get_platform_config() -> dict:
    doc = await db.settings.find_one({"id": "platform_config"}, {"_id": 0})
    if not doc:
        await db.settings.insert_one(DEFAULT_PLATFORM_CONFIG.copy())
        doc = await db.settings.find_one({"id": "platform_config"}, {"_id": 0})
    # Ensure every new sub-key exists (backwards compat).
    for k, v in DEFAULT_PLATFORM_CONFIG.items():
        if k not in doc:
            doc[k] = v
    for section in ("conversion_rates", "conversion_limits", "conversion_pairs_enabled"):
        base = DEFAULT_PLATFORM_CONFIG[section]
        for kk, vv in base.items():
            doc.setdefault(section, {}).setdefault(kk, vv)
    return doc


def _compute_fee(fcfg: dict, amount: float) -> float:
    if not fcfg.get("enabled", True):
        return 0.0
    if fcfg.get("type") == "fixed":
        fee = float(fcfg.get("value", 0) or 0)
    else:
        fee = amount * float(fcfg.get("value", 0) or 0) / 100.0
    if fcfg.get("min_fee") is not None:
        fee = max(fee, float(fcfg.get("min_fee") or 0))
    if fcfg.get("max_fee") is not None:
        fee = min(fee, float(fcfg.get("max_fee")))
    return round(fee, 6)


@api.get("/conversion/config")
async def public_conversion_config():
    """Public rates + fees. Consumed by the user-side conversion page."""
    cfg = await get_platform_config()
    return {
        "rates": cfg.get("conversion_rates") or {},
        "limits": cfg.get("conversion_limits") or {},
        "pairs_enabled": cfg.get("conversion_pairs_enabled") or {},
        "fee": cfg.get("conversion_fee") or {},
    }


@api.get("/exchange/rate")
async def get_rate(from_currency: str = "XOF", to_currency: str = "XAF"):
    """Legacy rate endpoint — now driven by admin-configurable rates."""
    cfg = await get_platform_config()
    fcfg = cfg.get("conversion_fee", {}) or {}
    key = f"{from_currency.upper()}_{to_currency.upper()}"
    rate = float((cfg.get("conversion_rates") or {}).get(key, 1.0))
    return {
        "from": from_currency, "to": to_currency, "rate": rate,
        "fee_enabled": fcfg.get("enabled", True),
        "fee_type": fcfg.get("type", "percent"),
        "fee_value": fcfg.get("value", 0.5),
        "fee_min": fcfg.get("min_fee", 0),
        "fee_max": fcfg.get("max_fee"),
        "fee_pct": (float(fcfg.get("value", 0.5)) / 100.0) if fcfg.get("type") == "percent" else 0,
    }


@api.get("/conversion/quote")
async def conversion_quote(from_currency: str, to_currency: str, amount: float):
    """Preview quote — returns the exact `received` amount and fee for the given input."""
    fc, tc = from_currency.upper(), to_currency.upper()
    if fc == tc:
        raise HTTPException(400, "Devises identiques")
    if (fc, tc) not in SUPPORTED_CONVERSION_PAIRS:
        raise HTTPException(400, f"Paire {fc}→{tc} non supportée")
    cfg = await get_platform_config()
    key = f"{fc}_{tc}"
    if not (cfg.get("conversion_pairs_enabled") or {}).get(key, True):
        raise HTTPException(400, "Cette paire de conversion est désactivée")
    rate = float((cfg.get("conversion_rates") or {}).get(key, 1.0))
    limits = ((cfg.get("conversion_limits") or {}).get(key) or {})
    if amount < float(limits.get("min", 0) or 0):
        raise HTTPException(400, f"Montant inférieur au minimum ({limits.get('min')} {fc})")
    if limits.get("max") and amount > float(limits["max"]):
        raise HTTPException(400, f"Montant supérieur au maximum ({limits['max']} {fc})")
    fee = _compute_fee(cfg.get("conversion_fee") or {}, amount)
    received = round((amount - fee) * rate, 6)
    return {
        "from_currency": fc, "to_currency": tc,
        "amount": amount, "fee": fee, "rate": rate,
        "received": received,
        "fee_currency": fc,
    }


@api.post("/exchange")
async def do_exchange(req: ExchangeRequest,
                      uid: str = Depends(require_recent_auth)):
    """Currency-agnostic conversion. Supports the 6 pairs across
    USDT / XOF / XAF, rate-driven by admin config, fee-driven by admin config."""
    fc = (req.from_currency or "").upper()
    tc = (req.to_currency or "").upper()
    if fc == tc:
        raise HTTPException(400, "Devises identiques")
    if (fc, tc) not in SUPPORTED_CONVERSION_PAIRS:
        raise HTTPException(400, f"Paire {fc}→{tc} non supportée")

    from_field, to_field = _balance_field(fc), _balance_field(tc)
    if not from_field or not to_field:
        raise HTTPException(400, "Devise invalide")

    cfg = await get_platform_config()
    key = f"{fc}_{tc}"
    if not (cfg.get("conversion_pairs_enabled") or {}).get(key, True):
        raise HTTPException(400, "Cette paire de conversion est désactivée")

    # Cross-check with the app_features flags so a disabled wallet also blocks conversion.
    feats = await get_app_features()
    if not feats.get(f"wallet_{('crypto' if fc == 'USDT' else fc.lower())}_enabled", True):
        raise HTTPException(400, f"Le portefeuille {fc} est désactivé")
    if not feats.get(f"wallet_{('crypto' if tc == 'USDT' else tc.lower())}_enabled", True):
        raise HTTPException(400, f"Le portefeuille {tc} est désactivé")

    limits = ((cfg.get("conversion_limits") or {}).get(key) or {})
    if req.amount < float(limits.get("min", 0) or 0):
        raise HTTPException(400, f"Montant inférieur au minimum ({limits.get('min')} {fc})")
    if limits.get("max") and req.amount > float(limits["max"]):
        raise HTTPException(400, f"Montant supérieur au maximum ({limits['max']} {fc})")

    rate = float((cfg.get("conversion_rates") or {}).get(key, 1.0))
    fee = _compute_fee(cfg.get("conversion_fee") or {}, req.amount)

    received = round((req.amount - fee) * rate, 6)
    exchange_key = (req.idempotency_key or "").strip()
    exchange_fingerprint = _request_fingerprint(req)
    if exchange_key:
        cached = await _idempotency_claim(
            uid, exchange_key, "POST", "/api/exchange", exchange_fingerprint)
        if cached and cached.get("body") is not None:
            return cached["body"]
    operation_id = f"exchange:{uid}:{exchange_key or new_id()}"
    # Both legs and their operation markers are changed in one Mongo update.
    # This prevents a crash between debit and credit from destroying value.
    debited = await db.users.update_one(
        {"id": uid, from_field: {"$gte": req.amount},
         "wallet_debit_operation_ids": {"$ne": operation_id}},
        {"$inc": {from_field: -req.amount, to_field: received},
         "$addToSet": {
             "wallet_debit_operation_ids": operation_id,
             "wallet_credit_operation_ids": operation_id,
         }},
    )
    if not debited.modified_count:
        raise HTTPException(400, "Solde insuffisant ou opération déjà appliquée")

    tx_out = await record_tx(
        uid, "exchange", "out", req.amount, fc,
        description=f"Conversion {fc} → {tc}",
        metadata={
            "rate": rate, "fee": fee, "received": received,
            "from_currency": fc, "to_currency": tc,
            "pair": key,
            # Conversion fees are pure platform revenue (no external gateway).
            "gateway_fee": 0.0,
            "platform_fee": float(fee),
            "operation_id": operation_id,
        },
        operation_id=f"{operation_id}:out",
    )
    await notify(
        uid, "exchange_success", "Échange confirmé",
        f"Votre conversion de {req.amount:,.6g} {fc} vers "
        f"{received:,.6g} {tc} est confirmée.",
        data={
            "transaction_id": tx_out.id,
            "status": "completed",
            "amount": req.amount,
            "currency": fc,
            "from_currency": fc,
            "to_currency": tc,
            "received": received,
        },
    )
    result = {
        "received": received, "fee": fee, "rate": rate,
        "from_currency": fc, "to_currency": tc,
        "transaction": tx_out.model_dump(),
    }
    if exchange_key:
        await _idempotency_store(uid, exchange_key, "POST", "/api/exchange", 200, result)
    return result


# ==================== PAYMENT LINKS ====================
def _payment_link_amount(link: dict, requested: Optional[float] = None) -> float:
    """Validate and return the amount requested for a payment link."""
    if link.get("amount_type", "fixed") == "fixed":
        amount = float(link.get("amount") or 0)
        if amount <= 0:
            raise HTTPException(400, "Le montant fixe du lien est invalide")
        return amount
    if requested is None or requested <= 0:
        raise HTTPException(400, "Montant requis pour ce lien")
    minimum = float(link.get("min_amount") or 0)
    maximum = float(link.get("max_amount") or 0)
    if minimum <= 0 or maximum < minimum:
        raise HTTPException(400, "La plage de montant du lien est invalide")
    if requested < minimum:
        raise HTTPException(400, f"Montant minimum : {minimum:g}")
    if requested > maximum:
        raise HTTPException(400, f"Montant maximum : {maximum:g}")
    return float(requested)


def _payment_link_is_expired(link: dict) -> bool:
    expires_at = link.get("expires_at")
    if not expires_at:
        return False
    try:
        value = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value <= datetime.now(timezone.utc)
    except (TypeError, ValueError):
        return False


async def _ensure_link_can_be_paid(link: dict, requested: Optional[float] = None) -> float:
    if _payment_link_is_expired(link):
        raise HTTPException(410, "Ce lien de paiement a expiré")
    if link.get("single_use"):
        paid = await db.link_payments.find_one({"link_id": link["id"], "status": "paid"}, {"_id": 1})
        if paid:
            raise HTTPException(409, "Ce lien à usage unique a déjà été utilisé")
    return _payment_link_amount(link, requested)


async def _claim_single_use_link(link: dict) -> Optional[str]:
    """Reserve a single-use link before calling an external payment provider.

    Checking for an existing paid child alone is a TOCTOU race: two customers
    can both pass the check before either provider intent is created.
    """
    if not link.get("single_use"):
        return None
    paid = await db.link_payments.find_one(
        {"link_id": link["id"], "status": "paid"}, {"_id": 1})
    if paid:
        raise HTTPException(409, "Ce lien à usage unique a déjà été utilisé")
    claim_id = new_id()
    claimed = await db.payment_links.update_one(
        {"id": link["id"], "active": True,
         "single_use_claim_id": {"$exists": False}},
        {"$set": {"single_use_claim_id": claim_id,
                  "single_use_claimed_at": now_iso()}},
    )
    if claimed.modified_count == 1:
        return claim_id
    raise HTTPException(
        409, "Une autre tentative de paiement utilise déjà ce lien")


async def _release_single_use_link(link_id: str, claim_id: Optional[str]) -> None:
    if not claim_id:
        return
    await db.payment_links.update_one(
        {"id": link_id, "single_use_claim_id": claim_id},
        {"$unset": {"single_use_claim_id": "", "single_use_claimed_at": ""}},
    )


def _public_link_payment_status(payment: dict) -> dict:
    """Expose only fields needed by a public checkout tracker."""
    out = {
        "id": payment.get("id"),
        "status": payment.get("status"),
        "amount": payment.get("amount"),
        "currency": payment.get("currency"),
        "coin": payment.get("coin"),
        "network": payment.get("network"),
        "amount_to_send": payment.get("amount_to_send"),
        "deposit_address": payment.get("deposit_address"),
        "memo": payment.get("memo"),
        "memo_type": payment.get("memo_type"),
        "expires_at": payment.get("expires_at"),
        "created_at": payment.get("created_at"),
        "pending_expires_at": payment.get("pending_expires_at"),
    }
    if payment.get("method") == "mobile_money":
        out.update({
            "country": payment.get("country"),
            "operator": {"code": payment.get("operator"),
                         "label": payment.get("operator_name")},
            "operator_name": payment.get("operator_name"),
            "customer_phone": payment.get("customer_phone"),
            "payment_flow": payment.get("payment_flow") or {},
            "auth_mode": payment.get("auth_mode"),
            "otp_required": bool(payment.get("otp_required")
                                 or payment.get("auth_mode") == "pin"),
            "challenge_status": payment.get("challenge_status")
                or ("required" if payment.get("auth_mode") == "pin" else "pending"),
            "instructions": _plain_payment_instructions(payment.get("instructions")),
            "checkout_url": payment.get("redirect_url") or payment.get("checkout_url"),
            "redirect_url": payment.get("redirect_url") or payment.get("checkout_url"),
            "prompt_sent": bool(payment.get("prompt_sent")),
            "prompt_error": _public_payment_error(payment.get("prompt_error")),
        })
    return out


@api.get("/links", response_model=List[PaymentLink])
async def list_links(uid: str = Depends(get_current_user_id)):
    docs = await db.payment_links.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs


@api.post("/links", response_model=PaymentLink)
async def create_link(req: PaymentLinkCreate, uid: str = Depends(get_current_user_id)):
    if not req.title.strip():
        raise HTTPException(400, "Le nom du lien est requis")
    safe_logo = _validate_image_source(req.logo, "Logo")
    if req.amount_type == "fixed" and req.amount <= 0:
        raise HTTPException(400, "Le montant fixe doit être supérieur à zéro")
    if req.amount_type == "free":
        if req.min_amount is None or req.max_amount is None:
            raise HTTPException(400, "Montants minimum et maximum requis pour un montant libre")
        if req.min_amount <= 0 or req.max_amount <= req.min_amount:
            raise HTTPException(400, "Montant maximum doit être supérieur au minimum")
    link = PaymentLink(
        id=new_id(),
        user_id=uid,
        slug=secrets.token_urlsafe(8),
        title=req.title.strip(),
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
        logo=safe_logo,
    )
    await db.payment_links.insert_one(link.model_dump())
    return link


@api.get("/links/public/{slug}")
async def get_public_link(slug: str):
    doc = await db.payment_links.find_one({"slug": slug}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Lien introuvable")
    # A public slug authorizes checkout only. Never expose the owner's
    # internal id or any future private fields from the stored document.
    return {
        "slug": doc.get("slug"),
        "title": doc.get("title"),
        "amount": doc.get("amount"),
        "currency": doc.get("currency"),
        "description": doc.get("description") or "",
        "expires_at": doc.get("expires_at"),
        "single_use": bool(doc.get("single_use")),
        "active": bool(doc.get("active")),
        "amount_type": doc.get("amount_type", "fixed"),
        "min_amount": doc.get("min_amount"),
        "max_amount": doc.get("max_amount"),
        "fee_bearer": doc.get("fee_bearer", "customer"),
        "logo": doc.get("logo"),
    }


@api.patch("/links/{link_id}", response_model=PaymentLink)
async def update_link(link_id: str, req: PaymentLinkUpdate, uid: str = Depends(get_current_user_id)):
    update = req.model_dump(exclude_unset=True)
    current = await db.payment_links.find_one({"id": link_id, "user_id": uid}, {"_id": 0})
    if not current:
        raise HTTPException(404, "Lien introuvable")
    if not update:
        raise HTTPException(400, "Aucune modification")
    if "logo" in update:
        update["logo"] = _validate_image_source(update["logo"], "Logo")
    candidate = {**current, **update}
    if not str(candidate.get("title") or "").strip():
        raise HTTPException(400, "Le nom du lien est requis")
    if candidate.get("amount_type", "fixed") == "fixed":
        if float(candidate.get("amount") or 0) <= 0:
            raise HTTPException(400, "Le montant fixe doit être supérieur à zéro")
        candidate["amount"] = float(candidate["amount"])
        candidate["min_amount"] = None
        candidate["max_amount"] = None
    else:
        minimum = candidate.get("min_amount")
        maximum = candidate.get("max_amount")
        if minimum is None or maximum is None or float(minimum) <= 0 or float(maximum) <= float(minimum):
            raise HTTPException(400, "Montant maximum doit être supérieur au minimum")
        candidate["amount"] = 0
        candidate["min_amount"] = float(minimum)
        candidate["max_amount"] = float(maximum)
    candidate["title"] = str(candidate["title"]).strip()
    for key in ("amount", "min_amount", "max_amount"):
        if key in update or key in ("amount", "min_amount", "max_amount"):
            update[key] = candidate.get(key)
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
        # Escape regex-special chars so user input like "0x..." works verbatim.
        esc = _literal_regex_term(q, field_name="Recherche")
        rx = {"$regex": esc, "$options": "i"}
        search_terms = [
            {"id": rx}, {"reference": rx}, {"counterparty": rx},
            {"description": rx}, {"currency": rx}, {"type": rx},
            {"metadata.tx_hash": rx}, {"metadata.txid": rx}, {"metadata.tx_id": rx},
            {"metadata.wallet_address": rx}, {"metadata.deposit_address": rx},
            {"metadata.customer_email": rx}, {"metadata.customer_name": rx},
            {"metadata.email": rx}, {"metadata.phone_number": rx},
            {"metadata.customer_phone": rx}, {"metadata.external_id": rx},
            {"metadata.external_reference": rx}, {"metadata.provider_reference": rx},
            {"metadata.paydunya_reference": rx}, {"metadata.paydunya_token": rx},
            {"metadata.izipay_intent_id": rx}, {"metadata.izipay_payout_id": rx},
            {"metadata.merchant_payment_id": rx}, {"metadata.payment_id": rx},
            {"metadata.link_id": rx}, {"metadata.link_payment_id": rx},
            {"metadata.coin": rx}, {"metadata.network": rx},
            {"metadata.recipient": rx}, {"metadata.recipient_name": rx},
            {"metadata.reference": rx},
        ]
        # Amounts are stored as numbers, so a regex cannot find them.
        numeric = re.sub(r"[^\d.-]", "", needle.replace(",", "."))
        try:
            amount_value = float(numeric) if numeric not in ("", "-", ".") else None
        except ValueError:
            amount_value = None
        if amount_value is not None:
            search_terms.extend([
                {"amount": amount_value},
                {"metadata.amount_gross": amount_value},
                {"metadata.amount_net": amount_value},
                {"metadata.charged_amount": amount_value},
                {"metadata.total_debit": amount_value},
                {"metadata.fee": amount_value},
                {"metadata.recipient_gets": amount_value},
            ])
        # Older rows may not copy the owner's email/phone into metadata.
        owner = await db.users.find_one(
            {"id": uid}, {"_id": 0, "email": 1, "phone": 1})
        owner_values = [
            str(owner.get(k) or "").lower() for k in ("email", "phone")
        ] if owner else []
        if needle.lower() and any(needle.lower() in value for value in owner_values):
            search_terms.insert(0, {"user_id": uid})
        query["$or"] = search_terms
    docs = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs


@api.get("/transactions/{tx_id}")
async def get_transaction(tx_id: str, uid: str = Depends(get_current_user_id)):
    """Return one transaction without exposing another user's ledger."""
    doc = await db.transactions.find_one(
        {"id": tx_id, "user_id": uid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Transaction introuvable")
    return doc


# ==================== KYC ====================
@api.get("/kyc")
async def get_kyc(uid: str = Depends(get_current_user_id)):
    u = await get_user(uid)
    kyc = await db.kyc.find_one({"user_id": uid}, {"_id": 0}) or {}
    return {"status": u.get("kyc_status", "not_started"), "submission": kyc}


@api.post("/kyc/submit")
async def submit_kyc(req: KycSubmit, uid: str = Depends(get_current_user_id)):
    data = req.model_dump()
    for field_name, required in (
        ("document_front", True),
        ("document_back", False),
        ("selfie", True),
    ):
        data[field_name] = _validate_raster_image(
            data.get(field_name), field_name, required=required
        )
    doc = {
        "user_id": uid,
        **data,
        "submitted_at": now_iso(),
        "status": "pending",
        "reject_reason": None,
    }
    await db.kyc.replace_one({"user_id": uid}, doc, upsert=True)
    await db.users.update_one({"id": uid}, {"$set": {"kyc_status": "pending"}})
    await _queue_telegram_notification(
        uid,
        "kyc_submitted",
        "KYC soumis",
        "Une vérification KYC a été soumise et attend une validation.",
        {"status": "pending", "submitted_at": doc["submitted_at"]},
    )
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
            # Keep existing Replit/Preview environments usable when the
            # dedicated Fernet secret was not provisioned yet. The derived
            # key is deterministic and never exposed; production deployments
            # should still provide SECRETS_ENCRYPTION_KEY explicitly so it can
            # remain independent from session signing.
            session_secret = os.environ.get("SESSION_SECRET")
            if not session_secret:
                raise RuntimeError(
                    "SECRETS_ENCRYPTION_KEY or SESSION_SECRET missing from .env"
                )
            key = base64.urlsafe_b64encode(
                hashlib.sha256(
                    f"biz-transpay:secrets-encryption:{session_secret}".encode("utf-8")
                ).digest()
            ).decode("ascii")
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
    """Ensure the legacy API-key container exists without creating an API key.

    Also migrates the legacy single-doc schema to the new multi-key collection
    `merchant_keys` and multi-webhook collection `merchant_webhooks` on first
    read, so existing merchants keep working without any manual step. A key is
    created only through an explicit key-creation or regeneration action.
    """
    doc = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    if doc and doc.get("keys"):
        await _migrate_to_multi_keys(uid, doc)
        return doc
    # Older accounts may still use the pre-multi-key fields. Migrate only an
    # existing complete key; never generate a replacement for a missing one.
    legacy_public = (doc or {}).get("public_key")
    legacy_secret = (doc or {}).get("secret_key")
    if doc and legacy_public and legacy_secret:
        migrated = {
            "public_key": legacy_public,
            "secret_hint": _mask(legacy_secret),
            "secret_hash": _hash_secret(legacy_secret),
            "created_at": doc.get("created_at") or now_iso(),
            "last_used_at": doc.get("last_used_at"),
        }
        await db.api_keys.update_one(
            {"user_id": uid},
            {"$set": {"keys.test": migrated},
             "$unset": {"public_key": "", "secret_key": ""}},
        )
        doc["keys"] = {"test": migrated}
        await _migrate_to_multi_keys(uid, doc)
        return doc
    if doc:
        return doc

    # Keep webhook configuration available to the existing webhook endpoints,
    # but deliberately do not provision a test or live API key.
    webhook_secret = _gen_key("whsec_", 32)
    new_doc = {
        "user_id": uid,
        "webhook": {
            "url": _default_webhook_url(request, uid) if request else "",
            "secret_hint": _mask(webhook_secret),
            "secret_hash": _hash_secret(webhook_secret),
            "secret_encrypted": _encrypt(webhook_secret),
            "events": ["payment.created", "payment.confirming", "payment.completed",
                       "payment.failed", "payment.expired",
                       "refund.created", "refund.completed"],
            "created_at": now_iso(),
        },
        "created_at": now_iso(),
    }
    await db.api_keys.replace_one({"user_id": uid}, new_doc, upsert=True)
    return new_doc


# ==================== MULTI KEYS + MULTI WEBHOOKS ====================
# The legacy `api_keys` document (1 doc per user, with keys.test/keys.live and
# a single webhook) is preserved as a lookup path for backward compatibility.
# On top of it we expose N-per-user schemas via two dedicated collections:
#   - `merchant_keys`   : {id, user_id, name, env, public_key, secret_hash,
#                          secret_hint, active, created_at, last_used_at}
#   - `merchant_webhooks`: {id, user_id, name, url, secret_hash, secret_hint,
#                          secret_encrypted, events[], active, created_at,
#                          last_delivery_at, failure_count}
async def _migrate_to_multi_keys(uid: str, legacy: dict) -> None:
    """Populate merchant_keys / merchant_webhooks from legacy doc if empty."""
    existing_keys = await db.merchant_keys.count_documents({"user_id": uid})
    if existing_keys == 0:
        for env, label in (("live", "Production (migrée)"), ("test", "Test (migré)")):
            k = (legacy.get("keys") or {}).get(env)
            if not k:
                continue
            await db.merchant_keys.insert_one({
                "id": new_id(),
                "user_id": uid,
                "name": label,
                "env": env,
                "public_key": k.get("public_key"),
                "secret_hash": k.get("secret_hash"),
                "secret_hint": k.get("secret_hint"),
                "active": True,
                "created_at": k.get("created_at") or now_iso(),
                "last_used_at": k.get("last_used_at"),
            })
    existing_hooks = await db.merchant_webhooks.count_documents({"user_id": uid})
    if existing_hooks == 0 and legacy.get("webhook", {}).get("url"):
        wh = legacy["webhook"]
        await db.merchant_webhooks.insert_one({
            "id": new_id(),
            "user_id": uid,
            "name": "Webhook principal",
            "url": wh["url"],
            "secret_hash": wh.get("secret_hash"),
            "secret_hint": wh.get("secret_hint"),
            "secret_encrypted": wh.get("secret_encrypted"),
            "events": wh.get("events") or [
                "payment.created", "payment.confirming", "payment.completed",
                "payment.failed", "payment.expired",
                "mobile_money.payment.approved", "mobile_money.payment.declined",
                "refund.created", "refund.completed",
            ],
            "active": True,
            "created_at": wh.get("created_at") or now_iso(),
            "last_delivery_at": None,
            "failure_count": 0,
        })


def _public_keys_view(doc: dict) -> dict:
    """Strip sensitive fields (hashes, plaintexts) before returning to the UI."""
    doc = doc or {}
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
async def get_api_keys_v2(request: Request, uid: str = Depends(require_merchant_account)):
    u = await get_user(uid)
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
                              uid: str = Depends(require_merchant_account)):
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
async def update_webhook_config(cfg: WebhookConfigV2,
                                uid: str = Depends(require_merchant_account)):
    await _ensure_api_keys(uid)
    updates: dict = {}
    if cfg.url is not None:
        updates["webhook.url"] = await _validate_outbound_http_url(cfg.url)
    if cfg.events is not None:
        updates["webhook.events"] = cfg.events
    if updates:
        await db.api_keys.update_one({"user_id": uid}, {"$set": updates})
    doc = await db.api_keys.find_one({"user_id": uid}, {"_id": 0})
    return _public_keys_view(doc)["webhook"]


@api.post("/api-keys/webhook/regenerate-secret")
async def regenerate_webhook_secret(
    uid: str = Depends(require_merchant_account),
):
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


# ==================== MULTI KEYS ENDPOINTS ====================
ALL_WEBHOOK_EVENTS = [
    "payment.created", "payment.confirming", "payment.completed",
    "payment.failed", "payment.expired",
    "mobile_money.payment.approved", "mobile_money.payment.declined",
    "mobile_money.payment.canceled",
    "push.succeeded", "push.failed",
    "refund.created", "refund.completed",
]


class CreateMerchantKeyReq(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    env: Literal["test", "live"] = "test"
    scopes: Optional[list[str]] = None


class UpdateMerchantKeyReq(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    active: Optional[bool] = None
    scopes: Optional[list[str]] = None


def _mkey_view(k: dict, reveal: Optional[str] = None) -> dict:
    out = {
        "id": k["id"],
        "name": k.get("name"),
        "env": k.get("env"),
        "public_key": k.get("public_key"),
        "secret_hint": k.get("secret_hint"),
        "active": bool(k.get("active", True)),
        "scopes": k.get("scopes") or [
            "checkout:create", "direct:create", "push:create", "payments:read"
        ],
        "created_at": k.get("created_at"),
        "last_used_at": k.get("last_used_at"),
    }
    if reveal:
        out["secret"] = reveal
    return out


@api.get("/merchant/keys")
async def list_merchant_keys(uid: str = Depends(require_merchant_account),
                              request: Request = None):
    await _ensure_api_keys(uid, request)  # triggers migration on first read
    rows = await db.merchant_keys.find({"user_id": uid}, {"_id": 0}) \
        .sort("created_at", -1).to_list(200)
    return {"data": [_mkey_view(k) for k in rows]}


@api.post("/merchant/keys")
async def create_merchant_key(req: CreateMerchantKeyReq,
                                 uid: str = Depends(require_merchant_account),
                                request: Request = None):
    await _ensure_api_keys(uid, request)
    allowed_scopes = {
        "checkout:create", "direct:create", "push:create", "payments:read"
    }
    scopes = req.scopes or sorted(allowed_scopes)
    invalid_scopes = sorted(set(scopes) - allowed_scopes)
    if invalid_scopes:
        raise HTTPException(
            422,
            detail={"message": "Scope API inconnu.", "code": "INVALID_API_SCOPE",
                    "details": {"scopes": invalid_scopes}},
        )
    if not scopes:
        raise HTTPException(422, "Au moins un scope est requis")
    prefix_pk = f"pk_{req.env}_"
    prefix_sk = f"sk_{req.env}_"
    pub = _gen_key(prefix_pk)
    sec = _gen_key(prefix_sk, 32)
    doc = {
        "id": new_id(),
        "user_id": uid,
        "name": req.name.strip(),
        "env": req.env,
        "public_key": pub,
        "secret_hash": _hash_secret(sec),
        "secret_hint": _mask(sec),
        "active": True,
        "scopes": sorted(set(scopes)),
        "created_at": now_iso(),
        "last_used_at": None,
    }
    await db.merchant_keys.insert_one(doc)
    await db.api_keys.update_one(
        {"user_id": uid},
        {"$set": {
            f"keys.{req.env}": {
                "public_key": pub,
                "secret_hint": _mask(sec),
                "secret_hash": _hash_secret(sec),
                "created_at": doc["created_at"],
                "last_used_at": None,
            },
        }},
        upsert=True,
    )
    return _mkey_view(doc, reveal=sec)


@api.patch("/merchant/keys/{key_id}")
async def update_merchant_key(key_id: str, req: UpdateMerchantKeyReq,
                                 uid: str = Depends(require_merchant_account)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "Aucune modification")
    if "scopes" in updates:
        allowed_scopes = {
            "checkout:create", "direct:create", "push:create", "payments:read"
        }
        invalid_scopes = sorted(set(updates["scopes"]) - allowed_scopes)
        if invalid_scopes or not updates["scopes"]:
            raise HTTPException(
                422,
                detail={"message": "Scope API inconnu ou vide.",
                        "code": "INVALID_API_SCOPE",
                        "details": {"scopes": invalid_scopes}},
            )
        updates["scopes"] = sorted(set(updates["scopes"]))
    r = await db.merchant_keys.update_one(
        {"id": key_id, "user_id": uid}, {"$set": updates})
    if r.matched_count == 0:
        raise HTTPException(404, "Clé introuvable")
    k = await db.merchant_keys.find_one({"id": key_id}, {"_id": 0})
    return _mkey_view(k)


@api.post("/merchant/keys/{key_id}/regenerate")
async def regenerate_merchant_key(key_id: str,
                                     uid: str = Depends(require_merchant_account)):
    k = await db.merchant_keys.find_one({"id": key_id, "user_id": uid}, {"_id": 0})
    if not k:
        raise HTTPException(404, "Clé introuvable")
    env = k.get("env", "test")
    new_secret = _gen_key(f"sk_{env}_", 32)
    new_public = _gen_key(f"pk_{env}_")
    await db.merchant_keys.update_one(
        {"id": key_id, "user_id": uid},
        {"$set": {
            "public_key": new_public,
            "secret_hash": _hash_secret(new_secret),
            "secret_hint": _mask(new_secret),
        }},
    )
    await db.api_keys.update_one(
        {"user_id": uid},
        {"$set": {
            f"keys.{env}": {
                "public_key": new_public,
                "secret_hint": _mask(new_secret),
                "secret_hash": _hash_secret(new_secret),
                "created_at": now_iso(),
                "last_used_at": None,
            },
        }},
        upsert=True,
    )
    k = await db.merchant_keys.find_one({"id": key_id}, {"_id": 0})
    return _mkey_view(k, reveal=new_secret)


@api.delete("/merchant/keys/{key_id}")
async def delete_merchant_key(key_id: str,
                                 uid: str = Depends(require_merchant_account)):
    key = await db.merchant_keys.find_one(
        {"id": key_id, "user_id": uid}, {"_id": 0}
    )
    if not key:
        raise HTTPException(404, "Clé introuvable")
    r = await db.merchant_keys.delete_one({"id": key_id, "user_id": uid})
    if r.deleted_count == 0:
        raise HTTPException(404, "Clé introuvable")
    env = key.get("env", "test")
    replacement = await db.merchant_keys.find_one(
        {"user_id": uid, "env": env}, {"_id": 0}
    )
    if replacement:
        legacy_key = {
            "public_key": replacement.get("public_key"),
            "secret_hint": replacement.get("secret_hint"),
            "secret_hash": replacement.get("secret_hash"),
            "created_at": replacement.get("created_at"),
            "last_used_at": replacement.get("last_used_at"),
        }
        await db.api_keys.update_one(
            {"user_id": uid}, {"$set": {f"keys.{env}": legacy_key}}
        )
    else:
        # Remove the compatibility copy as well. Otherwise a later read
        # would migrate the deleted key back into merchant_keys.
        await db.api_keys.update_one(
            {"user_id": uid}, {"$unset": {f"keys.{env}": ""}}
        )
    return {"deleted": True}


# ==================== MULTI WEBHOOKS ENDPOINTS ====================
class CreateWebhookReq(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    url: str
    events: list[str] = Field(default_factory=list)


class UpdateWebhookReq(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    url: Optional[str] = None
    events: Optional[list[str]] = None
    active: Optional[bool] = None


def _wh_view(w: dict, reveal: Optional[str] = None) -> dict:
    out = {
        "id": w["id"],
        "name": w.get("name"),
        "url": w.get("url"),
        "events": w.get("events") or [],
        "active": bool(w.get("active", True)),
        "secret_hint": w.get("secret_hint"),
        "created_at": w.get("created_at"),
        "last_delivery_at": w.get("last_delivery_at"),
        "failure_count": w.get("failure_count", 0),
    }
    if reveal:
        out["secret"] = reveal
    return out


@api.get("/merchant/webhooks")
async def list_webhooks(uid: str = Depends(require_merchant_account),
                          request: Request = None):
    await _ensure_api_keys(uid, request)
    rows = await db.merchant_webhooks.find({"user_id": uid}, {"_id": 0}) \
        .sort("created_at", -1).to_list(200)
    return {"data": [_wh_view(w) for w in rows],
            "available_events": ALL_WEBHOOK_EVENTS}


@api.post("/merchant/webhooks")
async def create_webhook(req: CreateWebhookReq,
                          uid: str = Depends(require_merchant_account)):
    url = await _validate_outbound_http_url(req.url)
    events = [e for e in (req.events or []) if e in ALL_WEBHOOK_EVENTS]
    if not events:
        events = list(ALL_WEBHOOK_EVENTS)
    secret = _gen_key("whsec_", 32)
    doc = {
        "id": new_id(),
        "user_id": uid,
        "name": req.name.strip(),
        "url": url,
        "events": events,
        "active": True,
        "secret_hash": _hash_secret(secret),
        "secret_hint": _mask(secret),
        "secret_encrypted": _encrypt(secret),
        "created_at": now_iso(),
        "last_delivery_at": None,
        "failure_count": 0,
    }
    await db.merchant_webhooks.insert_one(doc)
    return _wh_view(doc, reveal=secret)


@api.patch("/merchant/webhooks/{wh_id}")
async def update_webhook(wh_id: str, req: UpdateWebhookReq,
                             uid: str = Depends(require_merchant_account)):
    payload = req.model_dump(exclude_unset=True)
    if "url" in payload:
        payload["url"] = await _validate_outbound_http_url(payload["url"])
    if "events" in payload:
        payload["events"] = [e for e in payload["events"] if e in ALL_WEBHOOK_EVENTS]
    if not payload:
        raise HTTPException(400, "Aucune modification")
    r = await db.merchant_webhooks.update_one(
        {"id": wh_id, "user_id": uid}, {"$set": payload})
    if r.matched_count == 0:
        raise HTTPException(404, "Webhook introuvable")
    w = await db.merchant_webhooks.find_one({"id": wh_id}, {"_id": 0})
    return _wh_view(w)


@api.post("/merchant/webhooks/{wh_id}/regenerate-secret")
async def regenerate_merchant_webhook_secret(wh_id: str,
                                       uid: str = Depends(require_merchant_account)):
    w = await db.merchant_webhooks.find_one({"id": wh_id, "user_id": uid}, {"_id": 0})
    if not w:
        raise HTTPException(404, "Webhook introuvable")
    secret = _gen_key("whsec_", 32)
    await db.merchant_webhooks.update_one(
        {"id": wh_id, "user_id": uid},
        {"$set": {"secret_hash": _hash_secret(secret),
                  "secret_hint": _mask(secret),
                  "secret_encrypted": _encrypt(secret)}},
    )
    w = await db.merchant_webhooks.find_one({"id": wh_id}, {"_id": 0})
    return _wh_view(w, reveal=secret)


@api.delete("/merchant/webhooks/{wh_id}")
async def delete_webhook(wh_id: str,
                           uid: str = Depends(require_merchant_account)):
    r = await db.merchant_webhooks.delete_one({"id": wh_id, "user_id": uid})
    if r.deleted_count == 0:
        raise HTTPException(404, "Webhook introuvable")
    return {"deleted": True}


@api.post("/merchant/webhooks/{wh_id}/test")
async def send_test_webhook(wh_id: str,
                               uid: str = Depends(require_merchant_account)):
    w = await db.merchant_webhooks.find_one({"id": wh_id, "user_id": uid}, {"_id": 0})
    if not w:
        raise HTTPException(404, "Webhook introuvable")
    if not w.get("active", True):
        raise HTTPException(400, "Webhook désactivé")
    await _deliver_webhook(uid, "payment.completed", {
        "payment_id": "test_" + new_id()[:8],
        "reference": "test_event",
        "amount": "100.00",
        "coin": "USDT",
        "note": "This is a test event from Biz-transPay",
    })
    return {"ok": True, "message": "Event de test envoyé — vérifiez les livraisons."}



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


@api.get("/documentation.pdf")
async def download_api_docs_pdf(uid: str = Depends(get_current_user_id)):
    """Generate a professional PDF of the Biz-transPay API documentation.
    Reflects the current architecture: crypto Pay-In + Payouts, polling only
    (no webhooks). Kept in sync with the online /dashboard/api/docs page."""
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
                            title="Biz-transPay API - Documentation")
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

    def code(text: str): return Preformatted(text, styles["Codebtp"])
    def h1(t): return Paragraph(t, styles["H1btp"])
    def h2(t): return Paragraph(t, styles["H2btp"])
    def h3(t): return Paragraph(t, styles["H3btp"])
    def p(t): return Paragraph(t, styles["Bodybtp"])

    def _table(rows, col_widths):
        t = Table(rows, colWidths=col_widths)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), HexColor("#F1F5F9")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#E2E8F0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        return t

    story = []
    # ---------------- Cover ----------------
    story.append(h1("Biz-transPay"))
    story.append(Paragraph("<b>Documentation officielle de l\'API</b>", styles["Bodybtp"]))
    story.append(Spacer(1, 6))
    story.append(p(f"Version 1.0 . Domaine : <b>{OFFICIAL}</b> . Base URL : <b>{API_BASE}/v1</b>"))
    story.append(p("Encaissez des paiements crypto (Pay-In) et envoyez des retraits (Payouts) via "
                   "une API REST simple. Aucune configuration de webhooks n\'est requise : "
                   "vous interrogez nos endpoints /status pour connaitre l\'etat de chaque operation."))
    story.append(p("<b>Support</b> : depuis votre tableau de bord (> Support) ou par email."))

    # ---------------- Auth ----------------
    story.append(h2("1. Authentification"))
    story.append(p("Chaque requete doit inclure une cle secrete dans l\'entete "
                   "<b>Authorization: Bearer sk_test_...</b> ou <b>sk_live_...</b>."))
    story.append(code(f"curl {API_BASE}/v1/payments -H \"Authorization: Bearer sk_test_XXXXX\""))
    story.append(p("<b>Securite</b> : la cle secrete ne doit JAMAIS etre exposee cote navigateur "
                   "ni versionnee dans un depot Git."))

    # ---------------- Keys ----------------
    story.append(h2("2. Cles API"))
    story.append(p("Deux types de cles :"))
    story.append(_table([
        ["Prefixe", "Environnement", "Utilisation"],
        ["sk_test_", "Sandbox", "Developpement / tests, aucune charge reelle"],
        ["sk_live_", "Production", "Encaisse de vrais paiements clients"],
    ], [3.5 * cm, 3.5 * cm, 9.5 * cm]))
    story.append(p("La cle secrete est affichee UNE SEULE FOIS a la creation. Copiez-la immediatement. "
                   "Si vous la perdez, regenerez-la (l\'ancienne cesse alors de fonctionner)."))

    # ---------------- Payments (Pay-In) ----------------
    story.append(PageBreak())
    story.append(h2("3. Paiements (Pay-In)"))
    story.append(p("Encaissez des paiements crypto de vos clients. Notre systeme genere un lien de "
                   "checkout hoste, vous redirigez le client, puis vous verifiez le statut."))

    story.append(h3("Creer un paiement"))
    story.append(p(f"<b>POST</b> <font face=\"Courier\">{API_BASE}/v1/payments</font>"))
    story.append(code("""{
  "amount": 25.00,
  "coin": "USDT",
  "reference": "ORDER-42",
  "customer_email": "buyer@shop.com",
  "accepted_networks": ["TRC20", "BEP20", "ERC20"]
}"""))
    story.append(p("Reponse 200 : <font face=\"Courier\">id, status=initiated, payment_url, expires_at</font>. "
                   "Redirigez le client vers <font face=\"Courier\">payment_url</font>."))

    story.append(h3("Verifier le statut"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payments/{{id}}/status</font> - reponse legere "
                   "<font face=\"Courier\">{{id, status, updated_at}}</font>. Ideal pour du polling toutes les 5-10s."))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payments/{{id}}/completed</font> - booleen "
                   "<font face=\"Courier\">{{completed, status}}</font>."))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payments/{{id}}</font> - details complets. Auto-sync amont."))

    story.append(h3("Rechercher, lister, annuler"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payments/search?reference=ORDER-42</font>"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payments?limit=20&offset=0&status=paid</font>"))
    story.append(p(f"<b>POST</b> <font face=\"Courier\">{API_BASE}/v1/payments/{{id}}/cancel</font> - annule un paiement en attente "
                   "(409 si deja paye)."))

    story.append(h3("Statuts possibles"))
    story.append(_table([
        ["Status", "Signification"],
        ["initiated", "Cree, en attente que le client envoie les crypto"],
        ["confirming", "Transaction on-chain detectee, en attente de confirmations"],
        ["paid", "Paiement encaisse et credite"],
        ["expired", "Delai depasse (10 min par defaut)"],
        ["failed", "Rejete par la passerelle"],
        ["canceled", "Annule via /cancel"],
    ], [3 * cm, 13.5 * cm]))

    # ---------------- Payouts ----------------
    story.append(PageBreak())
    story.append(h2("4. Retraits (Payouts)"))
    story.append(p("Envoyez des crypto vers n\'importe quelle adresse externe. Le montant + frais est "
                   "debite du solde marchand puis relaye a la passerelle amont. Rembourse automatiquement "
                   "en cas de refus."))

    story.append(h3("Creer un retrait"))
    story.append(p(f"<b>POST</b> <font face=\"Courier\">{API_BASE}/v1/payouts</font>"))
    story.append(code("""{
  "amount": 25.00,
  "coin": "USDT",
  "network": "TRC20",
  "destination_address": "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
  "reference": "WD-42",
  "beneficiary_name": "John Doe",
  "fee_bearer": "sender"
}"""))
    story.append(p("Reponse 200 : <font face=\"Courier\">id, status=processing, amount, fee, total_debit, "
                   "provider_id, created_at</font>."))

    story.append(h3("Suivre / rechercher / lister"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payouts/{{id}}/status</font>"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payouts/{{id}}/completed</font>"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payouts/{{id}}</font> - details complets"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payouts/search?reference=WD-42</font>"))
    story.append(p(f"<b>GET</b> <font face=\"Courier\">{API_BASE}/v1/payouts?limit=20&status=completed</font>"))

    story.append(h3("Statuts possibles"))
    story.append(_table([
        ["Status", "Signification"],
        ["pending", "Debit effectue, en attente d\'envoi passerelle"],
        ["processing", "Envoye a la passerelle, en cours"],
        ["sent", "Broadcast on-chain, en attente de confirmation"],
        ["completed", "Retrait confirme"],
        ["failed", "Rejete par la passerelle - solde marchand rembourse"],
        ["canceled", "Annule cote passerelle - solde marchand rembourse"],
    ], [3 * cm, 13.5 * cm]))

    # ---------------- Errors ----------------
    story.append(PageBreak())
    story.append(h2("5. Gestion des erreurs"))
    story.append(p("Toutes les erreurs suivent un format uniforme :"))
    story.append(code("""{
  "statusCode": 400,
  "message": "Description lisible",
  "code": "MACHINE_CODE",
  "details": { /* contexte optionnel */ }
}"""))

    story.append(h3("Codes machine principaux"))
    story.append(_table([
        ["Code", "Signification"],
        ["MISSING_AUTH_HEADER", "Header Authorization absent"],
        ["INVALID_API_KEY", "Cle inconnue ou revoquee"],
        ["INSUFFICIENT_BALANCE", "Solde marchand insuffisant (retrait)"],
        ["INVALID_ASSET", "Couple coin/network non supporte"],
        ["INVALID_DESTINATION_ADDRESS", "Adresse incompatible avec le reseau"],
        ["AMOUNT_TOO_SMALL / TOO_LARGE", "Montant hors bornes"],
        ["PAYMENT_ALREADY_PAID", "Impossible d\'annuler un paiement encaisse"],
        ["GATEWAY_INSUFFICIENT_FUNDS", "Fonds insuffisants passerelle amont"],
        ["GATEWAY_UNREACHABLE", "Passerelle temporairement injoignable"],
        ["RATE_LIMITED", "Depassement de 100 requetes/minute/cle"],
        ["IDEMPOTENCY_KEY_TOO_LONG", "Idempotency-Key superieur a 255 caracteres"],
    ], [6 * cm, 10.5 * cm]))

    story.append(h3("Codes HTTP"))
    story.append(_table([
        ["Code", "Signification"],
        ["200", "Succes"],
        ["400", "Requete invalide"],
        ["401", "Cle API manquante ou invalide"],
        ["403", "Cle desactivee ou compte suspendu"],
        ["404", "Ressource introuvable"],
        ["409", "Conflit (ex : annuler un paiement paye)"],
        ["429", "Rate limit atteint"],
        ["500", "Erreur serveur"],
        ["502", "Passerelle amont injoignable"],
        ["503", "Service temporairement indisponible"],
    ], [2 * cm, 14.5 * cm]))

    # ---------------- Idempotency + Rate limits ----------------
    story.append(h2("6. Idempotence & Rate limits"))
    story.append(p("Ajoutez un header <b>Idempotency-Key</b> (max 255 caracteres) a toute requete POST. "
                   "En cas de retry (timeout reseau, doublon), la meme cle retourne la reponse originale - "
                   "aucun doublon cote serveur. Fenetre : 24 heures."))
    story.append(p("Chaque cle API a une limite de <b>100 requetes / minute</b>. Les reponses "
                   "incluent : <font face=\"Courier\">X-RateLimit-Limit</font>, <font face=\"Courier\">X-RateLimit-Remaining</font>, "
                   "<font face=\"Courier\">X-RateLimit-Reset</font>."))

    # ---------------- SDK Examples ----------------
    story.append(PageBreak())
    story.append(h2("7. Exemples d\'integration"))

    story.append(h3("cURL"))
    story.append(code(f"""curl -X POST {API_BASE}/v1/payments \\
  -H "Authorization: Bearer sk_test_XXXXX" \\
  -H "Idempotency-Key: order-42-attempt-1" \\
  -H "Content-Type: application/json" \\
  -d '{{"amount": 25, "coin": "USDT", "reference": "ORDER-42"}}'"""))

    story.append(h3("JavaScript"))
    story.append(code(f"""const res = await fetch('{API_BASE}/v1/payments', {{
  method: 'POST',
  headers: {{
    Authorization: 'Bearer sk_test_XXXXX',
    'Idempotency-Key': 'order-42-attempt-1',
    'Content-Type': 'application/json',
  }},
  body: JSON.stringify({{
    amount: 25, coin: 'USDT', reference: 'ORDER-42',
    customer_email: 'buyer@shop.com',
  }}),
}});
const payment = await res.json();
window.location.href = payment.payment_url;"""))

    story.append(h3("Node.js"))
    story.append(code(f"""import axios from 'axios';

const {{ data }} = await axios.post(
  '{API_BASE}/v1/payments',
  {{ amount: 25, coin: 'USDT', reference: 'ORDER-42' }},
  {{ headers: {{
    Authorization: 'Bearer sk_test_XXXXX',
    'Idempotency-Key': 'order-42-attempt-1',
  }} }}
);
console.log('Redirect to:', data.payment_url);"""))

    story.append(h3("PHP"))
    story.append(code(f"""<?php
$ch = curl_init('{API_BASE}/v1/payments');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer sk_test_XXXXX',
    'Idempotency-Key: order-42-attempt-1',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => 25, 'coin' => 'USDT', 'reference' => 'ORDER-42',
  ]),
]);
$response = json_decode(curl_exec($ch), true);
curl_close($ch);
header('Location: ' . $response['payment_url']);"""))

    story.append(h3("Python"))
    story.append(code(f"""import requests

payment = requests.post(
    '{API_BASE}/v1/payments',
    json={{'amount': 25, 'coin': 'USDT', 'reference': 'ORDER-42'}},
    headers={{
        'Authorization': 'Bearer sk_test_XXXXX',
        'Idempotency-Key': 'order-42-attempt-1',
    }},
).json()

print('Redirect to:', payment['payment_url'])"""))

    story.append(h3("Java"))
    story.append(code(f"""import java.net.http.*;
import java.net.URI;

var request = HttpRequest.newBuilder()
    .uri(URI.create("{API_BASE}/v1/payments"))
    .header("Authorization", "Bearer sk_test_XXXXX")
    .header("Idempotency-Key", "order-42-attempt-1")
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(
      "{{\"amount\":25,\"coin\":\"USDT\",\"reference\":\"ORDER-42\"}}"))
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.body());"""))

    story.append(h3("C#"))
    story.append(code(f"""using System.Net.Http.Json;

var http = new HttpClient();
http.DefaultRequestHeaders.Add("Authorization", "Bearer sk_test_XXXXX");
http.DefaultRequestHeaders.Add("Idempotency-Key", "order-42-attempt-1");

var response = await http.PostAsJsonAsync(
    "{API_BASE}/v1/payments",
    new {{ amount = 25, coin = "USDT", reference = "ORDER-42" }}
);
var payment = await response.Content.ReadFromJsonAsync<Dictionary<string, object>>();
Console.WriteLine(payment["payment_url"]);"""))

    # ---------------- Footer ----------------
    story.append(PageBreak())
    story.append(h2("8. Bonnes pratiques & FAQ"))
    story.append(p("- Toujours envoyer <b>Idempotency-Key</b> sur les POST pour eviter les doublons."))
    story.append(p("- Poller /status cote serveur, jamais depuis le navigateur (fuite de cle)."))
    story.append(p("- Stocker le champ <b>reference</b> pour rechercher plus tard via /search."))
    story.append(p("- Rotation immediate d\'une cle compromise depuis le tableau de bord."))
    story.append(p("- Utiliser <b>sk_test_</b> en developpement ; passer en <b>sk_live_</b> uniquement en production."))
    story.append(Spacer(1, 10))
    story.append(p(f"<i>Biz-transPay . {OFFICIAL} . Documentation generee automatiquement</i>"))

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
    """Fan-out webhook delivery — fires an HMAC-signed POST to every ACTIVE
    endpoint in `merchant_webhooks` that has subscribed to `event_type`.

    Falls back to the legacy single-webhook (`api_keys.webhook`) if the merchant
    hasn't migrated yet.
    """
    # Collect all destinations: multi-webhooks (new) + legacy fallback
    dests: list[dict] = []
    async for wh in db.merchant_webhooks.find({"user_id": user_id, "active": True}, {"_id": 0}):
        events = wh.get("events") or []
        if events and event_type not in events:
            continue
        dests.append({
            "id": wh["id"],
            "url": wh.get("url", "").strip(),
            "secret_encrypted": wh.get("secret_encrypted"),
            "secret_hash": wh.get("secret_hash"),
        })
    # If no dests yet (fresh account, not migrated), fall back to legacy
    if not dests:
        legacy = await db.api_keys.find_one({"user_id": user_id}, {"_id": 0})
        if legacy:
            wh = legacy.get("webhook") or {}
            events = wh.get("events") or []
            if wh.get("url") and (not events or event_type in events):
                dests.append({
                    "id": None,
                    "url": wh.get("url", "").strip(),
                    "secret_encrypted": wh.get("secret_encrypted"),
                    "secret_hash": wh.get("secret_hash"),
                })
    if not dests:
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
    signed_payload = f"{timestamp}.{body_json}".encode("utf-8")

    async def _fire(dest: dict) -> None:
        url = dest["url"]
        if not url or not await _is_safe_outbound_http_url(url):
            logger.warning("Skipping unsafe outbound webhook target for user %s", user_id)
            return
        plaintext_secret = _decrypt(dest.get("secret_encrypted") or "")
        sign_key = (plaintext_secret or dest.get("secret_hash") or "").encode("utf-8")
        signature = "sha256=" + hmac.new(sign_key, signed_payload, hashlib.sha256).hexdigest()
        delivery = {
            "id": new_id(),
            "user_id": user_id,
            "webhook_id": dest.get("id"),
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
                        {"id": delivery["id"]},
                        {"$set": {"status": "delivered" if ok else "failed",
                                  "status_code": r.status_code,
                                  "response_body": (r.text or "")[:2000],
                                  "delivered_at": now_iso()},
                         "$inc": {"attempts": 1}}
                    )
                    if dest.get("id"):
                        await db.merchant_webhooks.update_one(
                            {"id": dest["id"]},
                            {"$set": {"last_delivery_at": now_iso()},
                             "$inc": {"failure_count": 0 if ok else 1}},
                        )
                    if not ok and retry < 2:
                        await asyncio.sleep(2 ** (retry + 1) * 15)
                        await _attempt(retry + 1)
            except Exception as e:  # noqa: BLE001
                await db.webhook_deliveries.update_one(
                    {"id": delivery["id"]},
                    {"$set": {"status": "failed",
                              "response_body": f"Exception: {str(e)[:500]}",
                              "delivered_at": now_iso()},
                     "$inc": {"attempts": 1}}
                )
                if dest.get("id"):
                    await db.merchant_webhooks.update_one(
                        {"id": dest["id"]}, {"$inc": {"failure_count": 1}}
                    )
                if retry < 2:
                    await asyncio.sleep(2 ** (retry + 1) * 15)
                    await _attempt(retry + 1)

        asyncio.create_task(_attempt())

    for d in dests:
        await _fire(d)


# ==================== SETTINGS ====================
@api.patch("/settings/profile", response_model=UserPublic)
async def update_profile(req: UpdateProfile, uid: str = Depends(get_current_user_id)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if "two_fa_enabled" in updates:
        updates.pop("two_fa_enabled", None)
        raise HTTPException(400, "Utilisez la procédure de configuration 2FA")
    if "avatar_url" in updates:
        updates["avatar_url"] = _validate_image_source(
            updates["avatar_url"], "Photo"
        )
    protected_fields = {"full_name", "phone", "email"}
    if protected_fields.intersection(updates):
        current_user = await get_user(uid)
        if current_user.get("role") not in ("admin", "super_admin"):
            raise HTTPException(403, "Seul un administrateur peut modifier les informations d'identité")
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
    is_admin = u.get("role") in ("admin", "super_admin")
    password_errors = (
        auth_security.admin_password_policy_errors(req.new_password)
        if is_admin else auth_security.password_policy_errors(req.new_password)
    )
    if password_errors:
        raise HTTPException(
            422, "Mot de passe insuffisant : " + ", ".join(password_errors))
    if is_admin and verify_password(req.new_password, u["password_hash"]):
        raise HTTPException(
            422,
            "Le mot de passe administrateur doit être différent de l'ancien.",
        )
    if is_admin and u.get("two_fa_enabled") and not await _verify_user_totp(
            u, req.otp or ""):
        raise HTTPException(401, "Code 2FA requis pour changer le mot de passe")
    await db.users.update_one({"id": uid}, {"$set": {
        "password_hash": hash_password(req.new_password),
        "password_policy_version": 1,
    }})
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


@api.delete("/notifications/all")
async def notification_delete_all(uid: str = Depends(get_current_user_id)):
    r = await db.notifications.delete_many({"user_id": uid})
    return {"ok": True, "deleted": r.deleted_count}


@api.get("/notifications/stream")
async def notifications_stream(request: Request,
                               uid: str = Depends(get_current_user_id)):
    """Server-Sent Events stream authenticated by the HttpOnly session cookie.
    Emits:
        event: notification\ndata: {json}\n\n
    and heartbeats (': ping\n\n') every 25s to keep the socket alive.
    """
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
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "USER": set(),
    "MERCHANT": {"merchant:api"},
    "SUPPORT": {
        "users:read",
        "support:read",
        "support:write",
    },
    "FINANCE": {
        "users:read",
        "finance:read",
        "transactions:read",
        "transactions:write",
        "balances:write",
        "fees:read",
        "fees:write",
        "providers:read",
    },
    "COMPLIANCE": {
        "users:read",
        "kyc:read",
        "kyc:write",
    },
    # ADMIN keeps the existing operational administrator capability, but
    # administrator-account creation and destructive platform reset remain
    # SUPER_ADMIN-only.
    "ADMIN": {
        "users:read",
        "users:write",
        "finance:read",
        "transactions:read",
        "transactions:write",
        "balances:write",
        "fees:read",
        "fees:write",
        "providers:read",
        "providers:write",
        "kyc:read",
        "kyc:write",
        "links:read",
        "links:write",
        "api_keys:read",
        "api_keys:write",
        "support:read",
        "support:write",
        "settings:read",
        "settings:write",
        "audit:read",
        "admin_users:read",
    },
    "SUPER_ADMIN": {"*"},
}


def _effective_role(user: dict) -> str:
    if user.get("role") == "super_admin":
        return "SUPER_ADMIN"
    if user.get("role") == "admin":
        staff_role = (user.get("admin_role") or "general").lower()
        return {
            "support": "SUPPORT",
            "finance": "FINANCE",
            "compliance": "COMPLIANCE",
            # "general" and the legacy "operations" role are the
            # operational ADMIN role.
            "general": "ADMIN",
            "operations": "ADMIN",
        # Older administrator records can contain a staff-role value that is
        # no longer in the current catalogue. Keep those accounts in the
        # administrator permission boundary instead of silently downgrading
        # them to USER and blocking balance actions.
        }.get(staff_role, "ADMIN")
    if user.get("account_type") == "merchant":
        return "MERCHANT"
    return "USER"


def _permissions_for_role(role: str) -> set[str]:
    return ROLE_PERMISSIONS.get(role, set())


def _admin_permission_for_request(request: Request) -> Optional[str]:
    """Map an admin HTTP operation to one server-side permission."""
    path = request.url.path
    if path.startswith("/api/"):
        path = path[4:]
    method = request.method.upper()

    if path.startswith("/admin/support"):
        return "support:write" if method in {"PATCH", "POST", "DELETE"} else "support:read"
    if path.startswith("/admin/kyc"):
        return "kyc:write" if method != "GET" else "kyc:read"
    if path.startswith("/admin/users"):
        if path.endswith("/cleanup-test-users"):
            return "platform:reset"
        if method == "GET":
            return "users:read"
        if path.endswith("/credit") or path.endswith("/debit"):
            return "balances:write"
        return "users:write"
    if path.startswith("/admin/transactions"):
        return "transactions:read" if method == "GET" else "transactions:write"
    if path.startswith("/admin/links"):
        return "links:read" if method == "GET" else "links:write"
    if path.startswith("/admin/api-keys"):
        return "api_keys:read" if method == "GET" else "api_keys:write"
    if path.startswith("/admin/admins"):
        return "admin_users:read" if method == "GET" else "admin_users:write"
    if path == "/admin/funds" or path.startswith("/admin/funds/"):
        return "finance:read"
    if path.startswith("/admin/logs"):
        return "audit:read"
    if path.startswith("/admin/benefits") or path.startswith("/admin/stats") \
            or path.startswith("/admin/conversions") \
            or path.startswith("/admin/crypto/coins"):
        return "finance:read"
    if path.startswith("/admin/conversion/config"):
        return "fees:write" if method != "GET" else "finance:read"
    if path.startswith("/admin/payment-providers"):
        return "providers:write" if method not in {"GET", "HEAD"} else "providers:read"
    if path.startswith("/admin/transfer/config") or path.startswith("/admin/deposit/config"):
        return "fees:write" if method != "GET" else "fees:read"
    if path.startswith("/admin/platform/reset"):
        return "platform:reset"
    if path.startswith("/admin/platform/config") or path.startswith("/admin/settings"):
        return "settings:write" if method not in {"GET", "HEAD"} else "settings:read"
    return "settings:read"


async def get_admin(
    request: Request,
    uid: str = Depends(get_current_user_id),
) -> dict:
    if not _admin_ip_allowed(request):
        raise HTTPException(403, "Accès administrateur refusé depuis cette adresse IP")
    u = await db.users.find_one({"id": uid}, {"_id": 0})
    if not u:
        raise HTTPException(401, "Non autorisé")
    u = await _ensure_platform_owner_role(u)
    if u.get("role") not in ("admin", "super_admin"):
        raise HTTPException(403, "Accès administrateur requis")
    if not u.get("two_fa_enabled"):
        # A stale session must not keep an administrator inside the panel
        # after MFA has been disabled or before enrollment is completed.
        raise HTTPException(
            403,
            detail={
                "message": "MFA obligatoire pour accéder à l'administration.",
                "code": "ADMIN_MFA_REQUIRED",
            },
        )
    effective_role = _effective_role(u)
    permission = _admin_permission_for_request(request)
    permissions = _permissions_for_role(effective_role)
    if permission and "*" not in permissions and permission not in permissions:
        raise HTTPException(
            403,
            f"Permission requise : {permission}",
        )
    u["_effective_role"] = effective_role
    u["_permissions"] = sorted(permissions)
    return u


def _mbiyo_collection(payload: Any, aliases: tuple[str, ...],
                      mapping_values: bool = False, depth: int = 0) -> list[dict]:
    """Extract Mbiyo's documented ``{"data": [...]}`` collection strictly."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("Mbiyo response must contain a data list")
    records = payload["data"]
    if any(not isinstance(item, dict) for item in records):
        raise ValueError("Mbiyo data list contains a non-object item")
    return records


def _mbiyo_value(item: dict, *names: str) -> Any:
    for name in names:
        value = item.get(name)
        if value is not None and value != "":
            return value
    return None


def _mbiyo_text(value: Any, limit: int = 160) -> Optional[str]:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _mbiyo_amount(item: dict) -> Any:
    """Choose the provider's display amount before raw/legacy aliases."""
    return _mbiyo_value(
        item,
        "human_readable_amount",
        "humanReadableAmount",
        "human_readable_balance",
        "humanReadableBalance",
        "readable_amount",
        "display_amount",
        "displayAmount",
        "formatted_amount",
        "formattedAmount",
        "balance",
        "amount",
        "value",
        "total",
        "available_balance",
        "availableBalance",
        "available_amount",
        "availableAmount",
        "current_balance",
        "currentBalance",
    )


def _mbiyo_raw_amount(item: dict) -> Any:
    return _mbiyo_value(
        item,
        "raw_amount",
        "rawAmount",
        "amount_raw",
        "amountRaw",
        "balance_raw",
        "balanceRaw",
        "minor_amount",
        "amount_in_minor_units",
        "amountInMinorUnits",
        "amount",
    )


def _mbiyo_money_text(value: Any, *, required: bool = True) -> Optional[str]:
    """Return a finite provider amount as a JSON-safe decimal string."""
    if value is None or value == "":
        if required:
            raise ValueError("Missing Mbiyo monetary amount")
        return None
    if isinstance(value, (bool, dict, list, tuple, set)):
        raise ValueError("Invalid Mbiyo monetary amount")
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("Invalid Mbiyo monetary amount")
    if not amount.is_finite():
        raise ValueError("Invalid Mbiyo monetary amount")
    return format(amount, "f")


def _mbiyo_bool(item: dict, *names: str) -> bool:
    value = _mbiyo_value(item, *names)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "enabled", "active"}
    return bool(value)


def _sanitize_mbiyo_wallets(payload: Any) -> list[dict]:
    records = _mbiyo_collection(
        payload,
        ("wallets", "wallet", "walletList", "wallet_data", "items"),
    )
    clean = []
    for item in records:
        wallet_id = _mbiyo_text(_mbiyo_value(
            item, "id", "wallet_id", "walletId", "walletIdentifier",
            "wallet_code", "code", "name"
        ))
        currency = _mbiyo_text(_mbiyo_value(
            item, "currency", "currency_code", "currencyCode", "currency_code_iso"
        ))
        country_code = _mbiyo_text(_mbiyo_value(
            item, "country_code", "countryCode", "iso2",
        ))
        if not country_code:
            candidate = _mbiyo_text(item.get("country"))
            country_code = candidate if candidate and len(candidate) <= 3 else None
        country = _mbiyo_text(_mbiyo_value(item, "country", "country_name", "countryName"))
        if country_code and len(country_code) <= 3:
            country_code = country_code.upper()
        if country and country_code and country.upper() == country_code:
            country = None
        if not country and country_code:
            country = mbiyo.COUNTRY_LABELS.get(country_code, country_code)
        capabilities = item.get("capabilities")
        capabilities = capabilities if isinstance(capabilities, dict) else {}
        if not wallet_id or not currency:
            raise ValueError("Malformed Mbiyo wallet row")
        balance = _mbiyo_money_text(_mbiyo_amount(item))
        raw_amount = _mbiyo_money_text(_mbiyo_raw_amount(item), required=False)
        clean.append({
            "id": wallet_id,
            "currency": currency.upper() if currency else None,
            "country": country,
            "country_code": country_code,
            "balance": balance,
            "raw_amount": raw_amount,
            "topup": _mbiyo_bool(
                item, "topup", "top_up", "can_top_up", "canTopUp", "canTopup",
            ) or _mbiyo_bool(capabilities, "topup", "top_up", "can_top_up"),
            "payout": _mbiyo_bool(
                item, "payout", "can_payout", "canPayout",
            ) or _mbiyo_bool(capabilities, "payout", "can_payout"),
            "local_swap": _mbiyo_bool(
                item, "local_swap", "localSwap", "can_local_swap", "canLocalSwap",
            ) or _mbiyo_bool(capabilities, "local_swap", "localSwap", "can_local_swap"),
        })
    return clean


def _sanitize_mbiyo_networks(payload: Any) -> list[dict]:
    records = _mbiyo_collection(
        payload,
        (
            "network_balances", "networkBalances", "network_balance",
            "networks", "network", "operators", "balance", "items",
        ),
    )
    clean = []
    for item in records:
        country_code = _mbiyo_text(_mbiyo_value(
            item, "country_code", "countryCode", "iso2",
        ))
        if not country_code:
            candidate = _mbiyo_text(item.get("country"))
            country_code = candidate if candidate and len(candidate) <= 3 else None
        if country_code and len(country_code) <= 3:
            country_code = country_code.upper()
        country = _mbiyo_text(_mbiyo_value(item, "country", "country_name", "countryName"))
        if country and country_code and country.upper() == country_code:
            country = None
        if not country and country_code:
            country = mbiyo.COUNTRY_LABELS.get(country_code, country_code)
        network = _mbiyo_text(_mbiyo_value(
            item, "network", "network_code", "networkCode", "networkName",
            "operator_code", "operatorCode", "operator", "provider"
        ))
        operator = _mbiyo_text(_mbiyo_value(
            item, "operator", "operator_name", "operatorName", "providerName",
            "provider", "network"
        ))
        operator_label = mbiyo.NETWORK_LABELS.get(
            str(network or "").lower(),
            operator or network,
        )
        currency = (_mbiyo_text(_mbiyo_value(
            item, "currency", "currency_code", "currencyCode", "currency_code_iso"
        )) or "").upper() or None
        if not network or not country_code or not currency:
            raise ValueError("Malformed Mbiyo network balance row")
        balance = _mbiyo_money_text(_mbiyo_amount(item))
        clean.append({
            "network": network,
            "label": _mbiyo_text(_mbiyo_value(
                item, "label", "network_label", "networkLabel", "name", "network"
            )) if item.get("label") or item.get("network_label") \
                or item.get("networkLabel") or item.get("name") else operator_label,
            "operator": operator_label,
            "country": country,
            "country_code": country_code,
            "currency": currency,
            "balance": balance,
            "wallet_id": _mbiyo_text(_mbiyo_value(
                item, "wallet_id", "walletId", "wallet", "id"
            )),
        })
    return clean


def _mbiyo_wallet_totals(payload: Any) -> list[dict]:
    records = _mbiyo_collection(
        payload,
        (
            "balances", "wallet_balances", "wallet_totals", "walletTotals",
            "totals", "wallets", "wallet", "items",
        ),
        mapping_values=True,
    )
    totals: dict[str, Decimal] = {}
    for item in records:
        currency = _mbiyo_text(_mbiyo_value(
            item, "currency", "currency_code", "currencyCode", "code"
        ))
        currency = currency.upper() if currency else None
        if not currency:
            raise ValueError("Malformed Mbiyo balance row")
        amount = _mbiyo_amount(item)
        if amount is None:
            raise ValueError("Malformed Mbiyo balance row")
        try:
            numeric = Decimal(str(amount))
        except (InvalidOperation, TypeError, ValueError):
            raise ValueError("Invalid Mbiyo monetary amount")
        if not numeric.is_finite():
            raise ValueError("Invalid Mbiyo monetary amount")
        totals[currency] = totals.get(currency, Decimal("0")) + numeric
    return [
        {"currency": currency, "balance": format(amount, "f")}
        for currency, amount in sorted(totals.items())
    ]


@api.get("/admin/funds")
async def admin_funds(
    currency: Optional[str] = Query(None),
    country_code: Optional[str] = Query(None),
    admin=Depends(get_admin),
):
    """Read-only live Mbiyo wallet and Mobile Money network balances."""
    try:
        cfg = await get_mbiyo_config(decrypt=True)
    except Exception:
        logger.exception("Unable to load Mbiyo funds configuration")
        raise HTTPException(503, "Le service de soldes est temporairement indisponible.")
    api_key = str(cfg.get("_api_key") or "").strip()
    if not cfg.get("enabled", False) or not api_key:
        raise HTTPException(409, "Mbiyo est désactivé ou non configuré.")

    currency = str(currency or "").strip().upper() or None
    country_code = str(country_code or "").strip().upper() or None
    client = mbiyo.MbiyoClient(api_key, cfg.get("base_url", mbiyo.BASE_URL))
    try:
        wallets, balances, networks = await asyncio.gather(
            client.wallets(currency=currency),
            client.balances(currency=currency),
            client.network_balances(currency=currency, country_code=country_code),
        )
    except mbiyo.MbiyoError:
        raise HTTPException(502, "Mbiyo a refusé la lecture des soldes.")
    except (httpx.TimeoutException, httpx.NetworkError):
        raise HTTPException(503, "Mbiyo est temporairement indisponible.")
    except Exception:
        logger.exception("Unexpected Mbiyo funds request failure")
        raise HTTPException(503, "Le service de soldes est temporairement indisponible.")

    try:
        safe_wallets = _sanitize_mbiyo_wallets(wallets)
        safe_networks = _sanitize_mbiyo_networks(networks)
        safe_totals = _mbiyo_wallet_totals(balances)
    except ValueError:
        logger.exception("Mbiyo returned an invalid funds response")
        raise HTTPException(502, "Mbiyo a retourné un relevé de soldes invalide.")

    return {
        "provider": "mbiyo",
        "mode": cfg.get("mode", "test"),
        "refreshed_at": now_iso(),
        "wallets": safe_wallets,
        "network_balances": safe_networks,
        # Network balances intentionally never participate in these totals.
        "wallet_totals": safe_totals,
    }


async def require_admin_recent_auth(
    request: Request,
    uid: str = Depends(require_recent_auth),
) -> str:
    """Require password + MFA-backed recent authentication for admin actions."""
    user = await get_user(uid)
    if user.get("role") not in ("admin", "super_admin"):
        raise HTTPException(403, "Accès administrateur requis")
    if not user.get("two_fa_enabled"):
        raise HTTPException(
            403,
            detail={
                "message": "MFA obligatoire pour cette action.",
                "code": "ADMIN_MFA_REQUIRED",
            },
        )
    return uid


ADMIN_CONFIRMATION_PHRASE = "CONFIRMER"


def require_admin_confirmation(value: Optional[str]) -> None:
    if (value or "").strip().upper() != ADMIN_CONFIRMATION_PHRASE:
        raise HTTPException(
            428,
            detail={
                "message": (
                    "Une confirmation explicite est requise. "
                    "Saisissez CONFIRMER."
                ),
                "code": "ADMIN_CONFIRMATION_REQUIRED",
            },
        )


async def _record_admin_request(request: Request, status_code: int) -> None:
    """Persist every admin endpoint access, including denied attempts."""
    try:
        uid = getattr(request.state, "user_id", None)
        user = await db.users.find_one(
            {"id": uid}, {"_id": 0, "username": 1, "role": 1}
        ) if uid else None
        await db.admin_logs.insert_one({
            "id": new_id(),
            "admin_id": uid,
            "admin_username": (user or {}).get("username"),
            "action": "admin_request",
            "target_user_id": None,
            "target_username": None,
            "details": {
                "method": request.method,
                "path": request.url.path,
                "query": str(request.url.query or ""),
                "status": status_code,
                "ip": _admin_request_ip(request),
                "user_agent": request.headers.get("user-agent", "")[:300],
            },
            "created_at": now_iso(),
        })
    except Exception:
        logging.getLogger(__name__).exception(
            "Unable to persist administrator access log"
        )



class AdminConversionConfigReq(BaseModel):
    conversion_rates: Optional[dict] = None
    conversion_limits: Optional[dict] = None
    conversion_pairs_enabled: Optional[dict] = None
    conversion_fee: Optional[dict] = None


@api.get("/admin/conversion/config")
async def admin_get_conversion_config(admin=Depends(get_admin)):
    cfg = await get_platform_config()
    return {
        "rates": cfg.get("conversion_rates") or {},
        "limits": cfg.get("conversion_limits") or {},
        "pairs_enabled": cfg.get("conversion_pairs_enabled") or {},
        "fee": cfg.get("conversion_fee") or {},
        "supported_pairs": [f"{a}_{b}" for a, b in SUPPORTED_CONVERSION_PAIRS],
    }


@api.patch("/admin/conversion/config")
async def admin_update_conversion_config(req: AdminConversionConfigReq, admin=Depends(get_admin)):
    updates: dict = {}
    if req.conversion_rates is not None:
        updates["conversion_rates"] = req.conversion_rates
    if req.conversion_limits is not None:
        updates["conversion_limits"] = req.conversion_limits
    if req.conversion_pairs_enabled is not None:
        updates["conversion_pairs_enabled"] = req.conversion_pairs_enabled
    if req.conversion_fee is not None:
        updates["conversion_fee"] = req.conversion_fee
    if not updates:
        raise HTTPException(400, "Aucune modification")
    await db.settings.update_one({"id": "platform_config"}, {"$set": updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_conversion_config", details=list(updates.keys()))
    return await admin_get_conversion_config(admin=admin)


@api.get("/admin/conversions")
async def admin_list_conversions(admin=Depends(get_admin),
                                   period: str = "month",
                                   limit: int = 200):
    """Aggregated view + list of every conversion. Powers the admin tracking page."""
    since = None
    now = datetime.now(timezone.utc)
    if period == "day":
        since = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":
        since = now - timedelta(days=7)
    elif period == "month":
        since = now - timedelta(days=30)
    q: dict = {"type": "exchange"}
    if since:
        q["created_at"] = {"$gte": since.isoformat()}
    docs = await db.transactions.find(q, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    for d in docs:
        u = await db.users.find_one({"id": d["user_id"]},
            {"_id": 0, "username": 1, "full_name": 1, "email": 1})
        d["user"] = u or {}
    # Aggregate summary.
    total_all = await db.transactions.count_documents({"type": "exchange"})
    total_today = await db.transactions.count_documents({
        "type": "exchange",
        "created_at": {"$gte": now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()},
    })
    validated = await db.transactions.count_documents({"type": "exchange", "status": "completed"})
    rejected = await db.transactions.count_documents({"type": "exchange", "status": "failed"})
    # Volume by source currency.
    vol_by_cur = {"USDT": 0.0, "XOF": 0.0, "XAF": 0.0}
    async for tx in db.transactions.find({"type": "exchange", "status": "completed"}, {"_id": 0}):
        cur = (tx.get("currency") or "").upper()
        if cur in vol_by_cur:
            vol_by_cur[cur] += float(tx.get("amount", 0) or 0)
    return {
        "data": docs,
        "totals": {
            "all": total_all, "today": total_today,
            "validated": validated, "rejected": rejected,
        },
        "volume_by_currency": vol_by_cur,
    }



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
    crypto_section = (cfg.get("crypto") or {})
    fees = (crypto_section.get("fees") or {})
    fees_gw_fixed = (crypto_section.get("fees_gateway_fixed") or {})
    hidden = set(crypto_section.get("hidden_coins") or [])
    result = []
    for c in sorted(coins.keys()):
        if c in hidden:
            continue
        entry = coins[c]
        entry["fee_pct"] = float(fees.get(c, 4.0))
        entry["gateway_fee_fixed"] = float(fees_gw_fixed.get(c, 0) or 0)
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
async def admin_crypto_coins(direction: str = "withdrawal",
                             refresh: bool = False,
                             admin=Depends(get_admin)):
    """List all coins available on IziChange, grouped by ticker, with the
    per-coin fee split (gateway/platform) and hidden flag for the requested
    direction. `direction` = "withdrawal" (default, reads transfer_config)
    or "deposit" (reads deposit_config).
    Returns: [{coin, name, fee_pct, gateway_fee_pct, platform_fee_pct, hidden}]
    """
    coins: dict[str, str] = {}
    if izipay.is_configured():
        try:
            assets = await izipay.list_assets(force=refresh)
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
    if direction == "deposit":
        cfg = await get_deposit_config()
        section = cfg.get("crypto") or {}
    else:
        cfg = await get_transfer_config()
        section = cfg.get("crypto") or {}
    fees = section.get("fees") or {}
    fees_g = section.get("fees_gateway") or {}
    fees_p = section.get("fees_platform") or {}
    fees_g_fixed = section.get("fees_gateway_fixed") or {}
    hidden = set(section.get("hidden_coins") or [])
    # Always include configured coins even if not returned by API (e.g. temporarily disabled)
    for c in fees:
        coins.setdefault(c, c)
    for c in hidden:
        coins.setdefault(c, c)
    result = []
    for c in sorted(coins.keys()):
        total = float(fees.get(c, 4.0))
        gw = float(fees_g[c]) if c in fees_g else total
        pf = float(fees_p[c]) if c in fees_p else 0.0
        gw_fixed = float(fees_g_fixed[c]) if c in fees_g_fixed else 0.0
        result.append({
            "coin": c,
            "name": coins[c],
            "fee_pct": total,
            "gateway_fee_pct": gw,
            "platform_fee_pct": pf,
            "gateway_fee_fixed": gw_fixed,
            "hidden": c in hidden,
        })
    return result


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
    # The product labels the dollar-denominated wallet as USDT. Accept USD as
    # an admin API alias as well, but persist it consistently as USDT.
    currency: Literal["XOF", "XAF", "USDT", "USD"]
    amount: float = Field(..., gt=0)
    reason: Optional[str] = ""
    confirmation: Optional[str] = None
    action_id: Optional[str] = Field(None, min_length=8, max_length=120)


class AdminUpdateUser(BaseModel):
    full_name: Optional[str] = None
    username: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    country: Optional[str] = None
    role: Optional[Literal["user", "admin", "super_admin"]] = None
    admin_role: Optional[Literal[
        "general", "finance", "operations", "support", "compliance"
    ]] = None
    account_type: Optional[Literal["personal", "merchant"]] = None
    confirmation: Optional[str] = None


class AdminCreateRequest(BaseModel):
    full_name: str
    username: str
    email: str
    password: str
    admin_role: Literal[
        "general", "finance", "operations", "support", "compliance"
    ] = "general"
    country: str = "TG"
    phone: str = ""
    confirmation: Optional[str] = None


class AdminKycDecision(BaseModel):
    approve: bool
    reason: Optional[str] = ""
    request_resubmit: bool = False


class AdminResetPwd(BaseModel):
    new_password: str
    confirmation: Optional[str] = None


class AdminConfirmationRequest(BaseModel):
    confirmation: Optional[str] = None


@api.get("/admin/benefits/details")
async def admin_benefits_details(period: str = "all",
                                  q: Optional[str] = None,
                                  currency: Optional[str] = None,
                                  type: Optional[str] = None,
                                  limit: int = 100, offset: int = 0,
                                  admin=Depends(get_admin)):
    """Detailed history of platform-fee-generating transactions.
    Powers /admin/benefits detail drawer.
    - period : all | 7d | 30d
    - q      : text search (matches reference, user name/email, description)
    - currency : XOF | XAF | USDT (single filter)
    - type   : deposit | withdrawal | transfer | link_payment | payment | exchange
    - limit/offset : pagination
    Returns : { total, items: [{tx_id, date, type, reference, user, currency, amount, platform_fee, gateway_fee, description}] }
    """
    match: dict = {"metadata.platform_fee": {"$exists": True, "$ne": None},
                   "status": {"$in": ["completed", "paid"]}}
    if period in ("7d", "30d"):
        days = 7 if period == "7d" else 30
        since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        match["created_at"] = {"$gte": since_iso}
    if currency:
        match["currency"] = currency.upper()
    if type:
        match["type"] = type

    # Text search
    user_ids: Optional[list[str]] = None
    if q:
        needle = _literal_regex_term(q, field_name="Recherche")
        # Search users first (name/email)
        udocs = await db.users.find(
            {"$or": [
                {"full_name": {"$regex": needle, "$options": "i"}},
                {"email": {"$regex": needle, "$options": "i"}},
                {"phone": {"$regex": needle, "$options": "i"}},
            ]},
            {"id": 1}
        ).to_list(200)
        user_ids = [u["id"] for u in udocs]
        match["$or"] = [
            {"reference": {"$regex": needle, "$options": "i"}},
            {"description": {"$regex": needle, "$options": "i"}},
            {"id": needle},
        ]
        if user_ids:
            match["$or"].append({"user_id": {"$in": user_ids}})

    total = await db.transactions.count_documents(match)
    docs = await db.transactions.find(match, {"_id": 0}) \
        .sort("created_at", -1) \
        .skip(int(offset)).limit(min(int(limit), 500)) \
        .to_list(500)

    # Enrich with user info
    tx_user_ids = list({d.get("user_id") for d in docs if d.get("user_id")})
    users = {}
    if tx_user_ids:
        async for u in db.users.find({"id": {"$in": tx_user_ids}},
                                       {"id": 1, "full_name": 1, "email": 1, "_id": 0}):
            users[u["id"]] = {"name": u.get("full_name"), "email": u.get("email")}

    type_labels_fr = {
        "deposit": "Frais dépôt",
        "withdrawal": "Frais retrait",
        "transfer": "Frais retrait",
        "link_payment": "Frais lien",
        "payment": "Frais API",
        "exchange": "Frais conversion",
    }

    items = []
    for d in docs:
        meta = d.get("metadata") or {}
        u = users.get(d.get("user_id")) or {}
        items.append({
            "tx_id": d.get("id"),
            "date": d.get("created_at"),
            "type": d.get("type"),
            "type_label": type_labels_fr.get(d.get("type"), d.get("type")),
            "reference": d.get("reference"),
            "user": {"id": d.get("user_id"), **u},
            "currency": d.get("currency"),
            "amount": float(d.get("amount") or 0),
            "platform_fee": float(meta.get("platform_fee") or 0),
            "gateway_fee": float(meta.get("gateway_fee") or 0),
            "fee_total": float(meta.get("fee") or 0),
            "description": d.get("description"),
        })
    return {"total": total, "limit": limit, "offset": offset, "items": items}


@api.get("/admin/benefits")
async def admin_benefits(period: str = "all", admin=Depends(get_admin)):
    """Return the accumulated PLATFORM fees (i.e. Biz-transPay's own margin,
    excluding the gateway share) grouped by currency (XOF, XAF, USDT).
    Reads `metadata.platform_fee` on completed transactions.
    period = "7d" | "30d" | "all"
    """
    match: dict = {"metadata.platform_fee": {"$exists": True, "$ne": None},
                   "status": {"$in": ["completed", "paid"]}}
    if period in ("7d", "30d"):
        days = 7 if period == "7d" else 30
        since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        match["created_at"] = {"$gte": since_iso}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$currency",
            "total": {"$sum": "$metadata.platform_fee"},
            "count": {"$sum": 1},
        }},
    ]
    buckets = {"XOF": {"total": 0.0, "count": 0},
               "XAF": {"total": 0.0, "count": 0},
               "USDT": {"total": 0.0, "count": 0}}
    async for row in db.transactions.aggregate(pipeline):
        cur = (row.get("_id") or "").upper()
        if cur in buckets:
            buckets[cur] = {"total": float(row.get("total") or 0),
                            "count": int(row.get("count") or 0)}
    return {
        "period": period,
        "xof": buckets["XOF"],
        "xaf": buckets["XAF"],
        "usdt": buckets["USDT"],
    }


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
    # Per-channel breakdown with status buckets (pending / valid / rejected).
    def _empty_ch():
        return {
            "count": 0, "amount_xof": 0.0, "amount_usdt": 0.0,
            "pending": {"count": 0, "amount": 0.0},
            "valid": {"count": 0, "amount": 0.0},
            "rejected": {"count": 0, "amount": 0.0},
        }
    dep_mm = _empty_ch()
    dep_crypto = _empty_ch()
    wd_mm = _empty_ch()
    wd_crypto = _empty_ch()
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

        if typ == "deposit" or (typ in ("link_payment", "payment") and direction == "in"):
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
            ch = dep_crypto if is_crypto else dep_mm
            if st == "completed":
                ch["count"] += 1
                if is_crypto: ch["amount_usdt"] += amt
                else: ch["amount_xof"] += amt
                ch["valid"]["count"] += 1
                ch["valid"]["amount"] += amt
            elif st == "pending":
                ch["pending"]["count"] += 1
                ch["pending"]["amount"] += amt
            elif st in ("failed", "cancelled"):
                ch["rejected"]["count"] += 1
                ch["rejected"]["amount"] += amt
            # Also keep the "operations" sub-counters populated so the merchant
            # can still see the link vs API split further down.
            if typ == "link_payment" and st == "completed":
                link_payments["count"] += 1
                link_payments["amount_usdt"] += amt
            elif typ == "payment" and st == "completed":
                api_payments["count"] += 1
                api_payments["amount_usdt"] += amt
        elif typ == "deposit":
            # Never taken (kept for clarity, superseded by combined branch above)
            pass
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
            ch = wd_crypto if is_crypto else wd_mm
            if st == "completed":
                ch["count"] += 1
                if is_crypto: ch["amount_usdt"] += amt
                else: ch["amount_xof"] += amt
                ch["valid"]["count"] += 1
                ch["valid"]["amount"] += amt
            elif st == "pending":
                ch["pending"]["count"] += 1
                ch["pending"]["amount"] += amt
            elif st in ("failed", "cancelled"):
                ch["rejected"]["count"] += 1
                ch["rejected"]["amount"] += amt
        elif typ == "transfer" and direction == "in":
            # Received leg of a biz-to-biz transfer — count for volume view.
            if (meta.get("transfer_type") or "biz_to_biz") == "biz_to_biz":
                biz_to_biz["count"] += 1
        elif typ == "link_payment":
            # In-flight (pending/failed) link payments — the completed ones are
            # already counted above as deposits + link_payments sub-counter.
            pass
        elif typ == "payment":
            # Same as above for merchant API payments.
            pass
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
        safe_q = _literal_regex_term(q, field_name="Recherche")
        query["$or"] = [
            {"full_name": {"$regex": safe_q, "$options": "i"}},
            {"email": {"$regex": safe_q, "$options": "i"}},
            {"username": {"$regex": safe_q, "$options": "i"}},
            {"phone": {"$regex": safe_q, "$options": "i"}},
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
async def admin_credit(
    user_id: str,
    req: AdminBalanceAction,
    admin=Depends(get_admin),
    _recent_uid: str = Depends(require_admin_recent_auth),
):
    require_admin_confirmation(req.confirmation)
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    currency = "USDT" if req.currency in ("USDT", "USD") else req.currency
    field = {
        "XOF": "balance_xof",
        "XAF": "balance_xaf",
        "USDT": "balance_usdt",
    }[currency]
    operation_id = f"admin-balance:{req.action_id or new_id()}"
    credited = await _credit_wallet_once(user_id, field, req.amount, operation_id)
    await record_tx(user_id, "deposit", "in", req.amount, currency,
                    description=f"Crédit administrateur ({req.reason or 'manuel'})",
                    metadata={"admin_id": admin["id"], "admin_username": admin["username"]},
                    operation_id=operation_id)
    await audit(admin["id"], admin["username"], "credit",
                target_user_id=user_id, target_username=target["username"],
                details={"amount": req.amount, "currency": currency, "reason": req.reason})
    return {"ok": True, "applied": credited}


@api.post("/admin/users/{user_id}/debit")
async def admin_debit(
    user_id: str,
    req: AdminBalanceAction,
    admin=Depends(get_admin),
    _recent_uid: str = Depends(require_admin_recent_auth),
):
    require_admin_confirmation(req.confirmation)
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    currency = "USDT" if req.currency in ("USDT", "USD") else req.currency
    field = {
        "XOF": "balance_xof",
        "XAF": "balance_xaf",
        "USDT": "balance_usdt",
    }[currency]
    operation_id = f"admin-balance:{req.action_id or new_id()}"
    debited = await _debit_wallet_once(user_id, field, req.amount, operation_id)
    if not debited:
        # A replay of an already-applied action is safe and should remain
        # idempotent; a new action with no funds is rejected.
        existing = await db.transactions.find_one(
            {"user_id": user_id, "metadata.operation_id": operation_id}, {"_id": 0})
        if not existing:
            raise HTTPException(400, "Solde utilisateur insuffisant")
    await record_tx(user_id, "withdrawal", "out", req.amount, currency,
                    description=f"Débit administrateur ({req.reason or 'manuel'})",
                    metadata={"admin_id": admin["id"], "admin_username": admin["username"]},
                    operation_id=operation_id)
    await audit(admin["id"], admin["username"], "debit",
                target_user_id=user_id, target_username=target["username"],
                details={"amount": req.amount, "currency": currency, "reason": req.reason})
    return {"ok": True, "applied": debited}


@api.patch("/admin/users/{user_id}")
async def admin_update_user(
    user_id: str,
    req: AdminUpdateUser,
    admin=Depends(get_admin),
    _recent_uid: str = Depends(require_admin_recent_auth),
):
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    confirmation = updates.pop("confirmation", None)
    if _platform_owner_recovery_eligible(target) and any(
        field in updates for field in ("role", "admin_role", "email")
    ):
        raise HTTPException(
            403,
            "Le propriétaire de la plateforme ne peut pas être rétrogradé ni transféré",
        )
    # only super_admin can change roles
    if "role" in updates and admin.get("role") != "super_admin":
        raise HTTPException(403, "Seul un super_admin peut modifier les rôles")
    if "admin_role" in updates and admin.get("role") != "super_admin":
        raise HTTPException(403, "Seul un super_admin peut modifier les rôles")
    if "role" in updates or "admin_role" in updates:
        require_admin_confirmation(confirmation)
    if updates.get("admin_role") and updates.get("role") not in (None, "admin"):
        raise HTTPException(422, "Un rôle administratif nécessite un compte admin")
    # Enforce uniqueness on username/email if being changed
    if "username" in updates and updates["username"] != target.get("username"):
        exists = await db.users.find_one({"username": updates["username"], "id": {"$ne": user_id}}, {"_id": 0, "id": 1})
        if exists:
            raise HTTPException(409, "Nom d'utilisateur déjà utilisé")
    if "email" in updates and updates["email"] != target.get("email"):
        exists = await db.users.find_one({"email": updates["email"], "id": {"$ne": user_id}}, {"_id": 0, "id": 1})
        if exists:
            raise HTTPException(409, "Adresse email déjà utilisée")
    update_ops = {}
    if updates.get("role") == "user":
        updates.pop("admin_role", None)
        update_ops["$unset"] = {"admin_role": ""}
    if updates:
        update_ops["$set"] = updates
    if update_ops:
        await db.users.update_one({"id": user_id}, update_ops)
        # Keep the API/webhook container available after promotion, but do not
        # provision a key. Merchants create their first key explicitly.
        if updates.get("account_type") == "merchant":
            await _ensure_api_keys(user_id)
    await audit(admin["id"], admin["username"], "update_user",
                target_user_id=user_id, target_username=target["username"],
                details=updates)
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    return u


@api.post("/admin/users/{user_id}/reset-password")
async def admin_reset_password(
    user_id: str,
    req: AdminResetPwd,
    admin=Depends(get_admin),
    _recent_uid: str = Depends(require_admin_recent_auth),
):
    require_admin_confirmation(req.confirmation)
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    password_errors = (
        auth_security.admin_password_policy_errors(req.new_password)
        if target.get("role") in ("admin", "super_admin")
        else auth_security.password_policy_errors(req.new_password)
    )
    if password_errors:
        raise HTTPException(
            422, "Mot de passe insuffisant : " + ", ".join(password_errors))
    await db.users.update_one({"id": user_id}, {"$set": {
        "password_hash": hash_password(req.new_password),
        "password_policy_version": 1,
    }})
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
    if target.get("role") == "super_admin" or _platform_owner_recovery_eligible(target):
        raise HTTPException(
            403,
            "Impossible de supprimer un super_admin ou le propriétaire de la plateforme",
        )
    if target["id"] == admin["id"]:
        raise HTTPException(403, "Vous ne pouvez pas supprimer votre propre compte")

    # Cascade delete across all user-linked collections.
    r_user = await db.users.delete_one({
        "id": user_id,
        "role": {"$ne": "super_admin"},
        "platform_owner": {"$ne": True},
    })
    if r_user.deleted_count != 1:
        raise HTTPException(409, "Ce compte protégé ne peut pas être supprimé")
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
    keep = await db.users.find(
        _platform_owner_preservation_filter(),
        {"_id": 0, "id": 1},
    ).to_list(100)
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
    delete_all: bool = False


@api.post("/admin/platform/reset")
async def admin_platform_reset(req: AdminPlatformResetReq,
                               admin=Depends(get_admin),
                               _recent_uid: str = Depends(require_admin_recent_auth)):
    """DESTRUCTIVE — Full platform reset. Super_admin only.

    Deletes ALL non-super_admin users and their data, wipes ALL transactional
    collections platform-wide (transactions, links, webhooks, api_logs,
    notifications, kyc, tickets, etc.), and resets balances of every
    remaining super_admin to 0. Idempotent and audited.

    Requires body `{"confirmation": "RÉINITIALISER"}` to prevent accidents.
    """
    if admin.get("role") != "super_admin":
        raise HTTPException(403, "Réservé aux super_admin")
    if req.delete_all:
        if req.confirmation != "SUPPRIMER_TOUT":
            raise HTTPException(
                400,
                "Confirmation invalide. Tapez exactement SUPPRIMER_TOUT.",
            )
        wipe_all_collections = [
            "users",
            "api_keys",
            "kyc",
            "sessions",
            "mfa_enrollments",
            "platform_bootstrap",
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
            "merchant_payouts",
            "momo_deposits",
            "merchant_keys",
            "merchant_webhooks",
            "idempotency_keys",
            "auth_challenges",
            "auth_events",
            "auth_rate_limits",
            "admin_logs",
            "audit_logs",
        ]
        wiped: dict[str, int] = {}
        for collection in wipe_all_collections:
            result = await db[collection].delete_many({})
            wiped[collection] = result.deleted_count
        # Do not write an audit record after a full wipe: the requested final
        # state is that no account or user-linked data remains.
        return {
            "deleted_users": wiped["users"],
            "kept_super_admins": [],
            "wiped": wiped,
            "balances_reset": True,
            "requires_registration": True,
        }
    if req.confirmation != "RÉINITIALISER":
        raise HTTPException(400, "Confirmation invalide. Tapez exactement RÉINITIALISER.")

    keep = await db.users.find(
        _platform_owner_preservation_filter(),
        {"_id": 0, "id": 1, "email": 1},
    ).to_list(100)
    keep_ids = [u["id"] for u in keep]

    # 1) Delete every non-super_admin user
    r_users = await db.users.delete_many({"id": {"$nin": keep_ids}})

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
        {"id": {"$in": keep_ids}},
        {"$set": {"balance_xof": 0.0, "balance_xaf": 0.0, "balance_usdt": 0.0}},
    )

    # 4) Recreate only the non-key API container for preserved super_admins.
    #    API keys remain an explicit user action.
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
        reviewed_at = now_iso()
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "verified",
                                                                 "verified_at": reviewed_at,
                                                                 "reject_reason": None}})
        act = "kyc_approve"
        kyc_type = "kyc_verified"
        kyc_data = {"status": "verified", "reviewed_at": reviewed_at}
        await notify(user_id, "kyc_verified",
                     "KYC vérifié ✓",
                     "Votre identité a été vérifiée. Vous pouvez maintenant utiliser toutes les fonctionnalités (liens de paiement, API, retraits).",
                     data=kyc_data)
    elif req.request_resubmit:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "not_started"}})
        reviewed_at = now_iso()
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "resubmit_requested",
                                                                 "reject_reason": req.reason,
                                                                 "reviewed_at": reviewed_at}})
        act = "kyc_request_resubmit"
        kyc_type = "kyc_resubmit_requested"
        kyc_data = {
            "status": "resubmit_requested",
            "reason": req.reason,
            "reviewed_at": reviewed_at,
        }
        await notify(user_id, "kyc_resubmit_requested",
                     "KYC — nouveaux documents demandés",
                     req.reason or "Merci de renvoyer vos documents KYC.",
                     data=kyc_data)
    else:
        await db.users.update_one({"id": user_id}, {"$set": {"kyc_status": "rejected"}})
        reviewed_at = now_iso()
        await db.kyc.update_one({"user_id": user_id}, {"$set": {"status": "rejected",
                                                                 "reject_reason": req.reason,
                                                                 "reviewed_at": reviewed_at}})
        act = "kyc_reject"
        kyc_type = "kyc_rejected"
        kyc_data = {
            "status": "rejected",
            "reason": req.reason,
            "reviewed_at": reviewed_at,
        }
        await notify(user_id, "kyc_rejected",
                     "KYC rejeté",
                     req.reason or "Votre demande de KYC a été rejetée. Contactez le support pour plus d'informations.",
                     data=kyc_data)
    await _queue_telegram_notification(
        user_id,
        kyc_type,
        "Décision KYC",
        "Le statut de la vérification KYC a été mis à jour.",
        kyc_data,
    )
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
        esc = _literal_regex_term(q, field_name="Recherche")
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


@api.get("/admin/transactions/{tx_id}")
async def admin_transaction_detail(tx_id: str, admin=Depends(get_admin)):
    """Full details for a single transaction, enriched with the user's
    identity and country. Used by the manual-validation modal."""
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction introuvable")
    u = await db.users.find_one({"id": tx["user_id"]},
        {"_id": 0, "id": 1, "username": 1, "full_name": 1, "email": 1,
         "phone": 1, "country": 1, "balance_usdt": 1, "balance_xof": 1})
    tx["user"] = u or {}
    return tx


async def _notify_user(uid: str, title: str, message: str,
                        kind: str = "info", metadata: Optional[dict] = None):
    """Push an SSE + persisted notification to a user. Silent on error."""
    try:
        doc = {
            "id": new_id(), "user_id": uid,
            "title": title, "message": message,
            "kind": kind, "read": False,
            "metadata": metadata or {},
            "created_at": now_iso(),
        }
        await db.notifications.insert_one(doc)
        # SSE broadcast to any live listener of this user.
        for q in list(_sse_subscribers.get(uid, [])):
            try:
                q.put_nowait({k: v for k, v in doc.items() if k != "_id"})
            except Exception:
                pass
    except Exception as e:  # noqa: BLE001
        logger.warning("_notify_user failed for %s: %s", uid, e)


def _tx_is_crypto(tx: dict) -> bool:
    meta = tx.get("metadata") or {}
    cur = (tx.get("currency") or "").upper()
    return (
        cur == "USDT"
        or (meta.get("transfer_type") in ("biz_to_crypto",))
        or bool(meta.get("crypto") or meta.get("coin") or meta.get("izipay_intent_id"))
    )


@api.post("/admin/transactions/{tx_id}/refresh")
async def admin_refresh_transaction(tx_id: str, admin=Depends(get_admin)):
    """Re-check the upstream gateway (IziChange) for a pending crypto payout
    and update our transaction status accordingly. Useful when the webhook
    was missed but the payout was actually executed.
    """
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction introuvable")
    if tx.get("status") not in ("pending",):
        return {"ok": True, "unchanged": True, "reason": f"status={tx.get('status')}", "tx": tx}
    meta = tx.get("metadata") or {}
    payout_id = meta.get("izipay_payout_id")
    if not payout_id:
        raise HTTPException(400, "Cette transaction n'a pas d'identifiant de payout à rafraîchir.")
    if not izipay.is_configured():
        raise HTTPException(503, "Passerelle crypto non configurée")
    try:
        data = await izipay.get_payout(payout_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Impossible d'interroger la passerelle : {e}")
    upstream_status = (data.get("status") or "").lower()
    mapped = _map_izipay_payout_status(upstream_status, tx.get("status"))
    updates: dict = {"metadata.izipay_status": upstream_status}
    if mapped == "completed":
        updates["status"] = "completed"
        updates["metadata.tx_hash"] = data.get("txHash") or data.get("txhash") or data.get("transactionHash")
        await audit(admin["id"], admin["username"], "tx_refresh_completed",
                    target_user_id=tx["user_id"],
                    details={"tx_id": tx_id, "payout_id": payout_id, "upstream": upstream_status})
    elif mapped == "failed":
        updates["status"] = "failed"
        # Refund if not already refunded
        total_debit = float(meta.get("total_debit", tx.get("amount", 0)))
        currency = tx.get("currency", "USDT")
        field = f"balance_{currency.lower()}"
        await _refund_wallet_once(
            tx["user_id"], field, total_debit, f"transaction:{tx_id}")
        await audit(admin["id"], admin["username"], "tx_refresh_failed",
                    target_user_id=tx["user_id"],
                    details={"tx_id": tx_id, "payout_id": payout_id, "upstream": upstream_status})
    await db.transactions.update_one({"id": tx_id}, {"$set": updates})
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    return {"ok": True, "tx": tx, "upstream_status": upstream_status, "mapped_status": mapped}


@api.post("/admin/transactions/{tx_id}/approve")
async def admin_approve_transaction(
    tx_id: str,
    body: AdminConfirmationRequest = Body(default_factory=AdminConfirmationRequest),
    admin=Depends(get_admin),
    _recent_uid: str = Depends(require_admin_recent_auth),
):
    """Manually validate a pending transaction.

    - Deposit → credits the user's balance (crypto → balance_usdt, MoMo → balance_xof)
      then marks the transaction 'completed'.
    - Withdrawal → simply marks 'completed' (balance was already debited on request).
    - Any other pending transaction → marks 'completed' without balance side-effects.
    """
    require_admin_confirmation(body.confirmation)
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction introuvable")
    if tx.get("status") != "pending":
        raise HTTPException(400, f"Transaction déjà '{tx.get('status')}' — action impossible.")

    typ = tx.get("type")
    direction = tx.get("direction")
    meta = tx.get("metadata") or {}
    uid = tx["user_id"]
    amt = float(tx.get("amount", 0) or 0)
    is_crypto = _tx_is_crypto(tx)

    # Amount actually credited/debited (already net of fees on our side).
    credit_amount = float(meta.get("amount_net", amt) or amt)

    if typ == "deposit":
        # Credit user's balance now.
        field = "balance_usdt" if is_crypto else "balance_xof"
        balance_applied = await _credit_wallet_once(
            uid, field, credit_amount, f"manual-approve:{tx_id}")

    changed = await db.transactions.update_one(
        {"id": tx_id, "status": "pending"}, {"$set": {
        "status": "completed",
        "approved_at": now_iso(),
        "approved_by": admin["username"],
        "manual_action": "approved",
        }})
    if not changed.modified_count and not balance_applied:
        return {"ok": True, "already_applied": True,
                "tx": await db.transactions.find_one({"id": tx_id}, {"_id": 0})}

    await audit(admin["id"], admin["username"], "tx_approve",
                target_user_id=uid, details={"type": typ, "amount": amt, "tx_id": tx_id})

    label = "dépôt" if typ == "deposit" else ("retrait" if direction == "out" else "transaction")
    unit = "USDT" if is_crypto else "XOF"
    await _notify_user(uid,
        f"Votre {label} a été validé",
        f"L'administrateur a validé votre {label} de {amt:.2f} {unit}.",
        kind="success",
        metadata={"tx_id": tx_id, "type": typ})

    return {"ok": True, "tx": await db.transactions.find_one({"id": tx_id}, {"_id": 0})}


class AdminRejectRequest(BaseModel):
    reason: Optional[str] = None
    confirmation: Optional[str] = None


@api.post("/admin/transactions/{tx_id}/reject")
async def admin_reject_transaction(tx_id: str, body: AdminRejectRequest,
                                     admin=Depends(get_admin),
                                     _recent_uid: str = Depends(require_admin_recent_auth)):
    """Manually reject a pending transaction.

    - Deposit → marks 'failed' (no balance side-effect; nothing was credited yet).
    - Withdrawal → refunds the user's balance with `total_debit` (falls back to
      amount + fee, then just amount).
    """
    require_admin_confirmation(body.confirmation)
    tx = await db.transactions.find_one({"id": tx_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction introuvable")
    if tx.get("status") != "pending":
        raise HTTPException(400, f"Transaction déjà '{tx.get('status')}' — action impossible.")

    typ = tx.get("type")
    direction = tx.get("direction")
    meta = tx.get("metadata") or {}
    uid = tx["user_id"]
    amt = float(tx.get("amount", 0) or 0)
    is_crypto = _tx_is_crypto(tx)

    refund_amount = 0.0
    if typ in ("withdrawal", "transfer") and direction == "out":
        refund_amount = float(
            meta.get("total_debit")
            or (amt + float(meta.get("fee", 0) or 0))
            or amt
        )
        field = "balance_usdt" if is_crypto else "balance_xof"
        refund_applied = await _refund_wallet_once(
            uid, field, refund_amount, f"manual-reject:{tx_id}")
    else:
        refund_applied = False

    changed = await db.transactions.update_one(
        {"id": tx_id, "status": "pending"}, {"$set": {
        "status": "failed",
        "rejected_at": now_iso(),
        "rejected_by": admin["username"],
        "manual_action": "rejected",
        "rejection_reason": body.reason,
        "refunded_amount": refund_amount if refund_amount > 0 else None,
        }})
    if not changed.modified_count and not refund_applied:
        return {"ok": True, "already_applied": True,
                "tx": await db.transactions.find_one({"id": tx_id}, {"_id": 0})}

    await audit(admin["id"], admin["username"], "tx_reject",
                target_user_id=uid, details={"type": typ, "reason": body.reason,
                                              "refunded": refund_amount, "tx_id": tx_id})

    label = "dépôt" if typ == "deposit" else ("retrait" if direction == "out" else "transaction")
    unit = "USDT" if is_crypto else "XOF"
    msg = f"L'administrateur a rejeté votre {label} de {amt:.2f} {unit}."
    if refund_amount > 0:
        msg += f" Votre solde a été recrédité de {refund_amount:.2f} {unit}."
    if body.reason:
        msg += f" Motif : {body.reason}"
    await _notify_user(uid,
        f"Votre {label} a été rejeté",
        msg,
        kind="warning",
        metadata={"tx_id": tx_id, "type": typ, "reason": body.reason})

    return {"ok": True, "refunded": refund_amount,
            "tx": await db.transactions.find_one({"id": tx_id}, {"_id": 0})}


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
        esc = _literal_regex_term(q, field_name="Recherche")
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
        esc = _literal_regex_term(q, field_name="Recherche")
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
    for doc in docs:
        if doc.get("role") == "admin" and not doc.get("admin_role"):
            doc["admin_role"] = "general"
    return docs


@api.post("/admin/admins")
async def admin_create_admin(
    req: AdminCreateRequest,
    admin=Depends(get_admin),
    _recent_uid: str = Depends(require_admin_recent_auth),
):
    if admin.get("role") != "super_admin":
        raise HTTPException(403, "Seul l'administrateur principal peut ajouter un admin")
    require_admin_confirmation(req.confirmation)
    username = req.username.strip().lower()
    email = req.email.strip().lower()
    if len(req.full_name.strip()) < 2 or len(username) < 3:
        raise HTTPException(422, "Nom et identifiant administrateur invalides")
    password_errors = auth_security.admin_password_policy_errors(req.password)
    if password_errors:
        raise HTTPException(
            422, "Mot de passe insuffisant : " + ", ".join(password_errors))
    if await db.users.find_one({"$or": [{"email": email}, {"username": username}]}):
        raise HTTPException(409, "Cet e-mail ou cet identifiant est déjà utilisé")

    user_doc = {
        "id": new_id(),
        "full_name": req.full_name.strip(),
        "username": username,
        "account_type": "merchant",
        "country": req.country.upper(),
        "phone": req.phone.strip(),
        "email": email,
        "password_hash": hash_password(req.password),
        "password_policy_version": 1,
        "kyc_status": "verified",
        "balance_xof": 0.0,
        "balance_xaf": 0.0,
        "balance_usdt": 0.0,
        "created_at": now_iso(),
        "two_fa_enabled": False,
        "language": "fr",
        "default_currency": "XOF",
        "role": "admin",
        "admin_role": req.admin_role,
        "is_blocked": False,
        "is_banned": False,
        "withdrawals_blocked": False,
    }
    await db.users.insert_one(user_doc)
    await _ensure_api_keys(user_doc["id"])
    await audit(
        admin["id"], admin["username"], "create_admin",
        target_user_id=user_doc["id"], target_username=username,
        details={"admin_role": req.admin_role},
    )
    return user_to_public(user_doc)


class AdminTransferConfigReq(BaseModel):
    mobile_money: Optional[dict] = None
    bank: Optional[dict] = None
    crypto: Optional[dict] = None


def _validate_withdrawal_catalog(section: dict) -> None:
    if not isinstance(section, dict):
        raise HTTPException(422, "mobile_money doit être un objet")
    operators = section.get("operators")
    if operators is None:
        return
    if not isinstance(operators, list):
        raise HTTPException(422, "Le catalogue Mobile Money doit être une liste")
    seen = set()
    valid_countries = set(paydunya.COUNTRY_LABELS)
    currencies = {"XOF", "XAF"}
    for op in operators:
        if not isinstance(op, dict):
            raise HTTPException(422, "Chaque opérateur doit être un objet")
        country = str(op.get("country") or "").upper()
        currency = str(op.get("currency") or "").upper()
        code = str(op.get("code") or "").strip()
        mode = str(op.get("withdraw_mode") or "").strip()
        if country not in valid_countries or currency not in currencies:
            raise HTTPException(422, "Pays ou devise Mobile Money invalide")
        if (country, code.lower()) in seen or not code:
            raise HTTPException(422, "Les opérateurs doivent avoir un couple pays/code unique")
        seen.add((country, code.lower()))
        expected_currency = "XAF" if country == "CM" else "XOF"
        if currency != expected_currency:
            raise HTTPException(422, "La devise ne correspond pas au pays")
        # A small set of pre-catalogue legacy operators (notably Wave Togo)
        # has no PayDunya disbursement mode.  Keep those rows editable for
        # migration, but they will fail explicitly if selected for payout.
        legacy_without_mode = not mode and (
            (country, code.lower()) in _LEGACY_WITHDRAW_MODES
            or (country, code.lower()) == ("TG", "wave"))
        executable = op.get("active", True) and not op.get("archived", False) \
            and not op.get("hidden", False)
        if executable and mode not in paydunya.WITHDRAWAL_MODES:
            raise HTTPException(422, "Mode de retrait PayDunya invalide")
        if executable and currency != "XOF":
            raise HTTPException(
                422, "PayDunya PUSH ne garantit actuellement que les retraits XOF")
        for key in ("fee_pct", "gateway_fee_pct", "gateway_fee_fixed",
                    "platform_fee_pct", "platform_fee_fixed", "min", "max"):
            if key in op and op[key] is not None:
                try:
                    value = float(op[key])
                except (TypeError, ValueError):
                    raise HTTPException(422, f"{key} doit être numérique")
                if value < 0:
                    raise HTTPException(422, f"{key} ne peut pas être négatif")
        if op.get("min") is not None and op.get("max") is not None:
            if float(op["max"]) < float(op["min"]):
                raise HTTPException(422, "La limite maximale doit être supérieure à la minimale")


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
    telegram_url: Optional[str] = None
    whatsapp_url: Optional[str] = None
    email: Optional[str] = None
    social_channels: Optional[dict] = None
    faqs: Optional[List[dict]] = None


@api.get("/admin/support/config")
async def admin_get_support_config(admin=Depends(get_admin)):
    return await get_support_config()


@api.patch("/admin/support/config")
async def admin_update_support_config(req: AdminSupportConfigReq, admin=Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if "social_channels" in updates:
        updates["social_channels"] = normalize_social_channels(updates["social_channels"])
    if "faqs" in updates:
        if len(updates["faqs"]) > 50:
            raise HTTPException(422, "50 questions fréquentes maximum")
        cleaned = []
        for faq in updates["faqs"]:
            question = str(faq.get("question") or "").strip()
            answer = str(faq.get("answer") or "").strip()
            if not question or not answer:
                raise HTTPException(422, "Chaque FAQ doit avoir une question et une réponse")
            cleaned.append({
                "id": str(faq.get("id") or new_id()),
                "question": question[:240],
                "answer": answer[:2000],
                "active": bool(faq.get("active", True)),
            })
        updates["faqs"] = cleaned
    if not updates:
        raise HTTPException(400, "Aucune modification")
    await db.settings.update_one({"id": "support_config"}, {"$set": updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_support_config", details=updates)
    return await get_support_config()


# ===== App feature toggles (Mobile Money / Crypto on-off) =====

@api.get("/settings/features")
async def public_get_features():
    """Public endpoint — used by the frontend to know which wallets and
    operations (deposit/withdrawal) are currently active."""
    f = await get_app_features()
    return {
        # Legacy fields kept for backwards compat.
        "mobile_money_enabled": bool(f.get("mobile_money_enabled", True)),
        "crypto_enabled": bool(f.get("crypto_enabled", True)),
        "mobile_money_coming_soon_message": f.get("mobile_money_coming_soon_message") or "",
        "crypto_coming_soon_message": f.get("crypto_coming_soon_message") or "",
        # Per-currency wallet visibility.
        "wallet_xof_enabled": bool(f.get("wallet_xof_enabled", True)),
        "wallet_xaf_enabled": bool(f.get("wallet_xaf_enabled", True)),
        "wallet_crypto_enabled": bool(f.get("wallet_crypto_enabled", True)),
        # Per-currency deposit / withdrawal switches.
        "deposit_xof_enabled": bool(f.get("deposit_xof_enabled", True)),
        "deposit_xaf_enabled": bool(f.get("deposit_xaf_enabled", True)),
        "deposit_crypto_enabled": bool(f.get("deposit_crypto_enabled", True)),
        "withdrawal_xof_enabled": bool(f.get("withdrawal_xof_enabled", True)),
        "withdrawal_xaf_enabled": bool(f.get("withdrawal_xaf_enabled", True)),
        "withdrawal_crypto_enabled": bool(f.get("withdrawal_crypto_enabled", True)),
        # Advanced modules.
        "api_enabled": bool(f.get("api_enabled", True)),
        "links_enabled": bool(f.get("links_enabled", True)),
    }


class AdminFeaturesReq(BaseModel):
    mobile_money_enabled: Optional[bool] = None
    crypto_enabled: Optional[bool] = None
    mobile_money_coming_soon_message: Optional[str] = None
    crypto_coming_soon_message: Optional[str] = None
    wallet_xof_enabled: Optional[bool] = None
    wallet_xaf_enabled: Optional[bool] = None
    wallet_crypto_enabled: Optional[bool] = None
    deposit_xof_enabled: Optional[bool] = None
    deposit_xaf_enabled: Optional[bool] = None
    deposit_crypto_enabled: Optional[bool] = None
    withdrawal_xof_enabled: Optional[bool] = None
    withdrawal_xaf_enabled: Optional[bool] = None
    withdrawal_crypto_enabled: Optional[bool] = None
    api_enabled: Optional[bool] = None
    links_enabled: Optional[bool] = None


@api.get("/admin/settings/features")
async def admin_get_features(admin=Depends(get_admin)):
    return await get_app_features()


@api.patch("/admin/settings/features")
async def admin_update_features(req: AdminFeaturesReq, admin=Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "Aucune modification")
    await db.settings.update_one({"id": "app_features"}, {"$set": updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_app_features", details=updates)
    return await get_app_features()


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
    for msg in msgs:
        msg["attachments"] = _sanitize_stored_attachments(msg.get("attachments"))
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
        "attachments": _validate_support_attachments(msg.attachments),
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
    if isinstance(updates.get("mobile_money"), dict):
        _validate_withdrawal_catalog(updates["mobile_money"])
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


# ---------- Admin: deposit fee/limit config (Mobile Money) ----------
class AdminDepositConfigReq(BaseModel):
    mobile_money: Optional[dict] = None
    crypto: Optional[dict] = None


@api.get("/admin/deposit/config")
async def admin_get_deposit_config(admin=Depends(get_admin)):
    return await get_deposit_config()


@api.patch("/admin/deposit/config")
async def admin_update_deposit_config(req: AdminDepositConfigReq,
                                       admin=Depends(get_admin)):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "Aucune modification")
    current = await get_deposit_config()
    dot_updates: dict = {}
    for section, patch in updates.items():
        cur_section = current.get(section) or {}
        if isinstance(patch, dict) and isinstance(cur_section, dict):
            for k, v in patch.items():
                dot_updates[f"{section}.{k}"] = v
        else:
            dot_updates[section] = patch
    await db.settings.update_one(
        {"id": "deposit_config"}, {"$set": dot_updates}, upsert=True)
    await audit(admin["id"], admin["username"], "update_deposit_config",
                details=updates)
    return await get_deposit_config()


class PayDunyaProviderUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[Literal["test", "live"]] = None
    store_name: Optional[str] = None
    modes: Optional[dict[str, dict[str, bool]]] = None
    catalog: Optional[list[dict]] = None
    master_key: Optional[str] = None
    public_key: Optional[str] = None
    private_key: Optional[str] = None
    token: Optional[str] = None
    clear_master_key: bool = False
    clear_public_key: bool = False
    clear_private_key: bool = False
    clear_token: bool = False


def _validate_paydunya_catalog(catalog: list[dict]) -> list[dict]:
    result = []
    seen = set()
    required = ("country", "code", "name", "currency", "endpoint_slug")
    for raw in catalog:
        op = dict(raw)
        if any(not str(op.get(k) or "").strip() for k in required):
            raise HTTPException(400, "Chaque opérateur doit renseigner pays, code, nom et endpoint")
        op["country"] = str(op["country"]).upper()
        op["code"] = str(op["code"]).lower()
        if op["country"] not in paydunya.COUNTRY_LABELS:
            raise HTTPException(400, "Pays PayDunya invalide")
        op["currency"] = str(op["currency"]).upper()
        if op["currency"] not in PAYDUNYA_WALLET_CURRENCIES:
            raise HTTPException(400, "Devise PayDunya non prise en charge")
        if op["code"] in seen:
            raise HTTPException(400, "Code opérateur PayDunya en double")
        seen.add(op["code"])
        op.setdefault("country_label", paydunya.COUNTRY_LABELS[op["country"]])
        op["active"] = bool(op.get("active", False))
        op["archived"] = bool(op.get("archived", False))
        op["hidden"] = bool(op.get("hidden", False))
        for key in ("fee_pct", "gateway_fee_pct", "gateway_fee_fixed", "platform_fee_pct",
                    "platform_fee_fixed", "min", "max"):
            try:
                op[key] = float(op.get(key, 0))
            except (TypeError, ValueError):
                raise HTTPException(400, f"Valeur invalide pour {key}")
            if op[key] < 0:
                raise HTTPException(400, f"Valeur négative interdite pour {key}")
        if op["max"] and op["max"] < op["min"]:
            raise HTTPException(400, "La limite maximum doit dépasser la minimum")
        result.append(op)
    return result


@api.get("/admin/payment-providers/paydunya")
async def admin_get_paydunya(admin=Depends(get_admin)):
    return _paydunya_public_config(await get_paydunya_config(), admin=True)


class MbiyoProviderUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[Literal["test", "live"]] = None
    catalog: Optional[list[dict]] = None
    public_key: Optional[str] = None
    secret_key: Optional[str] = None
    webhook_secret: Optional[str] = None
    clear_public_key: bool = False
    clear_secret_key: bool = False
    clear_webhook_secret: bool = False


def _validate_mbiyo_catalog(catalog: list[dict]) -> list[dict]:
    result, seen = [], set()
    for raw in catalog:
        op = dict(raw)
        country, code, network = (str(op.get(k) or "").upper()
                                  for k in ("country", "code", "network"))
        if country not in mbiyo.NETWORKS or network.lower() not in mbiyo.NETWORKS[country]:
            raise HTTPException(400, "Pays ou réseau Mbiyo invalide")
        if not code or code.lower() in seen:
            raise HTTPException(400, "Code opérateur Mbiyo en double ou vide")
        seen.add(code.lower())
        allowed_currencies = mbiyo.CURRENCIES[country]
        currency = str(op.get("currency") or allowed_currencies[0]).upper()
        if currency not in allowed_currencies:
            raise HTTPException(400, "La devise ne correspond pas au pays Mbiyo")
        op.update({"provider": "mbiyo", "country": country, "currency": currency,
                   "network": network.lower(), "code": code.lower(),
                   "country_label": mbiyo.COUNTRY_LABELS[country]})
        for key in ("fee_pct", "gateway_fee_pct", "gateway_fee_fixed",
                    "platform_fee_pct", "platform_fee_fixed", "min", "max"):
            try:
                op[key] = float(op.get(key, 0) or 0)
            except (TypeError, ValueError):
                raise HTTPException(400, f"Valeur Mbiyo invalide pour {key}")
            if op[key] < 0:
                raise HTTPException(400, f"{key} ne peut pas être négatif")
        op.setdefault("name", network.upper())
        op.setdefault("active", False)
        op.setdefault("archived", False)
        op.setdefault("hidden", False)
        result.append(op)
    return result


@api.get("/admin/payment-providers/mbiyo")
async def admin_get_mbiyo(admin=Depends(get_admin)):
    return _mbiyo_public_config(await get_mbiyo_config(), admin=True)


@api.put("/admin/payment-providers/mbiyo")
async def admin_update_mbiyo(req: MbiyoProviderUpdate, admin=Depends(get_admin)):
    current = await get_mbiyo_config()
    data = req.model_dump(exclude_none=True)
    updates, unset = {}, {}
    for key in ("enabled", "mode"):
        if key in data:
            updates[key] = data[key]
    if req.catalog is not None:
        updates["catalog"] = _validate_mbiyo_catalog(req.catalog)
    secret = os.environ.get("SESSION_SECRET", "")
    for key in ("public_key", "secret_key", "webhook_secret"):
        if data.get(f"clear_{key}"):
            unset[f"{key}_encrypted"] = ""
        elif data.get(key) and str(data[key]).strip():
            updates[f"{key}_encrypted"] = mbiyo.encrypt_secret(str(data[key]).strip(), secret)
    update_doc = {}
    if updates: update_doc["$set"] = updates
    if unset: update_doc["$unset"] = unset
    if update_doc:
        await db.settings.update_one({"id": "payment_provider_mbiyo"}, update_doc, upsert=True)
        await audit(admin["id"], admin["username"], "update_mbiyo_provider",
                    details=list(updates.keys()) + list(unset.keys()))
    return _mbiyo_public_config(await get_mbiyo_config(), admin=True)


@api.put("/admin/payment-providers/paydunya")
async def admin_update_paydunya(req: PayDunyaProviderUpdate,
                                admin=Depends(get_admin)):
    current = await get_paydunya_config()
    updates: dict = {}
    unset: dict = {}
    data = req.model_dump(exclude_none=True)
    for key in ("enabled", "mode", "store_name"):
        if key in data:
            updates[key] = data[key]
    if req.modes is not None:
        current_modes = current.get("modes")
        if not isinstance(current_modes, dict):
            current_modes = paydunya.default_modes()
        merged_modes = {
            name: dict(current_modes.get(name) or {"enabled": False})
            for name in paydunya.PAY_IN_MODES
        }
        for name, patch in req.modes.items():
            if name not in paydunya.PAY_IN_MODES:
                raise HTTPException(400, f"Mode PayDunya invalide : {name}")
            if not isinstance(patch, dict) or set(patch) - {"enabled"}:
                raise HTTPException(400, f"Configuration invalide pour le mode : {name}")
            if "enabled" in patch and not isinstance(patch["enabled"], bool):
                raise HTTPException(400, f"Le mode {name} doit être booléen")
            merged_modes[name]["enabled"] = bool(
                patch.get("enabled", merged_modes[name].get("enabled", False)))
        updates["modes"] = merged_modes
    if req.catalog is not None:
        updates["catalog"] = _validate_paydunya_catalog(req.catalog)
    session_secret = os.environ.get("SESSION_SECRET", "")
    for key in ("master_key", "public_key", "private_key", "token"):
        clear = bool(data.get(f"clear_{key}", False))
        value = data.get(key)
        # Empty strings intentionally preserve the old value.  Clearing is an
        # explicit, separate boolean to avoid accidental frontend clears.
        if clear:
            unset[f"{key}_encrypted"] = ""
        elif value is not None and str(value).strip():
            updates[f"{key}_encrypted"] = paydunya.encrypt_secret(
                str(value).strip(), session_secret)
    if not updates and not unset:
        return _paydunya_public_config(current, admin=True)
    update_doc = {}
    if updates:
        update_doc["$set"] = updates
    if unset:
        update_doc["$unset"] = unset
    await db.settings.update_one({"id": "payment_provider_paydunya"},
                                 update_doc, upsert=True)
    await audit(admin["id"], admin["username"], "update_paydunya_provider",
                details=list(updates.keys()) + list(unset.keys()))
    return _paydunya_public_config(await get_paydunya_config(), admin=True)


@api.get("/users/lookup")
async def lookup_user(q: str = Query(..., min_length=1, max_length=100),
                      uid: str = Depends(get_current_user_id)):
    needle = q.lower().strip()
    phone_regex = _literal_regex_term(needle, field_name="Recherche")
    recip = await db.users.find_one({
        "$or": [
            {"username": needle},
            {"email": needle},
            {"phone": {"$regex": phone_regex, "$options": "i"}},
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

# Production publishes use one HTTP process on port 5000. Serve the already
# built CRA assets from FastAPI so readiness does not depend on starting the
# CRA development compiler during VM startup. The development workflow still
# runs CRACO separately on port 5000.
FRONTEND_BUILD_DIR = ROOT_DIR.parent / "frontend" / "build"
app.mount(
    "/static",
    StaticFiles(directory=FRONTEND_BUILD_DIR / "static", check_dir=False),
    name="frontend-static",
)


@app.get("/{path:path}", include_in_schema=False)
async def frontend_fallback(path: str):
    if path == "api" or path.startswith("api/"):
        raise HTTPException(404, "Route introuvable")
    index_file = FRONTEND_BUILD_DIR / "index.html"
    if not index_file.is_file():
        return JSONResponse(
            status_code=200,
            content={"status": "ok", "message": "Frontend build not available"},
        )
    return FileResponse(index_file)


_configured_cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "").split(",")
    if origin.strip() and origin.strip() != "*"
]

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_configured_cors_origins,
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
        details = detail.details
    elif isinstance(detail, dict) and "message" in detail:
        code = detail.get("code") or _DEFAULT_ERROR_CODES.get(exc.status_code, "ERROR")
        message = str(detail["message"])
        details = detail.get("details")
    else:
        code = _DEFAULT_ERROR_CODES.get(exc.status_code, "ERROR")
        message = detail if isinstance(detail, str) else str(detail)
        details = None
    return _v1_error_response(exc.status_code, message, code,
                              headers=getattr(exc, "headers", None),
                              details=details)


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
    # Legacy /api/api-keys/* and /api/merchant/webhooks/* remain retired
    # (webhooks are no longer part of the Merchant API). The rewritten
    # Merchant API lives at /api/v1/* (crypto pay-in only) and merchant key
    # CRUD at /api/merchant/keys/*.
    p = request.url.path
    if (p.startswith("/api/api-keys/") or p == "/api/api-keys"
        or p.startswith("/api/merchant/webhooks")):
        return JSONResponse(status_code=410, content={
            "statusCode": 410,
            "message": "Webhooks are no longer part of the Biz-transPay API. Poll GET /v1/payments/{id} to fetch the current status.",
            "code": "MODULE_RETIRED",
        })
    is_v1 = _is_v1_path(p)
    is_admin = p == "/api/admin" or p.startswith("/api/admin/")
    if p.startswith("/api/") and _edge_ip_blocked(request):
        await _queue_security_telegram_alert(
            "edge_ip_blocked",
            request,
            outcome="Attaque bloquée. Cette requête n’a pas accédé à l’API.",
            solution=(
                "Conserver le blocage, examiner les tentatives associées et "
                "étendre la règle réseau seulement si plusieurs adresses liées apparaissent."
            ),
        )
        response = JSONResponse(
            status_code=403,
            content={
                "detail": {
                    "message": "Accès refusé.",
                    "code": "EDGE_IP_BLOCKED",
                }
            },
        )
        _apply_edge_security_headers(response, request)
        return response
    if p.startswith("/api/"):
        raw_length = request.headers.get("content-length")
        try:
            content_length = int(raw_length) if raw_length else 0
        except ValueError:
            content_length = 0
        max_bytes = (
            MAX_WEBHOOK_BYTES
            if p.startswith("/api/webhook") or p.startswith("/api/webhooks/")
            else MAX_REQUEST_BYTES
        )
        if content_length > max_bytes:
            await _queue_security_telegram_alert(
                "request_too_large",
                request,
                outcome="Tentative bloquée avant traitement du contenu.",
                solution=(
                    "Vérifier si la même source recommence. En cas de répétition, "
                    "bloquer le réseau source et contrôler les limites de taille."
                ),
            )
            response = JSONResponse(
                status_code=413,
                content={
                    "detail": {
                        "message": "Requête trop volumineuse.",
                        "code": "REQUEST_ENTITY_TOO_LARGE",
                        "max_bytes": max_bytes,
                    }
                },
            )
            _apply_edge_security_headers(response, request)
            return response
    csrf_failure = _validate_csrf_request(request)
    if csrf_failure:
        await _queue_security_telegram_alert(
            "csrf_rejected",
            request,
            outcome="Tentative bloquée. Aucune mutation protégée n’a été exécutée.",
            solution=(
                "Vérifier les sessions de l’utilisateur concerné et l’origine "
                "des requêtes. Révoquer les sessions si une activité inconnue apparaît."
            ),
        )
        _apply_edge_security_headers(csrf_failure, request)
        return csrf_failure
    if p.startswith("/api/") and request.method.upper() != "OPTIONS":
        profile = _global_rate_profile(p, request.method)
        identity = await _global_rate_identity(request)
        blocked = await _global_rate_consume(profile, identity)
        if blocked:
            await _queue_security_telegram_alert(
                "rate_limit_triggered",
                request,
                outcome="Trafic bloqué par la limitation de débit.",
                solution=(
                    "Surveiller la répétition pendant les prochaines minutes. "
                    "Si elle continue, bloquer la source et vérifier les comptes ou clés API ciblés."
                ),
                profile=profile,
                user_id=str(identity.get("user_id") or identity.get("merchant_id") or "platform"),
            )
            response = _global_rate_response(profile, blocked)
            _apply_edge_security_headers(response, request)
            return response
    start = datetime.now(timezone.utc)
    response = await call_next(request)
    _apply_edge_security_headers(response, request)
    if is_admin:
        await _record_admin_request(request, response.status_code)
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
    global _paydunya_reconcile_task
    await postgres_store.connect()
    try:
        await db.sessions.create_index("expires_at", expireAfterSeconds=0,
                                       name="sessions_ttl")
        await db.sessions.create_index(
            [("user_id", 1), ("id", 1)], name="sessions_user_id")
        await db.auth_rate_limits.create_index(
            "expires_at", expireAfterSeconds=0, name="auth_rate_limits_ttl")
        await db.auth_challenges.create_index(
            "expires_at", expireAfterSeconds=0, name="auth_challenges_ttl")
        await db.mfa_enrollments.create_index(
            "expires_at", expireAfterSeconds=0, name="mfa_enrollments_ttl")
    except Exception:
        logger.exception("Unable to initialize authentication security indexes")
    try:
        await db.webhook_events.create_index("event_id", unique=True)
    except Exception:
        pass
    if not _paydunya_reconcile_task or _paydunya_reconcile_task.done():
        _paydunya_reconcile_task = asyncio.create_task(
            _paydunya_reconcile_loop())
    try:
        # Idempotency-Key uniqueness per (user_id, key)
        await db.idempotency_keys.create_index(
            [("user_id", 1), ("key", 1)], unique=True)
        await db.momo_deposits.create_index(
            [("user_id", 1), ("idempotency_key", 1)],
            name="uniq_momo_deposit_idempotency",
            unique=True,
            partialFilterExpression={"idempotency_key": {"$type": "string"}})
    except Exception:
        pass
    try:
        await db.momo_deposits.create_index(
            "mbiyo_transaction_id",
            name="uniq_mbiyo_deposit_transaction",
            unique=True,
            partialFilterExpression={"mbiyo_transaction_id": {"$type": "string"}},
        )
    except Exception:
        logger.exception("Unable to initialize Mbiyo transaction uniqueness index")
    # This barrier is mandatory for financial requests. A partial index avoids
    # indexing historical transactions that do not carry an idempotency key.
    await db.transactions.create_index(
        [("user_id", 1), ("metadata.idempotency_key", 1)],
        name="uniq_mobile_withdrawal_idempotency",
        unique=True,
        partialFilterExpression={
            "metadata.idempotency_key": {"$type": "string"},
            "metadata.transfer_type": "biz_to_mobile",
        })
    await db.transactions.create_index(
        [("user_id", 1), ("metadata.operation_id", 1)],
        name="uniq_wallet_operation",
        unique=True,
        partialFilterExpression={
            "metadata.operation_id": {"$type": "string"},
        })


@app.on_event("shutdown")
async def shutdown_db_client():
    global _paydunya_reconcile_task
    if _paydunya_reconcile_task:
        _paydunya_reconcile_task.cancel()
        _paydunya_reconcile_task = None
    await postgres_store.close()
