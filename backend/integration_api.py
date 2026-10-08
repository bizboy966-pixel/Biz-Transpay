"""Biz-transPay integration API, isolated from legacy merchant API storage."""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import secrets
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Optional
from urllib.parse import urlsplit

import httpcore
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field
from pymongo.errors import DuplicateKeyError
from integration_mobile_money import burkina_guides, operator_catalog


ENDPOINTS = [
    {"method": "GET", "path": "/api/integration/v1/mobile-money/operators?direction=deposit|payout",
     "auth": "Authorization Bearer + X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les opérateurs Mobile Money activés et leurs instructions, séparément pour les dépôts et les retraits."},
    {"method": "GET", "path": "/api/integration/settings?environment=test|live",
     "auth": "Session Biz-transPay du marchand", "auth_type": "session",
     "purpose": "Consulter les paramètres d’intégration."},
    {"method": "POST", "path": "/api/integration/credentials",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Créer une paire de clés pour un environnement ; l’autorisation des retraits est accordée séparément."},
    {"method": "POST", "path": "/api/integration/credentials/{environment}/regenerate",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Renouveler la paire de clés ; la clé secrète n’est renvoyée qu’une fois."},
    {"method": "PATCH", "path": "/api/integration/credentials/{environment}",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Activer ou désactiver la paire de clés et autoriser explicitement les retraits."},
    {"method": "DELETE", "path": "/api/integration/credentials/{environment}",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Supprimer définitivement la paire de clés et la configuration webhook de cet environnement, sans supprimer l’historique financier."},
    {"method": "GET", "path": "/api/integration/webhooks/{environment}",
     "auth": "Session Biz-transPay du marchand", "auth_type": "session",
     "purpose": "Lister les destinations webhook de cet environnement."},
    {"method": "POST", "path": "/api/integration/webhooks/{environment}",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Ajouter une destination webhook indépendante avec son propre secret."},
    {"method": "PATCH", "path": "/api/integration/webhooks/{environment}/{webhook_id}",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Modifier le nom, l’URL ou l’état d’une destination webhook."},
    {"method": "DELETE", "path": "/api/integration/webhooks/{environment}/{webhook_id}",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Supprimer une destination webhook sans supprimer son historique."},
    {"method": "PUT", "path": "/api/integration/webhooks/{environment}",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Mettre à jour la destination principale historique (compatibilité)."},
    {"method": "POST", "path": "/api/integration/webhooks/{environment}/{webhook_id}/regenerate-secret",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Renouveler le secret d’une destination ; il n’est renvoyé qu’une fois."},
    {"method": "POST", "path": "/api/integration/webhooks/{environment}/regenerate-secret",
     "auth": "Session Biz-transPay du marchand (réauthentification récente)",
     "auth_type": "recent_session",
     "purpose": "Renouveler le secret du webhook ; il n’est renvoyé qu’une fois."},
    {"method": "POST", "path": "/api/integration/webhooks/{environment}/test",
     "auth": "Session Biz-transPay du marchand", "auth_type": "session",
     "purpose": "Envoyer un événement de test signé."},
    {"method": "GET", "path": "/api/integration/webhooks/{environment}/deliveries",
     "auth": "Session Biz-transPay du marchand", "auth_type": "session",
     "purpose": "Consulter les tentatives de livraison de toutes les destinations."},
    {"method": "POST", "path": "/api/integration/webhooks/{environment}/{webhook_id}/test",
     "auth": "Session Biz-transPay du marchand", "auth_type": "session",
     "purpose": "Envoyer un événement de test à une destination précise."},
    {"method": "GET", "path": "/api/integration/documentation",
     "auth": "Accès public", "auth_type": "public",
     "purpose": "Consulter la documentation destinée aux développeurs."},
    {"method": "GET", "path": "/api/integration/documentation.pdf",
     "auth": "Accès public", "auth_type": "public",
     "purpose": "Télécharger la documentation destinée aux développeurs."},
    {"method": "POST", "path": "/api/integration/v1/deposits",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lancer un dépôt Mobile Money en production ; les frais sont inclus dans le montant payé et déduits du crédit marchand."},
    {"method": "GET", "path": "/api/integration/v1/deposits/{deposit_id}",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Consulter un dépôt appartenant au propriétaire et à l’environnement des clés."},
    {"method": "GET", "path": "/api/integration/v1/deposits",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les dépôts de ce propriétaire et de cet environnement."},
    {"method": "POST", "path": "/api/integration/v1/payouts",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lancer un retrait Mobile Money en production après validation KYC et autorisation explicite ; les frais s’ajoutent au débit marchand sans réduire le montant reçu."},
    {"method": "GET", "path": "/api/integration/v1/payouts/{payout_id}",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Consulter un retrait appartenant au propriétaire et à l’environnement des clés."},
    {"method": "GET", "path": "/api/integration/v1/payouts",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les retraits de ce propriétaire et de cet environnement."},
    {"method": "GET", "path": "/api/integration/v1/exchanges/quote",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Obtenir une estimation de change."},
    {"method": "POST", "path": "/api/integration/v1/exchanges",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Effectuer une opération de change en production après validation KYC."},
    {"method": "GET", "path": "/api/integration/v1/exchanges/{exchange_id}",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Consulter une opération de change appartenant au propriétaire et à l’environnement des clés."},
    {"method": "GET", "path": "/api/integration/v1/exchanges",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les opérations de change de ce propriétaire et de cet environnement."},
    {"method": "POST", "path": "/api/integration/v1/links",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Créer un lien de paiement."},
    {"method": "GET", "path": "/api/integration/v1/links/{link_id}",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Consulter un lien appartenant au propriétaire et à l’environnement des clés."},
    {"method": "GET", "path": "/api/integration/v1/links",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les liens de ce propriétaire et de cet environnement."},
    {"method": "GET", "path": "/api/integration/v1/links/{link_id}/payments",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les paiements associés à un lien appartenant au propriétaire."},
    {"method": "GET", "path": "/api/integration/v1/transactions",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les opérations d’intégration de cet environnement."},
    {"method": "GET", "path": "/api/integration/v1/crypto/assets",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les actifs et réseaux crypto activés pour les dépôts ou les retraits."},
    {"method": "POST", "path": "/api/integration/v1/crypto/deposits",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Créer une adresse de dépôt crypto pour créditer le portefeuille réseau du marchand."},
    {"method": "GET", "path": "/api/integration/v1/crypto/deposits/{deposit_id}",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Consulter un dépôt crypto et son état de confirmation."},
    {"method": "GET", "path": "/api/integration/v1/crypto/deposits",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les dépôts crypto créés par cette intégration."},
    {"method": "POST", "path": "/api/integration/v1/crypto/payouts",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Envoyer une crypto sur le réseau choisi depuis le portefeuille réseau du marchand après validation KYC et autorisation explicite."},
    {"method": "GET", "path": "/api/integration/v1/crypto/payouts/{payout_id}",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Consulter le statut d’un retrait crypto."},
    {"method": "GET", "path": "/api/integration/v1/crypto/payouts",
     "auth": "Clé secrète Bearer et X-Public-Key", "auth_type": "bearer",
     "purpose": "Lister les retraits crypto créés par cette intégration."},
]

MAX_WEBHOOK_DESTINATIONS = 20


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connect to a vetted IP while httpcore retains the original TLS hostname."""

    def __init__(self, hostname: str, pinned_ip: str):
        self.hostname = hostname.lower().rstrip(".")
        self.pinned_ip = pinned_ip
        self.backend = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None,
                          socket_options=None):
        requested = host.decode() if isinstance(host, bytes) else str(host)
        if requested.lower().rstrip(".") != self.hostname:
            raise OSError("Webhook connection hostname changed")
        if not ipaddress.ip_address(self.pinned_ip).is_global:
            raise OSError("Webhook DNS answer is not public")
        return await self.backend.connect_tcp(
            self.pinned_ip, port, timeout=timeout,
            local_address=local_address, socket_options=socket_options)

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise OSError("Unix socket connections are disabled for webhooks")

    async def sleep(self, seconds):
        await self.backend.sleep(seconds)


def create_router(ctx: dict[str, Any]) -> APIRouter:
    db = ctx["db"]
    router = APIRouter()
    v1 = APIRouter(prefix="/v1")

    def now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def check_env(environment: str) -> str:
        if environment not in ("test", "live"):
            raise HTTPException(422, "environment must be test or live")
        return environment

    async def payment_api_is_enabled() -> bool:
        feature_loader = ctx.get("get_app_features")
        if not callable(feature_loader):
            return True
        features = await feature_loader()
        return bool(features.get("payment_api_enabled", True))

    async def require_payment_api_enabled() -> None:
        if not await payment_api_is_enabled():
            raise HTTPException(403, detail={
                "code": "PAYMENT_API_DISABLED",
                "message": "L’API de paiement est temporairement désactivée.",
            })

    def public_credential(doc: Optional[dict]) -> Optional[dict]:
        if not doc:
            return None
        return {
            "public_key": doc.get("public_key"),
            "public_key_masked": ctx["_mask"](doc.get("public_key", "")),
            "active": bool(doc.get("active")),
            "scopes": doc.get("scopes", []),
            "created_at": doc.get("created_at"),
        }

    async def browser_owner(uid: str = Depends(ctx["get_current_user_id"])) -> str:
        user = await db.users.find_one({"id": uid}, {"_id": 0, "account_type": 1})
        if not user or user.get("account_type") != "merchant":
            raise HTTPException(403, "API integration is reserved for business accounts")
        await require_payment_api_enabled()
        return uid

    async def recent_browser_owner(
        uid: str = Depends(browser_owner),
        recently_authenticated_uid: str = Depends(ctx["require_recent_auth"]),
    ) -> str:
        if uid != recently_authenticated_uid:
            raise HTTPException(403, "Reauthentication session mismatch")
        return uid

    async def authenticate(request: Request) -> dict:
        await require_payment_api_enabled()
        auth = request.headers.get("Authorization", "")
        public_key = request.headers.get("X-Public-Key", "").strip()
        if not auth.lower().startswith("bearer ") or not public_key:
            raise HTTPException(401, "Bearer secret and X-Public-Key are required")
        secret = auth.split(" ", 1)[1].strip()
        env_prefix = "test" if secret.startswith("sk_test_") else (
            "live" if secret.startswith("sk_live_") else None)
        pub_prefix = "test" if public_key.startswith("pk_test_") else (
            "live" if public_key.startswith("pk_live_") else None)
        if not env_prefix or env_prefix != pub_prefix:
            raise HTTPException(401, "Invalid or mismatched integration credentials")
        doc = await db.integration_credentials.find_one(
            {"public_key": public_key, "secret_hash": ctx["_hash_secret"](secret),
             "environment": env_prefix}, {"_id": 0})
        if not doc:
            raise HTTPException(401, "Invalid integration credentials")
        if not doc.get("active"):
            raise HTTPException(403, "Integration credentials are disabled")
        user = await db.users.find_one({"id": doc["user_id"]}, {"_id": 0})
        if (not user or user.get("is_banned") or user.get("is_blocked")
                or user.get("account_type") != "merchant"):
            raise HTTPException(403, "Business account inactive")
        doc["user"] = user
        await rate_limit(doc)
        await db.integration_credentials.update_one(
            {"id": doc["id"]}, {"$set": {"last_used_at": now()}})
        return doc

    def require_live(credential: dict) -> None:
        if credential["environment"] == "test":
            raise HTTPException(
                503,
                "Sandbox transactions are unavailable: no isolated official provider test environment is configured. No funds were moved.",
            )

    def require_scope(credential: dict, scope: str) -> None:
        if scope not in credential.get("scopes", []):
            raise HTTPException(403, detail={
                "code": "INTEGRATION_SCOPE_REQUIRED",
                "message": f"The {scope} scope is required.",
                "required_scope": scope,
            })

    def require_verified_kyc(credential: dict) -> None:
        ctx["_require_kyc_verified"](credential.get("user"))

    def public_crypto_deposit(doc: dict) -> dict:
        shown = {key: doc.get(key) for key in (
            "id", "status", "amount", "asset_code", "coin", "network",
            "credit_currency", "deposit_address", "memo", "memo_type",
            "amount_to_send", "expires_at", "fee_pct", "fee_fixed",
            "fee", "amount_net", "tx_hash",
            "created_at", "updated_at",
        )}
        shown["pending_manual"] = (
            doc.get("status") in {"creating", "provider_unknown"}
            and not doc.get("deposit_address"))
        return shown

    def public_crypto_payout(tx: dict) -> dict:
        metadata = tx.get("metadata") or {}
        return {
            "id": tx.get("id"), "status": tx.get("status"),
            "amount": metadata.get("amount_gross", tx.get("amount")),
            "asset_code": metadata.get("asset_code", tx.get("currency")),
            "coin": metadata.get("crypto"), "network": metadata.get("network"),
            "wallet_address": metadata.get("wallet_address", tx.get("counterparty")),
            "destination_memo": metadata.get("destination_memo"),
            "fee": metadata.get("fee"), "fee_bearer": metadata.get("fee_bearer"),
            "recipient_gets": metadata.get("recipient_gets"),
            "total_debit": metadata.get("total_debit"),
            "pending_manual": bool(metadata.get("manual_review_required")
                                   or metadata.get("provider_outcome_unknown")),
            "tx_hash": metadata.get("tx_hash"), "created_at": tx.get("created_at"),
        }

    async def crypto_features(direction: str) -> None:
        features = await ctx["get_app_features"]()
        if features.get("wallet_crypto_enabled") is False or features.get(
                "deposit_crypto_enabled" if direction == "deposit"
                else "withdrawal_crypto_enabled") is False:
            raise HTTPException(403, "Les opérations crypto sont désactivées")

    def require_crypto_precision(amount: float) -> None:
        # Both IziPay intent and payout handlers format the provider amount
        # with six decimal places. Reject values they would silently round.
        if Decimal(str(amount)).as_tuple().exponent < -6:
            raise HTTPException(400, "Montant crypto limité à 6 décimales")

    async def rate_limit(credential: dict) -> None:
        window = int(time.time() // 60)
        doc_id = hashlib.sha256(
            f"{credential['id']}:{window}".encode()).hexdigest()
        await db.integration_rate_limits.update_one(
            {"id": doc_id},
            {"$set": {
                "user_id": credential["user_id"],
                "credential_id": credential["id"],
                "window": window,
                "expires_at": datetime.fromtimestamp(
                    (window + 2) * 60, timezone.utc).isoformat(),
            }, "$inc": {"count": 1}},
            upsert=True,
        )
        hit = await db.integration_rate_limits.find_one({"id": doc_id}, {"_id": 0})
        if hit and int(hit.get("count", 0)) > 120:
            raise HTTPException(429, "Integration API rate limit exceeded")

    def require_idempotency(request: Request) -> str:
        key = (request.headers.get("Idempotency-Key") or "").strip()
        if not key or len(key) > 120:
            raise HTTPException(400, detail={
                "code": "IDEMPOTENCY_KEY_REQUIRED",
                "message": "A valid Idempotency-Key header is required.",
            })
        return key

    async def claim(credential: dict, key: str, action: str, payload: Any,
                    reference: Optional[str] = None) -> tuple[dict, bool]:
        uid, env = credential["user_id"], credential["environment"]
        fingerprint = hashlib.sha256(json.dumps(
            payload, sort_keys=True, separators=(",", ":"), default=str
        ).encode()).hexdigest()
        claim_id = hashlib.sha256(f"{uid}:{env}:{key}".encode()).hexdigest()
        existing = await db.integration_idempotency.find_one({"id": claim_id}, {"_id": 0})
        if existing:
            if existing.get("action") != action or existing.get("fingerprint") != fingerprint:
                raise HTTPException(409, "Idempotency-Key was used with a different request")
            if existing.get("response") is None:
                if await recover_claim(credential, existing):
                    return existing, True
                raise HTTPException(
                    409,
                    "Operation outcome is uncertain; it will not be resubmitted. "
                    "Retry later with the same Idempotency-Key.",
                )
            mapping = await db.integration_operations.find_one(
                {"id": f"{claim_id}:{action}"}, {"_id": 0})
            if not mapping:
                await recover_claim(credential, existing)
            return existing, True
        doc = {
            "id": claim_id, "user_id": uid, "environment": env,
            "action": action, "fingerprint": fingerprint, "response": None,
            "created_at": now(),
        }
        if reference is not None:
            doc["reference"] = reference
        try:
            await db.integration_idempotency.insert_one(doc)
        except DuplicateKeyError:
            existing = await db.integration_idempotency.find_one({"id": claim_id}, {"_id": 0})
            if existing:
                if existing.get("action") != action or existing.get("fingerprint") != fingerprint:
                    raise HTTPException(409, "Idempotency-Key was used with a different request")
                if existing.get("response") is not None:
                    mapping = await db.integration_operations.find_one(
                        {"id": f"{claim_id}:{action}"}, {"_id": 0})
                    if not mapping:
                        await recover_claim(credential, existing)
                    return existing, True
                if await recover_claim(credential, existing):
                    return existing, True
            raise HTTPException(
                409,
                "Operation outcome is uncertain; it will not be resubmitted. "
                "Retry later with the same Idempotency-Key.",
            )
        # A previous process may have completed the business operation before
        # losing the integration claim document. Recover it before invoking any
        # provider/business handler again.
        if await recover_claim(credential, doc):
            return doc, True
        return doc, False

    async def finish_claim(doc: dict, response: dict, kind: str, business_id: Optional[str],
                           status: str = "pending", reference: Optional[str] = None) -> None:
        if business_id:
            business = None
            if kind == "deposit":
                business = await db.momo_deposits.find_one(
                    {"id": str(business_id), "user_id": doc["user_id"]},
                    {"_id": 0, "status": 1})
            elif kind == "crypto_deposit":
                business = await db.crypto_deposits.find_one(
                    {"id": str(business_id), "user_id": doc["user_id"]},
                    {"_id": 0, "status": 1})
            elif kind in {"payout", "exchange", "crypto_payout"}:
                business = await db.transactions.find_one(
                    {"id": str(business_id), "user_id": doc["user_id"]},
                    {"_id": 0, "status": 1})
            if business and business.get("status"):
                status = str(business["status"]).lower()
                response["status"] = status
                if kind == "crypto_deposit":
                    response["deposit"]["status"] = status
                elif kind == "crypto_payout":
                    response["payout"]["status"] = status
        if business_id:
            operation = {
                "id": f"{doc['id']}:{kind}", "user_id": doc["user_id"],
                "environment": doc["environment"], "kind": kind,
                "business_id": str(business_id), "status": status,
                "reference": reference,
                "idempotency_id": doc["id"], "created_at": now(),
                "updated_at": now(),
            }
            try:
                await db.integration_operations.insert_one(operation)
            except DuplicateKeyError:
                # A concurrent recovery or an earlier process already persisted
                # this deterministic owner/environment mapping.
                await db.integration_operations.update_one(
                    {"id": operation["id"], "user_id": doc["user_id"],
                     "environment": doc["environment"]},
                    {"$set": {"business_id": str(business_id), "status": status,
                              "reference": reference, "updated_at": now()}},
                )
            if kind != "link":
                terminal = status in {"completed", "success", "paid", "approved"} or (
                    kind == "crypto_deposit" and status == "confirmed")
                failed = status in {"failed", "cancelled", "rejected", "expired"}
                event_kind = "payment" if kind == "deposit" else kind
                suffix = "success" if terminal else ("failed" if failed else "pending")
                await queue_event(
                    doc["user_id"], doc["environment"], f"{event_kind}.{suffix}",
                    {"id": str(business_id), "status": status},
                    f"{event_kind}:{business_id}:{status}")
                if kind == "deposit":
                    latest = await db.momo_deposits.find_one(
                        {"id": str(business_id), "user_id": doc["user_id"]},
                        {"_id": 0, "status": 1})
                elif kind == "crypto_deposit":
                    latest = await db.crypto_deposits.find_one(
                        {"id": str(business_id), "user_id": doc["user_id"]},
                        {"_id": 0, "status": 1})
                else:
                    latest = await db.transactions.find_one(
                        {"id": str(business_id), "user_id": doc["user_id"]},
                        {"_id": 0, "status": 1})
                if latest and latest.get("status") and str(
                        latest["status"]).lower() != status:
                    await integration_status_transition(
                        doc["user_id"], kind, str(business_id),
                        str(latest["status"]).lower())
        # The operation mapping and its initial outbox event precede the final
        # response marker. A crash at any earlier point is recoverable from the
        # business row and deterministic ordinary-handler key.
        await db.integration_idempotency.update_one(
            {"id": doc["id"]}, {"$set": {"response": response, "completed_at": now()}})
        doc["response"] = response

    async def recover_claim(credential: dict, claim_doc: dict) -> bool:
        uid, environment = claim_doc["user_id"], claim_doc["environment"]
        kind = claim_doc["action"]
        internal_key = f"btpi_{claim_doc['id'][:64]}"
        mapping = await db.integration_operations.find_one(
            {"id": f"{claim_doc['id']}:{kind}", "user_id": uid,
             "environment": environment}, {"_id": 0})
        business_id = mapping.get("business_id") if mapping else None
        business = None

        if kind == "deposit":
            business = await db.momo_deposits.find_one(
                {"user_id": uid, "idempotency_key": internal_key}, {"_id": 0})
            business_id = (business or {}).get("id") or business_id
        elif kind == "crypto_deposit":
            business = await db.crypto_deposits.find_one(
                {"user_id": uid, "idempotency_key": internal_key}, {"_id": 0})
            business_id = (business or {}).get("id") or business_id
            if not business and business_id:
                business = await db.crypto_deposits.find_one(
                    {"id": str(business_id), "user_id": uid}, {"_id": 0})
        elif kind == "payout":
            business = await db.transactions.find_one(
                {"user_id": uid, "metadata.idempotency_key": internal_key,
                 "metadata.transfer_type": "biz_to_mobile"}, {"_id": 0})
            business_id = (business or {}).get("id") or business_id
            if not business and business_id:
                business = await db.transactions.find_one(
                    {"id": str(business_id), "user_id": uid}, {"_id": 0})
        elif kind == "crypto_payout":
            business = await db.transactions.find_one(
                {"user_id": uid, "metadata.idempotency_key": internal_key,
                 "metadata.transfer_type": "biz_to_crypto"}, {"_id": 0})
            business_id = (business or {}).get("id") or business_id
            if not business and business_id:
                business = await db.transactions.find_one(
                    {"id": str(business_id), "user_id": uid}, {"_id": 0})
        elif kind == "exchange":
            operation_id = f"exchange:{uid}:{internal_key}"
            business = await db.transactions.find_one(
                {"user_id": uid, "metadata.operation_id": f"{operation_id}:out"},
                {"_id": 0})
            if not business:
                intent = await db.integration_exchange_intents.find_one(
                    {"id": f"{uid}:{internal_key}", "user_id": uid}, {"_id": 0})
                user = await db.users.find_one(
                    {"id": uid, "wallet_debit_operation_ids": operation_id,
                     "wallet_credit_operation_ids": operation_id},
                    {"_id": 0, "id": 1})
                if intent and user:
                    repair = ctx.get("_recover_integration_exchange")
                    if repair:
                        await repair(intent)
                        business = await db.transactions.find_one(
                            {"user_id": uid,
                             "metadata.operation_id": f"{operation_id}:out"},
                            {"_id": 0})
            business_id = (business or {}).get("id") or business_id
            if not business and business_id:
                business = await db.transactions.find_one(
                    {"id": str(business_id), "user_id": uid}, {"_id": 0})
        elif kind == "link":
            deterministic_link_id = uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"biz-transpay-integration-link:{uid}:{claim_doc['id']}",
            ).hex
            business = await db.payment_links.find_one(
                {"id": deterministic_link_id, "user_id": uid}, {"_id": 0})
            business_id = (business or {}).get("id") or business_id
        else:
            return False

        if not business or not business_id:
            return False
        status = str(business.get("status") or (
            "active" if kind == "link" else "pending")).lower()
        if kind == "deposit":
            public = ctx.get("_public_momo_deposit")
            shown = public(business) if public else business
            response = {"id": str(business_id), "status": status, "deposit": shown}
        elif kind == "crypto_deposit":
            response = {
                "id": str(business_id), "status": status,
                "deposit": public_crypto_deposit(business),
            }
        elif kind == "payout":
            metadata = business.get("metadata") or {}
            payout = {
                "transaction": business,
                "fee": metadata.get("fee", 0),
                "total_debit": metadata.get("total_debit", business.get("amount")),
                "recipient_gets": metadata.get("recipient_gets", business.get("amount")),
                "operator": metadata.get("operator_name"),
            }
            if metadata.get("manual_review_required"):
                payout["pending_manual"] = True
            response = {"id": str(business_id), "status": status, "payout": payout}
        elif kind == "crypto_payout":
            response = {
                "id": str(business_id), "status": status,
                "payout": public_crypto_payout(business),
            }
        elif kind == "exchange":
            metadata = business.get("metadata") or {}
            response = {
                "id": str(business_id), "status": status,
                "exchange": {
                    "received": metadata.get("received"),
                    "fee": metadata.get("fee"),
                    "rate": metadata.get("rate"),
                    "from_currency": metadata.get("from_currency"),
                    "to_currency": metadata.get("to_currency"),
                    "transaction": business,
                },
            }
        else:
            response = {"id": str(business_id), "status": "active", "link": business}
            status = "active"
        await finish_claim(
            claim_doc, response, kind, str(business_id), status,
            reference=(mapping or {}).get("reference") or claim_doc.get("reference"))
        return True

    async def deliver_event(uid: str, env: str, event_type: str, data: dict,
                            event_id: Optional[str] = None,
                            destination_id: Optional[str] = None) -> Optional[dict]:
        if not await payment_api_is_enabled():
            return {"event_id": event_id, "status": "disabled",
                    "error": "Payment API disabled"}
        query = {"user_id": uid, "environment": env, "active": True}
        if destination_id:
            query["id"] = destination_id
        destinations = await db.integration_webhooks.find(
            query, {"_id": 0}).sort("created_at", 1).to_list(
                MAX_WEBHOOK_DESTINATIONS)
        if not destinations:
            return {"event_id": event_id, "status": "unconfigured",
                    "error": "No active webhook configured"}

        event_id = event_id or secrets.token_urlsafe(18)
        legacy_default_id = f"{uid}:{env}"

        async def deliver_to_destination(wh: dict) -> dict:
            webhook_id = str(wh.get("id") or legacy_default_id)
            name = wh.get("name") or (
                "Site principal"
                if wh.get("is_default") or webhook_id == legacy_default_id
                else "Webhook")
            url = str(wh.get("url") or "")
            existing = await db.integration_webhook_deliveries.find_one({
                "event_id": event_id, "user_id": uid,
                "environment": env, "destination_id": webhook_id,
            }, {"_id": 0})
            if (existing is None
                    and (wh.get("is_default") or webhook_id == legacy_default_id)
                    and url):
                # Older deliveries did not have a destination_id; associate
                # those rows with the preserved default webhook.
                existing = await db.integration_webhook_deliveries.find_one({
                    "event_id": event_id, "user_id": uid,
                    "environment": env, "url": url,
                }, {"_id": 0})
            if existing and existing.get("status") == "delivered":
                return {
                    "id": existing.get("id"), "event_id": event_id,
                    "destination_id": webhook_id, "destination_name": name,
                    "status": "delivered", "status_code": existing.get("status_code"),
                    "error": None,
                }

            delivery_id = (existing or {}).get("id") or uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"biz-transpay-webhook:{event_id}:{webhook_id}",
            ).hex
            payload = (existing or {}).get("payload") or {
                "id": event_id, "type": event_type, "data": data,
                "created_at": now(),
            }
            previous_attempts = int((existing or {}).get("attempts", 0))
            delivery = {
                **(existing or {}),
                "id": delivery_id, "event_id": event_id,
                "user_id": uid, "environment": env,
                "destination_id": webhook_id, "destination_name": name,
                "event_type": event_type, "url": url, "payload": payload,
                "attempts": previous_attempts, "status": "pending",
                "created_at": (existing or {}).get("created_at") or now(),
            }
            if existing:
                await db.integration_webhook_deliveries.update_one(
                    {"id": delivery_id}, {"$set": delivery})
            else:
                await db.integration_webhook_deliveries.insert_one(delivery)

            error = None
            if not url or not wh.get("secret_encrypted"):
                error = "Webhook configuration is incomplete"
            parsed_url = urlsplit(url) if url else None
            hostname = (parsed_url.hostname or "").lower().rstrip(".") if parsed_url else ""
            if not error and not hostname:
                error = "Webhook URL has no hostname"
            secret = ctx["_decrypt"](wh["secret_encrypted"]) if not error else ""
            if not error and not secret:
                error = "Webhook signing secret is unavailable"

            status, code = "failed", None
            attempts_this_run = 0
            if not error:
                body = json.dumps(
                    payload, separators=(",", ":"), sort_keys=True, default=str)
                for attempt in range(3):
                    if not await payment_api_is_enabled():
                        status, error = "disabled", "Payment API disabled"
                        break
                    attempts_this_run += 1
                    timestamp = str(int(time.time()))
                    signature = "sha256=" + hmac.new(
                        secret.encode(), f"{timestamp}.{body}".encode(),
                        hashlib.sha256,
                    ).hexdigest()
                    await db.integration_webhook_deliveries.update_one(
                        {"id": delivery_id}, {"$set": {
                            "status": "delivering",
                            "attempts": previous_attempts + attempts_this_run,
                            "last_attempt_at": now(),
                        }})
                    try:
                        addresses = await ctx["_resolve_safe_outbound_http_ips"](url)
                        if (not addresses
                                or any(not ipaddress.ip_address(address).is_global
                                       for address in addresses)):
                            error = "Unsafe or private DNS answer"
                            break
                        pinned_ip = addresses[attempt % len(addresses)]
                        transport = httpx.AsyncHTTPTransport(
                            retries=0, trust_env=False)
                        transport._pool._network_backend = _PinnedNetworkBackend(
                            hostname, pinned_ip)
                        async with httpx.AsyncClient(
                                timeout=8, follow_redirects=False, trust_env=False,
                                transport=transport) as client:
                            resp = await client.post(url, content=body, headers={
                                "Content-Type": "application/json",
                                "X-BizTransPay-Timestamp": timestamp,
                                "X-BizTransPay-Signature": signature,
                                "X-BizTransPay-Event-Id": event_id,
                                "X-BizTransPay-Event-Type": event_type,
                            })
                        code = resp.status_code
                        if 200 <= code < 300:
                            status, error = "delivered", None
                            break
                        error = f"HTTP {code}"
                    except Exception as exc:  # persist failures without leaking details
                        error = type(exc).__name__
                    if attempt < 2:
                        await asyncio.sleep(0.2 * (attempt + 1))

            await db.integration_webhook_deliveries.update_one(
                {"id": delivery_id}, {"$set": {
                    "status": status, "status_code": code, "error": error,
                    "attempts": previous_attempts + attempts_this_run,
                    "completed_at": now(),
                }})
            return {
                "id": delivery_id, "event_id": event_id,
                "destination_id": webhook_id, "destination_name": name,
                "status": status, "status_code": code, "error": error,
            }

        results = await asyncio.gather(
            *(deliver_to_destination(wh) for wh in destinations))
        statuses = {result["status"] for result in results}
        status = (
            "disabled" if "disabled" in statuses
            else "failed" if "failed" in statuses
            else "delivered"
        )
        failures = [result for result in results if result["status"] == "failed"]
        return {
            "id": next((result.get("id") for result in results if result.get("id")), None),
            "event_id": event_id, "status": status,
            "delivery_ids": [result.get("id") for result in results if result.get("id")],
            "deliveries": results,
            "error": failures[0].get("error") if failures else (
                "Payment API disabled" if status == "disabled" else None),
        }

    async def emit_transition(operation: dict, status: str) -> None:
        if status == operation.get("status"):
            return
        await queue_operation_event(operation, status)
        await db.integration_operations.update_one(
            {"id": operation["id"], "status": operation.get("status")},
            {"$set": {"status": status, "updated_at": now()}})

    async def queue_operation_event(operation: dict, status: str) -> None:
        terminal = status in {"completed", "success", "paid", "approved"} or (
            operation["kind"] == "crypto_deposit" and status == "confirmed")
        failed = status in {"failed", "cancelled", "rejected", "expired"}
        suffix = "success" if terminal else ("failed" if failed else "pending")
        event_kind = "payment" if operation["kind"] == "deposit" else operation["kind"]
        await queue_event(
            operation["user_id"], operation["environment"],
            f"{event_kind}.{suffix}",
            {"id": operation["business_id"], "status": status},
            f"{event_kind}:{operation['business_id']}:{status}")

    async def emit_link_payment_transition(credential: dict, payment: dict) -> None:
        status = str(payment.get("status") or "pending").lower()
        success = status in {"completed", "success", "paid", "approved"}
        failed = status in {"failed", "cancelled", "rejected", "expired"}
        suffix = "success" if success else ("failed" if failed else "pending")
        await queue_event(
            credential["user_id"], credential["environment"], f"payment.{suffix}",
            {"id": payment.get("id"), "link_id": payment.get("link_id"), "status": status},
            f"payment:{payment.get('id')}:{status}")

    async def queue_event(uid: str, env: str, event_type: str, data: dict,
                          dedupe_key: str) -> None:
        if not await payment_api_is_enabled():
            return
        event_id = hashlib.sha256(
            f"{uid}:{env}:{event_type}:{dedupe_key}".encode()).hexdigest()
        try:
            await db.integration_webhook_events.insert_one({
                "id": event_id, "user_id": uid, "environment": env,
                "event_type": event_type, "data": data, "dedupe_key": dedupe_key,
                "status": "queued", "attempts": 0, "created_at": now(),
            })
        except DuplicateKeyError:
            return

    async def cleanup_rate_limit_records() -> None:
        await db.integration_rate_limits.delete_many({
            "$or": [
                {"expires_at": {"$lte": now()}},
                {"expires_at": {"$exists": False}},
            ],
        })

    async def process_event(event: dict) -> None:
        if not await payment_api_is_enabled():
            await db.integration_webhook_events.update_one(
                {"id": event["id"], "$or": [
                    {"status": "queued"},
                    {"status": "waiting_webhook"},
                    {"status": "failed"},
                    {"status": "processing"},
                ]},
                {"$set": {
                    "status": "disabled", "last_error": "Payment API disabled",
                    "next_retry_at": None, "completed_at": now(),
                }})
            return
        attempts_before = int(event.get("attempts", 0))
        stale_iso = datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() - 120,
            timezone.utc).isoformat()
        if (event.get("status") == "processing" and attempts_before >= 5
                and event.get("processing_at", "") <= stale_iso):
            await db.integration_webhook_events.update_one(
                {"id": event["id"], "status": "processing",
                 "processing_at": {"$lte": stale_iso}},
                {"$set": {"status": "failed", "last_error": "retry limit reached",
                          "completed_at": now()}})
            return
        claimed = await db.integration_webhook_events.update_one(
            {"id": event["id"], "$or": [
                {"status": "queued"},
                {"status": "waiting_webhook",
                 "next_retry_at": {"$lte": now()}},
                {"status": "failed", "next_retry_at": {"$lte": now()},
                 "attempts": {"$lt": 5}},
                {"status": "processing", "processing_at": {"$lte": stale_iso},
                 "attempts": {"$lt": 5}},
            ]},
            {"$set": {"status": "processing", "processing_at": now()},
             "$inc": {"attempts": 1}})
        if not claimed.modified_count:
            return
        claimed_event = await db.integration_webhook_events.find_one(
            {"id": event["id"]}, {"_id": 0})
        attempts = int((claimed_event or {}).get("attempts", attempts_before + 1))
        result = await deliver_event(
            event["user_id"], event["environment"], event["event_type"],
            event["data"], event_id=event["id"])
        result_status = (result or {}).get("status", "skipped")
        if result_status == "unconfigured":
            event_status = "waiting_webhook"
            retry_at = datetime.fromtimestamp(
                datetime.now(timezone.utc).timestamp() + 60,
                timezone.utc).isoformat()
            attempts = attempts_before
        elif result_status == "failed" and attempts < 5:
            retry_delay = min(300, 5 * (2 ** (attempts - 1)))
            event_status = "failed"
            retry_at = datetime.fromtimestamp(
                datetime.now(timezone.utc).timestamp() + retry_delay,
                timezone.utc).isoformat()
        else:
            event_status = result_status
            retry_at = None
        await db.integration_webhook_events.update_one(
            {"id": event["id"], "status": "processing"},
            {"$set": {"status": event_status,
                      "delivery_id": (result or {}).get("id"),
                      "attempts": attempts,
                      "next_retry_at": retry_at,
                      "last_error": (result or {}).get("error"),
                      "completed_at": (
                          now() if event_status not in {"failed", "waiting_webhook"}
                          else None)}})

    async def iter_collection_batches(collection, query: dict,
                                      batch_size: int = 200):
        offset = 0
        while True:
            batch = await collection.find(query, {"_id": 0}).sort(
                "id", 1).skip(offset).limit(batch_size).to_list(batch_size)
            if not batch:
                break
            yield batch
            offset += len(batch)
            if len(batch) < batch_size:
                break

    async def reconcile_pending_operations() -> None:
        # Page the full durable mappings by immutable ID, rather than taking a
        # newest-N snapshot: older orphaned terminal rows must eventually heal.
        async for operations in iter_collection_batches(
                db.integration_operations, {}):
            for operation in operations:
                if operation.get("kind") == "link":
                    continue
                if operation["kind"] == "deposit":
                    actual = await db.momo_deposits.find_one({
                        "id": operation["business_id"],
                        "user_id": operation["user_id"],
                    }, {"_id": 0, "status": 1})
                elif operation["kind"] == "crypto_deposit":
                    actual = await db.crypto_deposits.find_one({
                        "id": operation["business_id"],
                        "user_id": operation["user_id"],
                    }, {"_id": 0, "status": 1})
                else:
                    actual = await db.transactions.find_one({
                        "id": operation["business_id"],
                        "user_id": operation["user_id"],
                    }, {"_id": 0, "status": 1})
                if not actual or not actual.get("status"):
                    continue
                status = str(actual["status"]).lower()
                if status == operation.get("status"):
                    await queue_operation_event(operation, status)
                else:
                    await emit_transition(operation, status)

        payment_query = {
            "status": {"$in": ["pending", "paid", "failed", "expired",
                               "cancelled", "rejected"]},
        }
        async for payments in iter_collection_batches(
                db.link_payments, payment_query):
            link_ids = sorted({
                str(payment.get("link_id")) for payment in payments
                if payment.get("link_id")
            })
            operations_by_link: dict[str, list[dict]] = {}
            if link_ids:
                async for link_operation_batch in iter_collection_batches(
                        db.integration_operations, {
                            "kind": "link", "business_id": {"$in": link_ids},
                        }):
                    for operation in link_operation_batch:
                        operations_by_link.setdefault(
                            str(operation["business_id"]), []).append(operation)
            for payment in payments:
                for operation in operations_by_link.get(
                        str(payment.get("link_id")), []):
                    await emit_link_payment_transition({
                        "user_id": operation["user_id"],
                        "environment": operation["environment"],
                    }, payment)

    async def outbox_worker() -> None:
        last_cleanup = 0.0
        last_reconcile = 0.0
        while True:
            try:
                current_time = time.time()
                if current_time - last_cleanup >= 60:
                    await cleanup_rate_limit_records()
                    last_cleanup = current_time
                stale_before = (
                    datetime.now(timezone.utc).timestamp() - 120)
                stale_iso = datetime.fromtimestamp(
                    stale_before, timezone.utc).isoformat()
                now_iso = now()
                events = await db.integration_webhook_events.find({
                    "$or": [
                        {"status": "queued"},
                        {"status": "waiting_webhook",
                         "next_retry_at": {"$lte": now_iso}},
                        {"status": "processing", "processing_at": {"$lte": stale_iso}},
                        {"status": "failed", "next_retry_at": {"$lte": now_iso},
                         "attempts": {"$lt": 5}},
                    ],
                }, {"_id": 0}).sort("created_at", 1).to_list(50)
                for event in events:
                    await process_event(event)
                if current_time - last_reconcile >= 5:
                    await reconcile_pending_operations()
                    last_reconcile = current_time
            except asyncio.CancelledError:
                raise
            except Exception:
                # Outbox events remain durable and will be retried on the next
                # worker pass; transaction reconciliation must never depend on
                # outbound webhook availability.
                pass
            await asyncio.sleep(1)

    async def integration_status_transition(uid: str, kind: str, business_id: str,
                                            status: str) -> None:
        ops = await db.integration_operations.find({
            "user_id": uid, "kind": kind, "business_id": str(business_id),
        }, {"_id": 0}).to_list(20)
        for operation in ops:
            await emit_transition(operation, status)

    async def integration_link_payment_transition(uid: str, link_id: str,
                                                  payment_id: str, status: str) -> None:
        link_ops = await db.integration_operations.find({
            "user_id": uid, "kind": "link", "business_id": str(link_id),
        }, {"_id": 0}).to_list(20)
        for operation in link_ops:
            credential = {
                "user_id": uid, "environment": operation["environment"],
            }
            await emit_link_payment_transition(credential, {
                "id": payment_id, "link_id": link_id, "status": status,
            })

    ctx["_integration_status_transition"] = integration_status_transition
    ctx["_integration_link_payment_transition"] = integration_link_payment_transition
    ctx["_integration_outbox_worker"] = outbox_worker
    ctx["_integration_deliver_event"] = deliver_event
    ctx["_integration_process_event"] = process_event
    ctx["_integration_reconcile_pending"] = reconcile_pending_operations
    ctx["_integration_cleanup_rate_limits"] = cleanup_rate_limit_records

    async def lookup_operation(credential: dict, kind: str, business_id: str) -> dict:
        op = await db.integration_operations.find_one({
            "user_id": credential["user_id"], "environment": credential["environment"],
            "kind": kind, "business_id": business_id,
        }, {"_id": 0})
        if not op:
            raise HTTPException(404, "Operation not found")
        return op

    async def list_operations(credential: dict, kind: str, limit: int) -> list[dict]:
        return await db.integration_operations.find({
            "user_id": credential["user_id"], "environment": credential["environment"],
            "kind": kind,
        }, {"_id": 0}).sort("created_at", -1).to_list(limit)

    class EnvironmentBody(BaseModel):
        environment: Literal["test", "live"]
        payout_opt_in: bool = False

    class ActiveBody(BaseModel):
        active: bool
        payout_opt_in: Optional[bool] = None

    class DeleteCredentialBody(BaseModel):
        confirmation: Literal["SUPPRIMER"]

    class WebhookBody(BaseModel):
        url: str = Field(..., min_length=8, max_length=2048)
        active: bool = True

    class WebhookCreateBody(BaseModel):
        name: str = Field(..., min_length=1, max_length=80)
        url: str = Field(..., min_length=8, max_length=2048)
        active: bool = True

    class WebhookUpdateBody(BaseModel):
        name: Optional[str] = Field(None, min_length=1, max_length=80)
        url: Optional[str] = Field(None, min_length=8, max_length=2048)
        active: Optional[bool] = None

    class DepositBody(BaseModel):
        amount: float = Field(..., gt=0)
        currency: str
        country: str
        operator: str
        phone_number: str
        email: str
        full_name: str
        reference: Optional[str] = None
        description: Optional[str] = None
        otp: Optional[str] = None
        fee_bearer: Literal["sender", "receiver", "client", "merchant"] = "client"

    class PayoutBody(BaseModel):
        amount: float = Field(..., gt=0)
        currency: str
        country: str
        operator: str
        recipient: str
        reference: Optional[str] = None
        description: Optional[str] = None
        fee_bearer: Literal["sender", "receiver"] = "sender"

    class CryptoDepositBody(BaseModel):
        amount: float = Field(..., gt=0, allow_inf_nan=False)
        asset_code: str = Field(..., min_length=3, max_length=32)
        full_name: str = Field(..., min_length=1, max_length=120)
        email: EmailStr
        refund_address: str = Field(..., min_length=1, max_length=200)
        reference: Optional[str] = Field(None, max_length=120)

    class CryptoPayoutBody(BaseModel):
        amount: float = Field(..., gt=0, allow_inf_nan=False)
        asset_code: str = Field(..., min_length=3, max_length=32)
        wallet_address: str = Field(..., min_length=1, max_length=200)
        destination_memo: Optional[str] = Field(None, max_length=120)
        fee_bearer: Literal["sender", "receiver"] = "sender"
        reference: Optional[str] = Field(None, max_length=120)
        description: Optional[str] = Field(None, max_length=500)

    class ExchangeBody(BaseModel):
        from_currency: str
        to_currency: str
        amount: float = Field(..., gt=0)

    class LinkBody(BaseModel):
        title: str = Field(..., min_length=1, max_length=120)
        amount: float = 0
        currency: Literal["XOF", "XAF", "USDT", "UNIVERSAL"] = "UNIVERSAL"
        description: Optional[str] = ""
        expires_at: Optional[str] = None
        single_use: bool = False
        amount_type: Literal["fixed", "free"] = "fixed"
        min_amount: Optional[float] = None
        max_amount: Optional[float] = None
        fee_bearer: Literal["customer", "owner"] = "customer"

    @router.get("/settings")
    async def integration_settings(environment: Literal["test", "live"] = Query(...),
                                   uid: str = Depends(browser_owner)):
        key = await db.integration_credentials.find_one(
            {"user_id": uid, "environment": environment}, {"_id": 0})
        webhook = await db.integration_webhooks.find_one(
            {"id": f"{uid}:{environment}", "user_id": uid,
             "environment": environment}, {"_id": 0})
        return {
            "environment": environment, "credentials": public_credential(key),
            "available": environment == "live",
            "message": (
                "Les opérations financières Sandbox sont indisponibles sans environnement "
                "de test officiel isolé ; aucun fonds réel ne sera déplacé."
                if environment == "test" else None
            ),
            "webhook": ({
                "url": webhook.get("url"), "active": bool(webhook.get("active")),
                "secret_configured": bool(webhook.get("secret_encrypted")),
            } if webhook else None),
            "warning": "Secrets are displayed only once when generated.",
        }

    async def issue_credentials(uid: str, env: str, force: bool = False,
                                payout_opt_in: Optional[bool] = None) -> dict:
        check_env(env)
        existing = await db.integration_credentials.find_one(
            {"user_id": uid, "environment": env}, {"_id": 0})
        if existing and existing.get("active") and not force:
            return {"credentials": public_credential(existing), "secret_key": None,
                    "secret_returned_once": False}
        if payout_opt_in is None:
            payout_opt_in = bool(existing and existing.get("payout_opt_in"))
        payout_opt_in = env == "live" and payout_opt_in
        scopes = ["deposits:write", "exchanges:write", "links:write",
                  "transactions:read"]
        if payout_opt_in:
            scopes.append("payouts:write")
        pub = f"pk_{env}_{secrets.token_urlsafe(24)}"
        sec = f"sk_{env}_{secrets.token_urlsafe(32)}"
        doc = {
            "id": f"{uid}:{env}", "user_id": uid, "environment": env,
            "public_key": pub, "secret_hash": ctx["_hash_secret"](sec),
            "active": True,
            "scopes": scopes, "payout_opt_in": payout_opt_in, "created_at": now(),
        }
        await db.integration_credentials.replace_one(
            {"user_id": uid, "environment": env}, doc, upsert=True)
        return {"credentials": public_credential(doc), "secret_key": sec,
                "secret_returned_once": True}

    @router.post("/credentials")
    async def create_credentials(body: EnvironmentBody,
                                 uid: str = Depends(recent_browser_owner)):
        return await issue_credentials(
            uid, body.environment, payout_opt_in=body.payout_opt_in)

    @router.post("/credentials/{environment}/regenerate")
    async def regenerate_credentials(environment: str, uid: str = Depends(recent_browser_owner)):
        return await issue_credentials(uid, check_env(environment), force=True)

    @router.patch("/credentials/{environment}")
    async def set_credentials_active(environment: str, body: ActiveBody,
                                     uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        fields = {"active": body.active}
        if body.payout_opt_in is not None:
            credential = await db.integration_credentials.find_one(
                {"user_id": uid, "environment": env}, {"_id": 0})
            if not credential:
                raise HTTPException(404, "Integration credentials not found")
            scopes = list(credential.get("scopes", []))
            if body.payout_opt_in and env == "live":
                if "payouts:write" not in scopes:
                    scopes.append("payouts:write")
            else:
                scopes = [scope for scope in scopes if scope != "payouts:write"]
            fields["scopes"] = scopes
            fields["payout_opt_in"] = env == "live" and body.payout_opt_in
        result = await db.integration_credentials.update_one(
            {"user_id": uid, "environment": env}, {"$set": fields})
        if not result.matched_count:
            raise HTTPException(404, "Integration credentials not found")
        return {"environment": env, "active": body.active}

    @router.delete("/credentials/{environment}")
    async def delete_credentials(environment: str, body: DeleteCredentialBody,
                                 uid: str = Depends(recent_browser_owner)):
        """Revoke one environment's keys and webhook without removing financial history."""
        env = check_env(environment)
        async with ctx["postgres_store"].pool.acquire() as conn:
            async with conn.transaction():
                removed = await conn.fetch(
                    """DELETE FROM document_store
                       WHERE collection = 'integration_credentials'
                         AND document->>'user_id' = $1
                         AND document->>'environment' = $2
                       RETURNING doc_id""", uid, env,
                )
                if not removed:
                    raise HTTPException(404, "Integration credentials not found")
                await conn.execute(
                    """DELETE FROM document_store
                       WHERE collection = 'integration_webhooks'
                         AND document->>'user_id' = $1
                         AND document->>'environment' = $2""", uid, env,
                )
        return {"environment": env, "deleted": True}

    def public_webhook(doc: dict, uid: str, env: str) -> dict:
        webhook_id = str(doc.get("id") or f"{uid}:{env}")
        return {
            "id": webhook_id,
            "name": doc.get("name") or (
                "Site principal"
                if doc.get("is_default") or webhook_id == f"{uid}:{env}"
                else "Webhook"),
            "url": doc.get("url", ""),
            "active": bool(doc.get("active")),
            "secret_configured": bool(doc.get("secret_encrypted")),
            "is_default": bool(
                doc.get("is_default") or webhook_id == f"{uid}:{env}"),
            "created_at": doc.get("created_at"),
            "updated_at": doc.get("updated_at"),
        }

    @router.get("/webhooks/{environment}")
    async def list_webhooks(environment: str, uid: str = Depends(browser_owner)):
        env = check_env(environment)
        docs = await db.integration_webhooks.find(
            {"user_id": uid, "environment": env}, {"_id": 0}
        ).sort("created_at", 1).to_list(MAX_WEBHOOK_DESTINATIONS)
        return {
            "environment": env,
            "webhooks": [public_webhook(doc, uid, env) for doc in docs],
        }

    @router.post("/webhooks/{environment}")
    async def create_webhook(environment: str, body: WebhookCreateBody,
                             uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        name = body.name.strip()
        if not name:
            raise HTTPException(422, "Webhook name cannot be empty")
        existing = await db.integration_webhooks.find(
            {"user_id": uid, "environment": env}, {"_id": 0}
        ).to_list(MAX_WEBHOOK_DESTINATIONS)
        if len(existing) >= MAX_WEBHOOK_DESTINATIONS:
            raise HTTPException(409, "Webhook destination limit reached")
        url = await ctx["_validate_outbound_http_url"](body.url, "Webhook URL")
        secret = "whsec_" + secrets.token_urlsafe(32)
        doc = {
            "id": "wh_" + secrets.token_urlsafe(18),
            "user_id": uid, "environment": env, "name": name,
            "url": url, "active": body.active, "is_default": False,
            "secret_encrypted": ctx["_encrypt"](secret),
            "created_at": now(), "updated_at": now(),
        }
        await db.integration_webhooks.insert_one(doc)
        return {
            "environment": env, "webhook": public_webhook(doc, uid, env),
            "webhook_secret": secret, "secret_returned_once": True,
        }

    @router.patch("/webhooks/{environment}/{webhook_id}")
    async def update_webhook(environment: str, webhook_id: str,
                             body: WebhookUpdateBody,
                             uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        old = await db.integration_webhooks.find_one({
            "id": webhook_id, "user_id": uid, "environment": env,
        }, {"_id": 0})
        if not old:
            raise HTTPException(404, "Webhook configuration not found")
        updates = body.model_dump(exclude_unset=True)
        updates = {key: value for key, value in updates.items() if value is not None}
        if "name" in updates:
            updates["name"] = updates["name"].strip()
            if not updates["name"]:
                raise HTTPException(422, "Webhook name cannot be empty")
        if "url" in updates:
            updates["url"] = await ctx["_validate_outbound_http_url"](
                updates["url"], "Webhook URL")
        if not updates:
            raise HTTPException(400, "Aucune modification")
        updates["updated_at"] = now()
        await db.integration_webhooks.update_one(
            {"id": webhook_id, "user_id": uid, "environment": env},
            {"$set": updates})
        return {
            "environment": env,
            "webhook": public_webhook({**old, **updates}, uid, env),
        }

    @router.delete("/webhooks/{environment}/{webhook_id}")
    async def delete_webhook(environment: str, webhook_id: str,
                             uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        result = await db.integration_webhooks.delete_many({
            "id": webhook_id, "user_id": uid, "environment": env,
        })
        if not result.deleted_count:
            raise HTTPException(404, "Webhook configuration not found")
        return {"environment": env, "webhook_id": webhook_id, "deleted": True}

    @router.put("/webhooks/{environment}")
    async def configure_webhook(environment: str, body: WebhookBody,
                                uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        url = await ctx["_validate_outbound_http_url"](body.url, "Webhook URL")
        old = await db.integration_webhooks.find_one(
            {"id": f"{uid}:{env}", "user_id": uid, "environment": env}, {"_id": 0})
        newly_generated = not bool(old and old.get("secret_encrypted"))
        secret = "whsec_" + secrets.token_urlsafe(32) if newly_generated else None
        doc = {
            "id": f"{uid}:{env}", "user_id": uid, "environment": env,
            "name": (old or {}).get("name") or "Site principal",
            "is_default": True, "url": url, "active": body.active,
            "secret_encrypted": (ctx["_encrypt"](secret) if secret
                                 else old["secret_encrypted"]), "updated_at": now(),
            "created_at": (old or {}).get("created_at") or now(),
        }
        await db.integration_webhooks.replace_one(
            {"id": f"{uid}:{env}", "user_id": uid, "environment": env},
            doc, upsert=True)
        return {"environment": env, "url": url, "active": body.active,
                "webhook_secret": secret, "secret_returned_once": newly_generated}

    @router.post("/webhooks/{environment}/regenerate-secret")
    async def rotate_webhook_secret(environment: str, uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        secret = "whsec_" + secrets.token_urlsafe(32)
        result = await db.integration_webhooks.update_one(
            {"id": f"{uid}:{env}", "user_id": uid, "environment": env},
            {"$set": {"secret_encrypted": ctx["_encrypt"](secret), "updated_at": now()}})
        if not result.matched_count:
            raise HTTPException(404, "Webhook configuration not found")
        return {"environment": env, "webhook_secret": secret, "secret_returned_once": True}

    @router.post("/webhooks/{environment}/{webhook_id}/regenerate-secret")
    async def rotate_single_webhook_secret(
            environment: str, webhook_id: str,
            uid: str = Depends(recent_browser_owner)):
        env = check_env(environment)
        secret = "whsec_" + secrets.token_urlsafe(32)
        result = await db.integration_webhooks.update_one(
            {"id": webhook_id, "user_id": uid, "environment": env},
            {"$set": {
                "secret_encrypted": ctx["_encrypt"](secret),
                "updated_at": now(),
            }})
        if not result.matched_count:
            raise HTTPException(404, "Webhook configuration not found")
        return {
            "environment": env, "webhook_id": webhook_id,
            "webhook_secret": secret, "secret_returned_once": True,
        }

    @router.post("/webhooks/{environment}/test")
    async def test_webhook(environment: str, uid: str = Depends(browser_owner)):
        env = check_env(environment)
        wh = await db.integration_webhooks.find_one(
            {"id": f"{uid}:{env}", "user_id": uid,
             "environment": env, "active": True}, {"_id": 0})
        if not wh:
            raise HTTPException(409, "Active webhook configuration required")
        if not await ctx["_is_safe_outbound_http_url"](wh.get("url", "")):
            raise HTTPException(422, "Webhook URL is not a safe public destination")
        delivery = await deliver_event(
            uid, env, "webhook.test", {"environment": env, "test": True},
            destination_id=wh.get("id"))
        if not delivery or delivery.get("status") == "unconfigured":
            raise HTTPException(503, "Webhook test delivery could not be started safely")
        if delivery["status"] != "delivered":
            raise HTTPException(502, detail={
                "message": "Webhook test delivery failed",
                "delivery_id": delivery.get("id"),
            })
        return {"sent": True, "event": "webhook.test", "delivery_id": delivery["id"]}

    @router.post("/webhooks/{environment}/{webhook_id}/test")
    async def test_single_webhook(environment: str, webhook_id: str,
                                  uid: str = Depends(browser_owner)):
        env = check_env(environment)
        wh = await db.integration_webhooks.find_one({
            "id": webhook_id, "user_id": uid,
            "environment": env, "active": True,
        }, {"_id": 0})
        if not wh:
            raise HTTPException(409, "Active webhook configuration required")
        if not await ctx["_is_safe_outbound_http_url"](wh.get("url", "")):
            raise HTTPException(422, "Webhook URL is not a safe public destination")
        delivery = await deliver_event(
            uid, env, "webhook.test", {"environment": env, "test": True},
            destination_id=webhook_id)
        if not delivery or delivery.get("status") == "unconfigured":
            raise HTTPException(503, "Webhook test delivery could not be started safely")
        if delivery["status"] != "delivered":
            raise HTTPException(502, detail={
                "message": "Webhook test delivery failed",
                "delivery_id": delivery.get("id"),
            })
        return {"sent": True, "event": "webhook.test",
                "webhook_id": webhook_id, "delivery_id": delivery["id"]}

    @router.get("/webhooks/{environment}/deliveries")
    async def webhook_deliveries(environment: str, limit: int = Query(50, ge=1, le=200),
                                 webhook_id: Optional[str] = Query(None),
                                 uid: str = Depends(browser_owner)):
        env = check_env(environment)
        query = {"user_id": uid, "environment": env}
        if webhook_id:
            query["destination_id"] = webhook_id
        return await db.integration_webhook_deliveries.find(
            query, {"_id": 0, "payload": 0}
        ).sort("created_at", -1).to_list(limit)

    @v1.get("/mobile-money/operators")
    async def mobile_money_operators(
            direction: Literal["deposit", "payout"] = "deposit",
            credential: dict = Depends(authenticate)):
        return await operator_catalog(ctx, direction, credential["user_id"])

    @v1.post("/deposits")
    async def start_deposit(body: DepositBody, request: Request,
                            credential: dict = Depends(authenticate)):
        require_scope(credential, "deposits:write")
        require_live(credential)
        key = require_idempotency(request)
        payload = body.model_dump()
        claim_doc, replay = await claim(credential, key, "deposit", payload)
        if replay:
            return claim_doc["response"]
        # The integration's amount is the payer's total, irrespective of a
        # legacy fee_bearer value supplied by an existing API client.
        req = ctx["MobileMoneyDepositRequest"](
            **{**payload, "fee_bearer": "merchant"},
            idempotency_key=f"btpi_{claim_doc['id'][:64]}")
        try:
            result = await ctx["start_mobile_money_deposit"](
                req, request, credential["user_id"])
        except HTTPException as exc:
            # This precise pre-dispatch challenge creates no invoice. Allow the
            # client to supply its OTP, but never release an uncertain payment.
            if (exc.status_code == 400 and isinstance(exc.detail, dict)
                    and exc.detail.get("code") == "OTP_REQUIRED"):
                persisted = await db.momo_deposits.find_one({
                    "user_id": credential["user_id"],
                    "idempotency_key": req.idempotency_key,
                })
                if not persisted:
                    await db.integration_idempotency.delete_many({
                        "id": claim_doc["id"], "user_id": credential["user_id"],
                        "environment": credential["environment"], "response": None,
                        "fingerprint": claim_doc["fingerprint"],
                    })
            raise
        business_id = result.get("id") or result.get("deposit_id")
        result = {"id": business_id, "status": result.get("status", "pending"),
                  "deposit": result}
        await finish_claim(claim_doc, result, "deposit", business_id,
                           status=result.get("status", "pending"),
                           reference=body.reference)
        return result

    @v1.get("/deposits/{deposit_id}")
    async def get_deposit(deposit_id: str, credential: dict = Depends(authenticate)):
        op = await lookup_operation(credential, "deposit", deposit_id)
        result = await ctx["get_momo_deposit"](deposit_id, credential["user_id"])
        status = result.get("status", "pending")
        await emit_transition(op, status)
        return result

    @v1.get("/deposits")
    async def list_deposits(limit: int = Query(100, ge=1, le=500),
                            credential: dict = Depends(authenticate)):
        return await list_operations(credential, "deposit", limit)

    @v1.post("/payouts")
    async def start_payout(body: PayoutBody, request: Request,
                           credential: dict = Depends(authenticate)):
        require_live(credential)
        require_scope(credential, "payouts:write")
        if not credential.get("payout_opt_in"):
            raise HTTPException(403, "Explicit live payout opt-in and payouts:write scope required")
        require_verified_kyc(credential)
        key = require_idempotency(request)
        payload = body.model_dump()
        claim_doc, replay = await claim(credential, key, "payout", payload)
        if replay:
            return claim_doc["response"]
        request.state.merchant_api = True
        req = ctx["TransferRequest"](
            transfer_type="biz_to_mobile", recipient=body.recipient,
            country=body.country, operator=body.operator, amount=body.amount,
            currency=body.currency, description=body.description or "",
            fee_bearer="sender",
            idempotency_key=f"btpi_{claim_doc['id'][:64]}")
        if body.reference:
            req.metadata = {"integration_reference": body.reference}
        result = await ctx["transfer"](req, request, credential["user_id"])
        tx = result.get("transaction") if isinstance(result, dict) else None
        business_id = (tx.get("id") if isinstance(tx, dict) else None) or (
            getattr(tx, "id", None))
        status = (tx.get("status") if isinstance(tx, dict) else None) or "pending"
        response = {"id": business_id, "status": status, "payout": result}
        await finish_claim(claim_doc, response, "payout", business_id, status,
                           reference=body.reference)
        return response

    @v1.get("/payouts/{payout_id}")
    async def get_payout(payout_id: str, credential: dict = Depends(authenticate)):
        op = await lookup_operation(credential, "payout", payout_id)
        tx = await db.transactions.find_one(
            {"id": payout_id, "user_id": credential["user_id"]}, {"_id": 0})
        if not tx:
            raise HTTPException(404, "Payout not found")
        await emit_transition(op, tx.get("status", "pending"))
        return tx

    @v1.get("/payouts")
    async def list_payouts(limit: int = Query(100, ge=1, le=500),
                           credential: dict = Depends(authenticate)):
        return await list_operations(credential, "payout", limit)

    @v1.get("/crypto/assets")
    async def crypto_asset_catalog(
            direction: Literal["deposit", "payout"] = "deposit",
            credential: dict = Depends(authenticate)):
        await crypto_features(direction)
        if direction == "deposit":
            assets = await ctx["crypto_assets"]()
            return [{
                "asset_code": asset["asset_code"],
                "coin": asset["coin"], "network": asset["network"],
                "network_name": asset["network_name"],
                "minimum": asset["minimum"], "maximum": asset["maximum"],
                "memo_required": asset["memo_required"],
                "fee_pct": asset["fee_pct"], "fee_fixed": asset["fee_fixed"],
            } for asset in assets]
        coins = await ctx["public_crypto_coins"](credential["user_id"])
        return [{
            "asset_code": network["asset_code"],
            "coin": coin["coin"], "network": network["code"],
            "network_name": network["name"],
            "minimum": network["min"], "maximum": network["max"],
            "memo_required": network["memo_required"],
            "balance": network["balance"],
            "fee_pct": network["fee_pct"], "fee_fixed": network["fee_fixed"],
        } for coin in coins for network in coin["networks"]]

    @v1.post("/crypto/deposits")
    async def start_crypto_deposit(body: CryptoDepositBody, request: Request,
                                   credential: dict = Depends(authenticate)):
        require_scope(credential, "deposits:write")
        require_live(credential)
        await crypto_features("deposit")
        require_crypto_precision(body.amount)
        key = require_idempotency(request)
        payload = body.model_dump(mode="json")
        claim_doc, replay = await claim(
            credential, key, "crypto_deposit", payload, reference=body.reference)
        if replay:
            return claim_doc["response"]
        try:
            deposit = await ctx["create_crypto_deposit"](
                ctx["CryptoDepositRequest"](
                    amount=body.amount, asset_code=body.asset_code,
                    full_name=body.full_name, email=body.email,
                    refund_address=body.refund_address, origin_url="",
                    idempotency_key=f"btpi_{claim_doc['id'][:64]}",
                ), credential["user_id"])
        except HTTPException as exc:
            # The provider may have accepted the intent without returning an
            # address. Make its durable local row discoverable by this key,
            # without creating a second upstream intent.
            if exc.status_code >= 500 and await recover_claim(credential, claim_doc):
                return claim_doc["response"]
            raise
        response = {
            "id": deposit["id"], "status": deposit["status"],
            "deposit": public_crypto_deposit(deposit),
        }
        await finish_claim(
            claim_doc, response, "crypto_deposit", deposit["id"],
            status=deposit["status"], reference=body.reference)
        return response

    @v1.get("/crypto/deposits/{deposit_id}")
    async def get_integration_crypto_deposit(
            deposit_id: str, credential: dict = Depends(authenticate)):
        op = await lookup_operation(credential, "crypto_deposit", deposit_id)
        deposit = await ctx["get_crypto_deposit"](
            deposit_id, credential["user_id"])
        await emit_transition(op, str(deposit.get("status") or "pending").lower())
        return public_crypto_deposit(deposit)

    @v1.get("/crypto/deposits")
    async def list_integration_crypto_deposits(
            limit: int = Query(100, ge=1, le=500),
            credential: dict = Depends(authenticate)):
        return await list_operations(credential, "crypto_deposit", limit)

    @v1.post("/crypto/payouts")
    async def start_crypto_payout(body: CryptoPayoutBody, request: Request,
                                  credential: dict = Depends(authenticate)):
        require_scope(credential, "payouts:write")
        require_live(credential)
        if not credential.get("payout_opt_in"):
            raise HTTPException(403, "Explicit live payout opt-in and payouts:write scope required")
        require_verified_kyc(credential)
        await crypto_features("payout")
        require_crypto_precision(body.amount)
        key = require_idempotency(request)
        # Use the same active provider code advertised to API clients, which
        # may differ from the local fixed wallet ID (e.g. provider aliases).
        coins = await ctx["public_crypto_coins"](credential["user_id"])
        active = next((
            (coin, network)
            for coin in coins for network in coin["networks"]
            if network["asset_code"].upper() == body.asset_code.strip().upper()
        ), None)
        spec = (ctx["_crypto_wallet_spec"](
            coin=active[0]["coin"], network=active[1]["code"])
            if active else None)
        if not spec:
            raise HTTPException(400, "Cryptomonnaie ou réseau non pris en charge")
        if body.fee_bearer == "receiver":
            fees = await ctx["_crypto_withdrawal_fee_components"](
                spec["coin"], body.amount, asset_id=spec["id"])
            recipient_gets = round(body.amount - fees["fee"], 8)
            if recipient_gets <= 0 or Decimal(str(recipient_gets)).as_tuple().exponent < -6:
                raise HTTPException(
                    400, "Montant net après frais non représentable à 6 décimales")
        payload = body.model_dump(mode="json")
        claim_doc, replay = await claim(
            credential, key, "crypto_payout", payload, reference=body.reference)
        if replay:
            return claim_doc["response"]
        request.state.merchant_api = True
        transfer_request = ctx["TransferRequest"](
            transfer_type="biz_to_crypto",
            recipient=body.wallet_address, wallet_address=body.wallet_address,
            crypto=spec["coin"], network=spec["network_code"],
            asset_code=body.asset_code.strip().upper(),
            amount=body.amount, currency="USDT",
            destination_memo=body.destination_memo,
            fee_bearer=body.fee_bearer,
            description=body.description or "",
            idempotency_key=f"btpi_{claim_doc['id'][:64]}",
            metadata={"integration_reference": body.reference} if body.reference else None,
        )
        result = await ctx["transfer"](
            transfer_request, request, credential["user_id"])
        tx = result.get("transaction") or {}
        if hasattr(tx, "model_dump"):
            tx = tx.model_dump()
        business_id = tx.get("id")
        if not business_id:
            raise HTTPException(502, "Résultat du retrait crypto incertain")
        latest = await db.transactions.find_one(
            {"id": business_id, "user_id": credential["user_id"]}, {"_id": 0})
        tx = latest or tx
        response = {
            "id": business_id, "status": tx.get("status", "pending"),
            "payout": public_crypto_payout(tx),
        }
        await finish_claim(
            claim_doc, response, "crypto_payout", business_id,
            response["status"], reference=body.reference)
        return response

    @v1.get("/crypto/payouts/{payout_id}")
    async def get_integration_crypto_payout(
            payout_id: str, credential: dict = Depends(authenticate)):
        op = await lookup_operation(credential, "crypto_payout", payout_id)
        tx = await db.transactions.find_one(
            {"id": payout_id, "user_id": credential["user_id"]}, {"_id": 0})
        if not tx:
            raise HTTPException(404, "Crypto payout not found")
        await emit_transition(op, str(tx.get("status") or "pending").lower())
        return public_crypto_payout(tx)

    @v1.get("/crypto/payouts")
    async def list_integration_crypto_payouts(
            limit: int = Query(100, ge=1, le=500),
            credential: dict = Depends(authenticate)):
        return await list_operations(credential, "crypto_payout", limit)

    @v1.get("/exchanges/quote")
    async def exchange_quote(from_currency: str, to_currency: str, amount: float,
                             credential: dict = Depends(authenticate)):
        if credential["environment"] == "test":
            # Quote calculation reads only current configured rates and fees.
            return await ctx["conversion_quote"](from_currency, to_currency, amount)
        return await ctx["conversion_quote"](from_currency, to_currency, amount)

    @v1.post("/exchanges")
    async def execute_exchange(body: ExchangeBody, request: Request,
                               credential: dict = Depends(authenticate)):
        require_scope(credential, "exchanges:write")
        require_live(credential)
        require_verified_kyc(credential)
        key = require_idempotency(request)
        payload = body.model_dump()
        claim_doc, replay = await claim(credential, key, "exchange", payload)
        if replay:
            return claim_doc["response"]
        req = ctx["ExchangeRequest"](
            **payload, idempotency_key=f"btpi_{claim_doc['id'][:64]}")
        result = await ctx["do_exchange"](req, credential["user_id"])
        tx = result.get("transaction") or {}
        business_id = tx.get("id")
        response = {"id": business_id, "status": tx.get("status", "completed"),
                    "exchange": result}
        await finish_claim(claim_doc, response, "exchange", business_id,
                           response["status"])
        return response

    @v1.get("/exchanges/{exchange_id}")
    async def get_exchange(exchange_id: str, credential: dict = Depends(authenticate)):
        op = await lookup_operation(credential, "exchange", exchange_id)
        tx = await db.transactions.find_one(
            {"id": exchange_id, "user_id": credential["user_id"]}, {"_id": 0})
        if not tx:
            raise HTTPException(404, "Exchange not found")
        await emit_transition(op, tx.get("status", "completed"))
        return tx

    @v1.get("/exchanges")
    async def list_exchanges(limit: int = Query(100, ge=1, le=500),
                             credential: dict = Depends(authenticate)):
        return await list_operations(credential, "exchange", limit)

    @v1.post("/links")
    async def create_payment_link(body: LinkBody, request: Request,
                                  credential: dict = Depends(authenticate)):
        require_scope(credential, "links:write")
        require_live(credential)
        key = require_idempotency(request)
        payload = body.model_dump()
        claim_doc, replay = await claim(credential, key, "link", payload)
        if replay:
            return claim_doc["response"]
        link_id = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"biz-transpay-integration-link:{credential['user_id']}:{claim_doc['id']}",
        ).hex
        link = await db.payment_links.find_one(
            {"id": link_id, "user_id": credential["user_id"]}, {"_id": 0})
        if not link:
            create_link = ctx.get("_create_payment_link")
            if create_link:
                link = await create_link(
                    ctx["PaymentLinkCreate"](**payload), credential["user_id"],
                    deterministic_id=link_id)
            else:
                link = await ctx["create_link"](
                    ctx["PaymentLinkCreate"](**payload), credential["user_id"])
        if hasattr(link, "model_dump"):
            link = link.model_dump()
        response = {"id": link["id"], "status": "active", "link": link}
        await finish_claim(claim_doc, response, "link", link["id"], "active")
        return response

    @v1.get("/links/{link_id}")
    async def get_payment_link(link_id: str, credential: dict = Depends(authenticate)):
        await lookup_operation(credential, "link", link_id)
        link = await db.payment_links.find_one(
            {"id": link_id, "user_id": credential["user_id"]}, {"_id": 0})
        if not link:
            raise HTTPException(404, "Link not found")
        return link

    @v1.get("/links")
    async def list_payment_links(limit: int = Query(100, ge=1, le=500),
                                 credential: dict = Depends(authenticate)):
        return await list_operations(credential, "link", limit)

    @v1.get("/links/{link_id}/payments")
    async def link_payments(link_id: str, credential: dict = Depends(authenticate)):
        await lookup_operation(credential, "link", link_id)
        link = await db.payment_links.find_one(
            {"id": link_id, "user_id": credential["user_id"]}, {"_id": 0, "id": 1})
        if not link:
            raise HTTPException(404, "Link not found")
        payments = await db.link_payments.find(
            {"link_id": link_id}, {"_id": 0}
        ).sort("created_at", -1).to_list(200)
        for payment in payments:
            await emit_link_payment_transition(credential, payment)
        return payments

    @v1.get("/transactions")
    async def integration_transactions(limit: int = Query(100, ge=1, le=500),
                                       credential: dict = Depends(authenticate)):
        ops = await db.integration_operations.find({
            "user_id": credential["user_id"],
            "environment": credential["environment"],
        }, {"_id": 0}).sort("created_at", -1).to_list(limit)
        return ops

    def documentation_payload() -> dict:
        def param(name: str, location: str, required: bool, value_type: str,
                  description: str, example: Any = None,
                  default: Any = None) -> dict:
            item = {
                "name": name, "location": location, "required": required,
                "type": value_type, "description": description,
            }
            if example is not None:
                item["example"] = example
            if default is not None:
                item["default"] = default
            return item

        def body_field(name: str, value_type: str, required: bool,
                       description: str, example: Any = None,
                       default: Any = None) -> dict:
            return param(name, "body", required, value_type, description,
                         example, default)

        def error(status: int, detail: Any) -> dict:
            descriptions = {
                400: "Requête invalide ou condition métier non satisfaite.",
                401: "Authentification requise ou identifiants invalides.",
                403: "Accès refusé pour ces identifiants, ce compte ou cette requête.",
                404: "Ressource demandée introuvable.",
                409: "Conflit ou issue incertaine ; consultez le détail avant toute nouvelle tentative.",
                422: "Paramètres, chemin ou corps de requête invalides.",
                428: "Une réauthentification récente est nécessaire.",
                429: "Limite de débit atteinte.",
                502: "Erreur lors de l’envoi au prestataire.",
                503: "Service ou environnement de test indisponible.",
            }
            return {
                "status": status,
                "description": descriptions.get(
                    status, "La requête n’a pas pu être traitée."),
                "example": {"detail": detail},
            }

        idempotency_required_error = {
            "code": "IDEMPOTENCY_KEY_REQUIRED",
            "message": "A valid Idempotency-Key header is required.",
        }
        scope_error = {
            "code": "INTEGRATION_SCOPE_REQUIRED",
            "message": "The required integration scope is required.",
            "required_scope": "required-scope",
        }
        validation_error = [{
            "loc": ["body", "field"], "msg": "Field required",
            "type": "missing",
        }]

        def query_error(name: str) -> dict:
            return error(422, [{
                "loc": ["query", name],
                "msg": "Field required" if name != "limit"
                else "Input should be greater than or equal to 1",
                "type": "missing" if name != "limit" else "greater_than_equal",
            }])

        op_row = {
            "id": "operation-id", "user_id": "business-user-id",
            "environment": "live", "kind": "deposit",
            "business_id": "business-record-id", "status": "pending",
            "reference": "order-125", "idempotency_id": "claim-id",
            "created_at": "2026-01-01T12:00:00+00:00",
            "updated_at": "2026-01-01T12:00:00+00:00",
        }
        transaction_row = {
            "id": "transaction-id", "user_id": "business-user-id",
            "type": "transfer", "direction": "out", "amount": 5000,
            "currency": "XOF", "status": "pending",
            "created_at": "2026-01-01T12:00:00+00:00",
            "metadata": {"transfer_type": "biz_to_mobile"},
        }
        link_row = {
            "id": "link-id", "user_id": "business-user-id",
            "slug": "link-slug", "title": "Order 125", "amount": 10000,
            "currency": "XOF", "description": "", "expires_at": None,
            "single_use": False, "active": True, "payments_received": 0,
            "total_received": 0, "created_at": "2026-01-01T12:00:00+00:00",
            "amount_type": "fixed", "min_amount": None, "max_amount": None,
            "fee_bearer": "customer", "logo": None,
        }
        deposit_row = {
            "id": "deposit-id", "status": "pending",
            "created_at": "2026-01-01T12:00:00+00:00",
            "pending_expires_at": "2026-01-01T12:10:00+00:00",
            "amount": 10000, "requested_amount": 10000,
            "charged_amount": 10000, "amount_net": 9500,
            "gateway_fee": 300, "platform_fee": 200, "total_fee": 500,
            "fee_bearer": "merchant", "currency": "XOF",
            "operator": {"code": "tmoney_tg", "label": "TMoney"},
            "operator_name": "TMoney", "phone_number": "90000000",
            "payment_flow": {}, "auth_mode": None, "otp_required": False,
            "challenge_status": "pending", "instructions": None,
            "checkout_url": None, "redirect_url": None,
            "payment_kind": "phone", "payment_fallback": None,
            "submission_unknown": False, "message": None,
            "prompt_sent": False, "prompt_error": None, "failed_reason": None,
        }
        crypto_deposit_row = {
            "id": "crypto-deposit-id", "status": "pending",
            "amount": 10, "asset_code": "USDT.TRC20", "coin": "USDT",
            "network": "TRC20", "credit_currency": "USDT.TRC20",
            "deposit_address": "TQn9Y2khEsLJW1ChVWFMSMeB6L6pHUHeer",
            "memo": None, "memo_type": None, "amount_to_send": "10",
            "expires_at": "2026-01-01T12:10:00+00:00",
            "fee_pct": 4, "fee_fixed": 0,
            "fee": None, "amount_net": None, "tx_hash": None,
            "pending_manual": False,
            "created_at": "2026-01-01T12:00:00+00:00",
            "updated_at": "2026-01-01T12:00:00+00:00",
        }
        crypto_payout_row = {
            "id": "crypto-payout-id", "status": "pending",
            "amount": 10, "asset_code": "USDT.TRC20", "coin": "USDT",
            "network": "TRC20",
            "wallet_address": "TQn9Y2khEsLJW1ChVWFMSMeB6L6pHUHeer",
            "destination_memo": None, "fee": 0.4,
            "fee_bearer": "sender", "recipient_gets": 10,
            "total_debit": 10.4, "pending_manual": False,
            "tx_hash": None, "created_at": "2026-01-01T12:00:00+00:00",
        }
        responses = {
            ("GET", "/api/integration/v1/mobile-money/operators"): {
                "direction": "deposit", "enabled": True,
                "availability_source": "serving_environment_configuration",
                "operators": [{
                    "country": "BF", "country_label": "Burkina Faso",
                    "code": "moov_bf", "name": "Moov Money Burkina",
                    "currency": "XOF", "min": 100, "max": None,
                    "payment_flow": {
                        "kind": "ussd_confirmation", "before_submit": False,
                        "otp_required": False, "ussd_code": "*555*6#",
                    },
                }],
            },
            ("GET", "/api/integration/settings"): {
                "environment": "test",
                "credentials": {
                    "public_key": "pk_test_masked", "public_key_masked": "pk_test_…",
                    "active": True, "scopes": ["deposits:write"],
                    "created_at": "2026-01-01T12:00:00+00:00",
                },
                "available": False,
                "message": "Les opérations financières Sandbox sont indisponibles sans environnement de test officiel isolé ; aucun fonds réel ne sera déplacé.",
                "webhook": None,
                "warning": "Les clés secrètes ne sont affichées qu’une seule fois lors de leur création.",
            },
            ("POST", "/api/integration/credentials"): {
                "credentials": {
                    "public_key": "pk_test_example", "public_key_masked": "pk_test_…",
                    "active": True, "scopes": [
                        "deposits:write", "exchanges:write", "links:write",
                        "transactions:read",
                    ],
                    "created_at": "2026-01-01T12:00:00+00:00",
                },
                "secret_key": "sk_test_returned_once", "secret_returned_once": True,
            },
            ("POST", "/api/integration/credentials/{environment}/regenerate"): {
                "credentials": {
                    "public_key": "pk_live_example", "public_key_masked": "pk_live_…",
                    "active": True, "scopes": [
                        "deposits:write", "exchanges:write", "links:write",
                        "transactions:read",
                    ],
                    "created_at": "2026-01-01T12:00:00+00:00",
                },
                "secret_key": "sk_live_returned_once", "secret_returned_once": True,
            },
            ("PATCH", "/api/integration/credentials/{environment}"): {
                "environment": "live", "active": True,
            },
            ("PUT", "/api/integration/webhooks/{environment}"): {
                "environment": "live", "url": "https://merchant.example/hooks",
                "active": True, "webhook_secret": "whsec_returned_once",
                "secret_returned_once": True,
            },
            ("POST", "/api/integration/webhooks/{environment}/regenerate-secret"): {
                "environment": "live", "webhook_secret": "whsec_returned_once",
                "secret_returned_once": True,
            },
            ("POST", "/api/integration/webhooks/{environment}/test"): {
                "sent": True, "event": "webhook.test", "delivery_id": "delivery-id",
            },
            ("GET", "/api/integration/webhooks/{environment}/deliveries"): [{
                "id": "delivery-id", "event_id": "event-id",
                "environment": "live", "event_type": "payment.success",
                "url": "https://merchant.example/hooks", "attempts": 1,
                "status": "delivered", "status_code": 200,
                "created_at": "2026-01-01T12:00:00+00:00",
            }],
            ("GET", "/api/integration/documentation"): {
                "title": "API d’intégration Biz-transPay",
                "description": "Référence générée de l’API d’intégration.",
                "sections": [{
                    "id": "startup", "title": "Bien démarrer",
                    "description": "Utilisez les routes d’intégration authentifiées.",
                }],
                "endpoints": [{
                    "id": "integration-endpoint-0", "method": "GET",
                    "path": "/api/integration/settings",
                    "title": "Consulter les paramètres d’intégration",
                    "description": "Consulter les paramètres d’un environnement.",
                    "auth": "Session Biz-transPay du marchand", "parameters": [],
                    "request": None,
                    "response": {
                        "environment": "test", "credentials": None,
                        "available": False, "message": "Les opérations de test sont indisponibles.",
                        "webhook": None,
                        "warning": "Les clés secrètes ne sont affichées qu’une seule fois lors de leur création.",
                    },
                    "errors": [],
                    "examples": {
                        "curl": 'curl "$BIZ_BASE_URL/api/integration/settings?environment=test"',
                    },
                }],
            },
            ("GET", "/api/integration/documentation.pdf"): {
                "content_type": "application/pdf",
                "content_disposition": 'attachment; filename="biz-transpay-api.pdf"',
            },
            ("POST", "/api/integration/v1/deposits"): {
                "id": "deposit-id", "status": "pending", "deposit": deposit_row,
            },
            ("GET", "/api/integration/v1/deposits/{deposit_id}"): deposit_row,
            ("GET", "/api/integration/v1/deposits"): [op_row],
            ("POST", "/api/integration/v1/payouts"): {
                "id": "payout-id", "status": "pending",
                "payout": {
                    "transaction": transaction_row, "fee": 250,
                    "processed_amount": 5000, "total_debit": 5250,
                    "recipient_gets": 5000, "operator": "TMoney",
                },
            },
            ("GET", "/api/integration/v1/payouts/{payout_id}"): transaction_row,
            ("GET", "/api/integration/v1/payouts"): [op_row | {"kind": "payout"}],
            ("GET", "/api/integration/v1/exchanges/quote"): {
                "from_currency": "XOF", "to_currency": "XAF",
                "amount": 10000, "fee": 100, "rate": 1.0,
                "received": 9900, "fee_currency": "XOF",
            },
            ("POST", "/api/integration/v1/exchanges"): {
                "id": "exchange-id", "status": "completed",
                "exchange": {
                    "received": 9900, "fee": 100, "rate": 1.0,
                    "from_currency": "XOF", "to_currency": "XAF",
                    "transaction": transaction_row | {
                        "id": "exchange-id", "type": "exchange",
                        "status": "completed",
                        "metadata": {
                            "rate": 1.0, "fee": 100, "received": 9900,
                            "from_currency": "XOF", "to_currency": "XAF",
                            "gateway_fee": 0.0, "platform_fee": 100,
                            "operation_id": "exchange-operation-id",
                        },
                    },
                },
            },
            ("GET", "/api/integration/v1/exchanges/{exchange_id}"):
                transaction_row | {
                    "type": "exchange", "status": "completed",
                    "metadata": {
                        "rate": 1.0, "fee": 100, "received": 9900,
                        "from_currency": "XOF", "to_currency": "XAF",
                        "gateway_fee": 0.0, "platform_fee": 100,
                        "operation_id": "exchange-operation-id",
                    },
                },
            ("GET", "/api/integration/v1/exchanges"): [op_row | {"kind": "exchange"}],
            ("POST", "/api/integration/v1/links"): {
                "id": "link-id", "status": "active", "link": link_row,
            },
            ("GET", "/api/integration/v1/links/{link_id}"): link_row,
            ("GET", "/api/integration/v1/links"): [op_row | {
                "kind": "link", "status": "active", "business_id": "link-id",
            }],
            ("GET", "/api/integration/v1/links/{link_id}/payments"): [{
                "id": "link-payment-id", "link_id": "link-id",
                "status": "paid", "amount": 10000, "currency": "XOF",
                "created_at": "2026-01-01T12:00:00+00:00",
            }],
            ("GET", "/api/integration/v1/transactions"): [op_row],
            ("GET", "/api/integration/v1/crypto/assets"): [{
                "asset_code": "USDT.TRC20", "coin": "USDT",
                "network": "TRC20", "network_name": "TRON (TRC20)",
                "minimum": 1, "maximum": 100000, "memo_required": False,
                "fee_pct": 4, "fee_fixed": 0,
            }],
            ("POST", "/api/integration/v1/crypto/deposits"): {
                "id": "crypto-deposit-id", "status": "pending",
                "deposit": crypto_deposit_row,
            },
            ("GET", "/api/integration/v1/crypto/deposits/{deposit_id}"):
                crypto_deposit_row,
            ("GET", "/api/integration/v1/crypto/deposits"): [
                op_row | {"kind": "crypto_deposit", "business_id": "crypto-deposit-id"}],
            ("POST", "/api/integration/v1/crypto/payouts"): {
                "id": "crypto-payout-id", "status": "pending",
                "payout": crypto_payout_row,
            },
            ("GET", "/api/integration/v1/crypto/payouts/{payout_id}"):
                crypto_payout_row,
            ("GET", "/api/integration/v1/crypto/payouts"): [
                op_row | {"kind": "crypto_payout", "business_id": "crypto-payout-id"}],
        }

        common_bearer_errors = [
            error(401, "Bearer secret and X-Public-Key are required"),
            error(401, "Invalid or mismatched integration credentials"),
            error(401, "Invalid integration credentials"),
            error(403, "Integration credentials are disabled"),
            error(403, "Business account inactive"),
            error(429, "Integration API rate limit exceeded"),
        ]
        common_session_errors = [
            error(401, "Session requise"),
            error(403, "API integration is reserved for business accounts"),
        ]
        common_recent_session_errors = common_session_errors + [
            error(428, {"message": "Réauthentification requise pour cette opération.",
                        "code": "REAUTH_REQUIRED"}),
        ]
        schemas = {
            ("POST", "/api/integration/credentials"): {
                "body": [
                    body_field("environment", "string (test|live)", True,
                               "Environnement des identifiants.", "test"),
                    body_field("payout_opt_in", "boolean", False,
                               "Autoriser explicitement la portée de retrait en production.", False, False),
                ],
                "request": {"environment": "test", "payout_opt_in": False},
                "errors": common_recent_session_errors + [error(422, validation_error)],
            },
            ("PATCH", "/api/integration/credentials/{environment}"): {
                "body": [
                    body_field("active", "boolean", True, "Activer ou désactiver cette clé.", True),
                    body_field("payout_opt_in", "boolean|null", False,
                               "Activer ou retirer l’autorisation de retrait en production.", True),
                ],
                "request": {"active": True, "payout_opt_in": True},
                "errors": common_recent_session_errors + [
                    error(404, "Integration credentials not found"),
                    error(422, validation_error),
                ],
            },
            ("PUT", "/api/integration/webhooks/{environment}"): {
                "body": [
                    body_field("url", "string", True, "URL HTTP(S) publique du webhook (8 à 2048 caractères).",
                               "https://merchant.example/hooks"),
                    body_field("active", "boolean", False, "Indique si les livraisons sont activées.",
                               True, True),
                ],
                "request": {"url": "https://merchant.example/hooks", "active": True},
                "errors": common_recent_session_errors + [
                    error(422, validation_error),
                    error(422, "Webhook URL is not a safe public destination"),
                ],
            },
            ("POST", "/api/integration/v1/deposits"): {
                "body": [
                    body_field("amount", "number", True, "Montant total payé par le client, frais inclus ; le marchand reçoit ce montant moins les frais.", 10000),
                    body_field("currency", "string", True, "Devise du dépôt.", "XOF"),
                    body_field("country", "string", True, "Code pays ISO-2.", "TG"),
                    body_field("operator", "string", True, "Code configuré de l’opérateur Mobile Money.",
                               "tmoney_tg"),
                    body_field("phone_number", "string", True, "Numéro de téléphone du payeur.", "90000000"),
                    body_field("email", "string", True, "Adresse e-mail du payeur.", "buyer@example.com"),
                    body_field("full_name", "string", True, "Nom complet du payeur.", "Buyer"),
                    body_field("reference", "string|null", False, "Référence du marchand.", "order-125"),
                    body_field("description", "string|null", False, "Description du dépôt.", "Order 125"),
                    body_field("otp", "string|null", False, "Code généré par le client avant POST lorsque payment_flow.before_submit et otp_required valent true (Orange Burkina).", "123456"),
                    body_field("fee_bearer", "string", False,
                               "Ancien paramètre accepté pour compatibilité, ignoré : les frais sont toujours inclus dans le montant payé et déduits du crédit marchand.",
                               "client", "client"),
                ],
                "request": {
                    "amount": 10000, "currency": "XOF", "country": "TG",
                    "operator": "tmoney_tg", "phone_number": "90000000",
                    "email": "buyer@example.com", "full_name": "Buyer",
                    "reference": "order-125",
                },
                "errors": common_bearer_errors + [
                    error(400, idempotency_required_error),
                    error(409, "Idempotency-Key was used with a different request"),
                    error(403, scope_error),
                    error(422, validation_error),
                    error(503, "Sandbox transactions are unavailable: no isolated official provider test environment is configured. No funds were moved."),
                    error(400, "Opérateur non disponible pour ce pays"),
                     error(400, {"code": "OTP_REQUIRED",
                                 "message": "Générez le code indiqué puis saisissez-le avant de lancer le paiement.",
                                 "payment_flow": {"kind": "otp", "before_submit": True,
                                                  "otp_required": True,
                                                  "ussd_template": "*144*4*6*{amount}#"}}),
                    error(503, "Mobile Money temporairement indisponible"),
                ],
            },
            ("POST", "/api/integration/v1/payouts"): {
                "body": [
                    body_field("amount", "number", True, "Montant reçu intact par le bénéficiaire ; les frais sont ajoutés au débit du marchand.", 5000),
                    body_field("currency", "string", True, "Devise du retrait.", "XOF"),
                    body_field("country", "string", True, "Code pays ISO-2 du bénéficiaire.", "TG"),
                    body_field("operator", "string", True, "Code configuré de l’opérateur Mobile Money.",
                               "tmoney_tg"),
                    body_field("recipient", "string", True, "Numéro de téléphone du bénéficiaire.", "90000000"),
                    body_field("reference", "string|null", False, "Référence du marchand.", "payout-125"),
                    body_field("description", "string|null", False, "Description du retrait.", "Supplier payout"),
                    body_field("fee_bearer", "string", False, "Ancien paramètre accepté pour compatibilité, ignoré : les frais sont toujours ajoutés au débit du marchand et le bénéficiaire reçoit le montant demandé.",
                               "sender", "sender"),
                ],
                "request": {
                    "amount": 5000, "currency": "XOF", "country": "TG",
                    "operator": "tmoney_tg", "recipient": "90000000",
                    "reference": "payout-125", "fee_bearer": "sender",
                },
                "errors": common_bearer_errors + [
                    error(400, idempotency_required_error),
                    error(403, scope_error),
                    error(403, "Explicit live payout opt-in and payouts:write scope required"),
                    error(409, "Idempotency-Key was used with a different request"),
                    error(422, validation_error),
                    error(503, "Sandbox transactions are unavailable: no isolated official provider test environment is configured. No funds were moved."),
                    error(502, "Le retrait a peut-être été transmis au prestataire. Le solde reste réservé et une vérification manuelle est requise."),
                    error(400, "Solde insuffisant (frais inclus)"),
                ],
            },
            ("POST", "/api/integration/v1/exchanges"): {
                "body": [
                    body_field("from_currency", "string", True, "Devise source prise en charge.", "XOF"),
                    body_field("to_currency", "string", True, "Devise de destination prise en charge.", "XAF"),
                    body_field("amount", "number", True, "Montant positif à convertir.", 10000),
                ],
                "request": {"from_currency": "XOF", "to_currency": "XAF", "amount": 10000},
                "errors": common_bearer_errors + [
                    error(400, idempotency_required_error),
                    error(403, scope_error),
                    error(409, "Idempotency-Key was used with a different request"),
                    error(422, validation_error),
                    error(503, "Sandbox transactions are unavailable: no isolated official provider test environment is configured. No funds were moved."),
                    error(400, "Devises identiques"),
                    error(400, "Cette paire de conversion est désactivée"),
                    error(400, "Paire EUR→XOF non supportée"),
                    error(400, "Le portefeuille XOF est désactivé"),
                    error(400, "Solde insuffisant ou opération déjà appliquée"),
                ],
            },
            ("POST", "/api/integration/v1/links"): {
                "body": [
                    body_field("title", "string", True, "Titre du lien (1 à 120 caractères).", "Order 125"),
                    body_field("amount", "number", False,
                               "Montant fixe ; valeur par défaut 0, à rendre positive pour un lien fixe.",
                               10000, 0),
                    body_field("currency", "string", False, "Valeur parmi XOF, XAF, USDT ou UNIVERSAL.",
                               "XOF", "UNIVERSAL"),
                    body_field("description", "string|null", False, "Description du lien.", "", ""),
                    body_field("expires_at", "string|null", False, "Horodatage d’expiration facultatif."),
                    body_field("single_use", "boolean", False, "Limiter le lien à un seul paiement réussi.",
                               False, False),
                    body_field("amount_type", "string", False, "Valeur fixed ou free.", "fixed", "fixed"),
                    body_field("min_amount", "number|null", False, "Minimum facultatif pour un montant libre."),
                    body_field("max_amount", "number|null", False, "Maximum facultatif pour un montant libre."),
                    body_field("fee_bearer", "string", False, "Valeur customer ou owner.",
                               "customer", "customer"),
                ],
                "request": {"title": "Order 125", "amount": 10000, "currency": "XOF",
                            "amount_type": "fixed", "fee_bearer": "customer"},
                "errors": common_bearer_errors + [
                    error(400, idempotency_required_error),
                    error(403, scope_error),
                    error(409, "Idempotency-Key was used with a different request"),
                    error(422, validation_error),
                    error(503, "Sandbox transactions are unavailable: no isolated official provider test environment is configured. No funds were moved."),
                    error(400, "Le nom du lien est requis"),
                    error(400, "Le montant fixe doit être supérieur à zéro"),
                    error(400, "Montants minimum et maximum requis pour un montant libre"),
                    error(400, "Montant maximum doit être supérieur au minimum"),
                ],
            },
            ("POST", "/api/integration/v1/crypto/deposits"): {
                "body": [
                    body_field("amount", "number", True,
                               "Montant natif à envoyer, positif, dans les limites du catalogue, avec au plus 6 décimales.", 10),
                    body_field("asset_code", "string", True,
                               "Identifiant exact de l’actif/réseau obtenu par GET /crypto/assets?direction=deposit.",
                               "USDT.TRC20"),
                    body_field("full_name", "string", True, "Nom du payeur.", "Buyer Example"),
                    body_field("email", "string", True, "Adresse e-mail du payeur.", "buyer@example.com"),
                    body_field("refund_address", "string", True,
                               "Adresse de remboursement sur le même réseau.", "TQn9Y2khEsLJW1ChVWFMSMeB6L6pHUHeer"),
                    body_field("reference", "string|null", False,
                               "Référence du marchand.", "order-crypto-125"),
                ],
                "request": {
                    "amount": 10, "asset_code": "USDT.TRC20",
                    "full_name": "Buyer Example", "email": "buyer@example.com",
                    "refund_address": "TQn9Y2khEsLJW1ChVWFMSMeB6L6pHUHeer",
                    "reference": "order-crypto-125",
                },
                "errors": common_bearer_errors + [
                    error(400, idempotency_required_error),
                    error(400, "Montant crypto limité à 6 décimales"),
                    error(403, scope_error),
                    error(403, "Les opérations crypto sont désactivées"),
                    error(400, "Cet actif est désactivé par l'administrateur"),
                    error(409, "Operation outcome is uncertain; it will not be resubmitted. Retry later with the same Idempotency-Key."),
                    error(502, "Résultat de la demande inconnu. Réessayez avec la même clé."),
                ],
            },
            ("POST", "/api/integration/v1/crypto/payouts"): {
                "body": [
                    body_field("amount", "number", True,
                               "Montant natif avant frais, positif, dans les limites de l’actif, avec au plus 6 décimales.", 10),
                    body_field("asset_code", "string", True,
                               "Identifiant exact de l’actif/réseau obtenu par GET /crypto/assets?direction=payout.",
                               "USDT.TRC20"),
                    body_field("wallet_address", "string", True,
                               "Adresse du bénéficiaire sur ce réseau.", "TQn9Y2khEsLJW1ChVWFMSMeB6L6pHUHeer"),
                    body_field("destination_memo", "string|null", False,
                               "Mémo/tag obligatoire si indiqué par le catalogue."),
                    body_field("fee_bearer", "string (sender|receiver)", False,
                               "sender : frais ajoutés au débit ; receiver : frais déduits du montant reçu (rejet si le net exige plus de 6 décimales).",
                               "sender", "sender"),
                    body_field("reference", "string|null", False,
                               "Référence du marchand.", "payout-crypto-125"),
                    body_field("description", "string|null", False,
                               "Description facultative.", "Supplier payout"),
                ],
                "request": {
                    "amount": 10, "asset_code": "USDT.TRC20",
                    "wallet_address": "TQn9Y2khEsLJW1ChVWFMSMeB6L6pHUHeer",
                    "fee_bearer": "sender", "reference": "payout-crypto-125",
                },
                "errors": common_bearer_errors + [
                    error(400, idempotency_required_error),
                    error(400, "Montant crypto limité à 6 décimales"),
                    error(400, "Montant net après frais non représentable à 6 décimales"),
                    error(403, scope_error),
                    error(403, "Explicit live payout opt-in and payouts:write scope required"),
                    error(403, "Les opérations crypto sont désactivées"),
                    error(400, "Cryptomonnaie ou réseau non pris en charge"),
                    error(400, "Solde insuffisant (frais inclus)"),
                ],
            },
        }

        list_paths = {
            "/api/integration/v1/deposits",
            "/api/integration/v1/payouts",
            "/api/integration/v1/exchanges",
            "/api/integration/v1/links",
            "/api/integration/v1/transactions",
            "/api/integration/v1/crypto/deposits",
            "/api/integration/v1/crypto/payouts",
        }
        query_fields = {
            "/api/integration/v1/mobile-money/operators": [
                param("direction", "query", False, "string (deposit|payout)",
                      "Catalogue activé dans l’environnement servi ; les codes peuvent différer selon la direction.",
                      "deposit", "deposit"),
            ],
            "/api/integration/settings": [
                param("environment", "query", True, "string (test|live)",
                      "Choisir l’environnement des identifiants et de la configuration du webhook.",
                      "test"),
            ],
            "/api/integration/v1/exchanges/quote": [
                param("from_currency", "query", True, "string",
                      "Devise source prise en charge.", "XOF"),
                param("to_currency", "query", True, "string",
                      "Devise de destination prise en charge.", "XAF"),
                param("amount", "query", True, "number", "Montant à estimer.", 10000),
            ],
            "/api/integration/v1/crypto/assets": [
                param("direction", "query", False, "string (deposit|payout)",
                      "Filtrer les actifs réellement activés pour les dépôts ou les retraits dans l’environnement servi.",
                      "deposit", "deposit"),
            ],
        }
        for path in list_paths:
            query_fields[path] = [
                param("limit", "query", False, "integer",
                      "Nombre maximal de résultats à renvoyer (1 à 500).", 100, 100),
            ]
        query_fields["/api/integration/webhooks/{environment}/deliveries"] = [
            param("limit", "query", False, "integer",
                  "Nombre maximal de livraisons à renvoyer (1 à 200).", 50, 50),
        ]

        decorated = []
        # The public guide is for server-to-server integrations, not the
        # authenticated browser console that manages credentials and webhooks.
        for index, item in enumerate(ENDPOINTS):
            if item["auth_type"] not in {"bearer", "public"}:
                continue
            path, method = item["path"].split("?", 1)[0], item["method"]
            key = (method, path)
            params = []
            for variable in ("environment", "deposit_id", "payout_id",
                             "exchange_id", "link_id"):
                if "{" + variable + "}" in path:
                    description = (
                        "Identifiant d’environnement (test ou live) utilisé par cette route."
                        if variable == "environment"
                        else "Identifiant renvoyé par l’opération de création ou de liste correspondante."
                    )
                    params.append(param(variable, "path", True, "string",
                                        description, "live" if variable == "environment"
                                        else f"{variable.removesuffix('_id')}-example"))
            if method == "GET":
                params.extend(query_fields.get(path, []))
            schema = schemas.get(key, {})
            params.extend(schema.get("body", []))
            headers = []
            if item["auth_type"] == "bearer":
                headers = [
                    param("Authorization", "header", True, "string",
                          "Clé secrète Bearer associée à la clé X-Public-Key du même environnement.",
                          "Bearer $BIZ_SECRET_KEY"),
                    param("X-Public-Key", "header", True, "string",
                          "Clé publique d’intégration associée à la clé secrète Bearer.",
                          "$BIZ_PUBLIC_KEY"),
                ]
                if path.startswith("/api/integration/v1/") and method == "POST":
                    headers.append(param(
                        "Idempotency-Key", "header", True, "string",
                         "Clé unique de requête (1 à 120 caractères). À réutiliser uniquement pour une nouvelle tentative identique.",
                        "order-125"))
            elif item["auth_type"] != "public":
                headers = [param(
                    "Cookie", "header", True, "string",
                    "Cookie de session authentifiée Biz-transPay"
                    + (" et cookie btp_csrf pour les mutations effectuées depuis le navigateur."
                       if method != "GET" else ".")
                    + (" Une réauthentification récente est requise pour cette mutation."
                       if item["auth_type"] == "recent_session" else ""),
                    ("btp_session=$BIZ_SESSION_TOKEN; btp_csrf=$BIZ_CSRF_TOKEN"
                     if method != "GET" else "btp_session=$BIZ_SESSION_TOKEN"))]
                if method != "GET":
                    headers.append(param(
                        "X-CSRF-Token", "header", True, "string",
                        "Doit correspondre au cookie btp_csrf pour les mutations authentifiées par cookie.",
                        "$BIZ_CSRF_TOKEN"))
            if schema.get("body"):
                headers.append(param("Content-Type", "header", True, "string",
                                     "Corps de requête au format JSON.", "application/json"))

            request_body = schema.get("request")
            route_response = responses[key]
            route_errors = list(schema.get("errors", []))
            if item["auth_type"] == "bearer":
                required_scope = {
                    "/api/integration/v1/deposits": "deposits:write",
                    "/api/integration/v1/payouts": "payouts:write",
                    "/api/integration/v1/exchanges": "exchanges:write",
                    "/api/integration/v1/links": "links:write",
                    "/api/integration/v1/crypto/deposits": "deposits:write",
                    "/api/integration/v1/crypto/payouts": "payouts:write",
                }.get(path)
                route_scope_error = ({
                    "code": "INTEGRATION_SCOPE_REQUIRED",
                    "message": f"The {required_scope} scope is required.",
                    "required_scope": required_scope,
                } if required_scope else None)
                route_errors = common_bearer_errors + route_errors[
                    len(common_bearer_errors):] if schema else common_bearer_errors
                if method == "GET" and path not in {
                        "/api/integration/v1/exchanges/quote",
                        "/api/integration/v1/crypto/assets"}:
                    if any(token in path for token in (
                            "{deposit_id}", "{payout_id}", "{exchange_id}", "{link_id}")):
                        route_errors.append(error(404, "Operation not found"))
                    if path.endswith("/deposits/{deposit_id}"):
                        route_errors.append(error(404, "Not found"))
                    if path.endswith("/payouts/{payout_id}"):
                        route_errors.append(error(404, "Payout not found"))
                    if path.endswith("/exchanges/{exchange_id}"):
                        route_errors.append(error(404, "Exchange not found"))
                    if path.endswith("/payments"):
                        route_errors.append(error(404, "Link not found"))
                if method == "GET" and path in list_paths:
                    route_errors.append(query_error("limit"))
                if key == ("GET", "/api/integration/v1/exchanges/quote"):
                    route_errors.extend([
                        query_error("from_currency"), query_error("to_currency"),
                        query_error("amount"),
                        error(400, "Devises identiques"),
                        error(400, "Paire XOF→XAF non supportée"),
                        error(400, "Cette paire de conversion est désactivée"),
                    ])
                if method == "GET" and path == "/api/integration/settings":
                    route_errors.append(error(422, [{
                        "loc": ["query", "environment"],
                        "msg": "Input should be 'test' or 'live'",
                        "type": "literal_error",
                    }]))
                if method == "POST" and path.startswith("/api/integration/v1/"):
                    if not any(e["status"] == 400 and
                               e["example"].get("detail") == idempotency_required_error
                               for e in route_errors):
                        route_errors.append(error(400, idempotency_required_error))
                    route_errors.append(error(
                        409, "Idempotency-Key was used with a different request"))
                    route_errors.append(error(
                        409, "Operation outcome is uncertain; it will not be resubmitted. Retry later with the same Idempotency-Key."))
                    route_errors.append(error(422, validation_error))
                    if path != "/api/integration/v1/exchanges/quote":
                        route_errors.append(error(
                            503, "Sandbox transactions are unavailable: no isolated official provider test environment is configured. No funds were moved."))
                if route_scope_error and not any(
                        e["status"] == 403
                        and isinstance(e["example"].get("detail"), dict)
                        and e["example"]["detail"].get("code") == "INTEGRATION_SCOPE_REQUIRED"
                        for e in route_errors):
                    route_errors.append(error(403, route_scope_error))
                if route_scope_error:
                    for entry in route_errors:
                        detail = entry["example"].get("detail")
                        if (isinstance(detail, dict)
                                and detail.get("code") == "INTEGRATION_SCOPE_REQUIRED"):
                            entry["example"]["detail"] = route_scope_error
                # Remove duplicate status/detail entries while preserving the
                # precise alternatives that actually occur on each operation.
                unique_errors, seen_errors = [], set()
                for entry in route_errors:
                    signature = (entry["status"], json.dumps(
                        entry["example"], sort_keys=True, default=str))
                    if signature not in seen_errors:
                        seen_errors.add(signature)
                        unique_errors.append(entry)
                route_errors = unique_errors
            elif item["auth_type"] != "public":
                if not route_errors:
                    route_errors = list(
                        common_recent_session_errors
                        if item["auth_type"] == "recent_session"
                        else common_session_errors)
                if path.startswith("/api/integration/webhooks/") and path.endswith(
                        "/deliveries"):
                    route_errors.append(query_error("limit"))
                if path == "/api/integration/webhooks/{environment}/test":
                    route_errors.extend([
                        error(409, "Active webhook configuration required"),
                        error(422, "Webhook URL is not a safe public destination"),
                        error(502, {"message": "Webhook test delivery failed",
                                    "delivery_id": "delivery-id"}),
                        error(503, "Webhook delivery is not available"),
                    ])
                if path == "/api/integration/webhooks/{environment}/regenerate-secret":
                    route_errors.append(error(404, "Webhook configuration not found"))
                if path == "/api/integration/credentials/{environment}":
                    route_errors.append(error(404, "Integration credentials not found"))
                if "{environment}" in path:
                    route_errors.append(error(422, "environment must be test or live"))
                if method != "GET":
                    route_errors.extend([
                        error(403, {
                            "code": "CSRF_ORIGIN_REJECTED",
                            "message": "Origine de la requête non autorisée.",
                        }),
                        error(403, {
                            "code": "CSRF_TOKEN_INVALID",
                            "message": "Jeton CSRF absent ou invalide.",
                        }),
                    ])
            else:
                route_errors = []

            title = item["purpose"].rstrip(".")
            examples = {}
            example_path = path
            for variable, example_value in (
                    ("environment", "live"), ("deposit_id", "deposit-id"),
                    ("payout_id", "payout-id"), ("exchange_id", "exchange-id"),
                    ("link_id", "link-id")):
                example_path = example_path.replace(
                    "{" + variable + "}", example_value)
            query_values = [
                f"{field['name']}={field.get('example', '')}"
                for field in query_fields.get(path, [])
            ]
            query_string = ("?" + "&".join(query_values)) if query_values else ""
            relative_url = example_path + query_string
            base_headers = []
            for header in headers:
                if header["name"] == "Authorization":
                    base_headers.append(("Authorization", "Bearer $BIZ_SECRET_KEY"))
                elif header["name"] == "X-Public-Key":
                    base_headers.append(("X-Public-Key", "$BIZ_PUBLIC_KEY"))
                elif header["name"] == "Idempotency-Key":
                    base_headers.append(("Idempotency-Key", "order-125"))
                elif header["name"] == "Cookie":
                    base_headers.append(("Cookie", header["example"]))
                elif header["name"] == "X-CSRF-Token":
                    base_headers.append(("X-CSRF-Token", "$BIZ_CSRF_TOKEN"))
                elif header["name"] == "Content-Type":
                    base_headers.append(("Content-Type", "application/json"))
            curl_headers = " ".join(
                (f'-H "{name}: {value}"' if "$BIZ_" in value else
                 f"-H '{name}: {value}'")
                for name, value in base_headers)
            php_values = {
                "Authorization": "'Bearer ' . getenv('BIZ_SECRET_KEY')",
                "X-Public-Key": "getenv('BIZ_PUBLIC_KEY')",
                "Idempotency-Key": "'order-125'",
                "Cookie": (
                    "'btp_session=' . getenv('BIZ_SESSION_TOKEN')"
                    + (" . '; btp_csrf=' . getenv('BIZ_CSRF_TOKEN')"
                       if method != "GET" else "")),
                "X-CSRF-Token": "getenv('BIZ_CSRF_TOKEN')",
                "Content-Type": "'application/json'",
            }
            js_values = {
                "Authorization": "'Bearer ' + process.env.BIZ_SECRET_KEY",
                "X-Public-Key": "process.env.BIZ_PUBLIC_KEY",
                "Idempotency-Key": "'order-125'",
                "Cookie": (
                    "`btp_session=${process.env.BIZ_SESSION_TOKEN}`"
                    if method == "GET" else
                    "`btp_session=${process.env.BIZ_SESSION_TOKEN}; btp_csrf=${process.env.BIZ_CSRF_TOKEN}`"),
                "X-CSRF-Token": "process.env.BIZ_CSRF_TOKEN",
                "Content-Type": "'application/json'",
            }
            python_values = {
                "Authorization": "'Bearer ' + os.environ['BIZ_SECRET_KEY']",
                "X-Public-Key": "os.environ['BIZ_PUBLIC_KEY']",
                "Idempotency-Key": "'order-125'",
                "Cookie": (
                    "'btp_session=' + os.environ['BIZ_SESSION_TOKEN']"
                    + (" + '; btp_csrf=' + os.environ['BIZ_CSRF_TOKEN']"
                       if method != "GET" else "")),
                "X-CSRF-Token": "os.environ['BIZ_CSRF_TOKEN']",
                "Content-Type": "'application/json'",
            }
            php_headers = "[" + ", ".join(
                f"'{name}' => {php_values[name]}" for name, _ in base_headers) + "]"
            js_headers = "{" + ", ".join(
                f"{json.dumps(name)}: {js_values[name]}"
                for name, _ in base_headers) + "}"
            python_headers = "{" + ", ".join(
                f"{json.dumps(name)}: {python_values[name]}"
                for name, _ in base_headers) + "}"
            base_var = "getenv('BIZ_BASE_URL')"
            php_url = f"{base_var} . {json.dumps(relative_url)}"
            js_url = f"`${{baseUrl}}{relative_url}`"
            py_url = f"base_url + {relative_url!r}"
            body_json = (json.dumps(request_body, ensure_ascii=False,
                                    separators=(",", ":"))
                         if request_body is not None else None)
            if method == "GET":
                examples["curl"] = (
                    f'curl -X GET "$BIZ_BASE_URL{relative_url}"'
                    + (f" {curl_headers}" if curl_headers else ""))
                examples["php"] = (
                    "$client = new \\GuzzleHttp\\Client();\n"
                    f"$response = $client->get({php_url}, ['headers' => {php_headers}]);")
                examples["js"] = (
                    f"const baseUrl = process.env.BIZ_BASE_URL;\n"
                    f"const response = await fetch({js_url}, {{ headers: {js_headers} }});")
                examples["python"] = (
                    "import os, requests\n"
                    "base_url = os.environ['BIZ_BASE_URL']\n"
                    f"response = requests.get({py_url}, headers={python_headers})")
            else:
                curl_command = f'curl -X {method} "$BIZ_BASE_URL{relative_url}"'
                if curl_headers:
                    curl_command += " " + curl_headers
                if body_json is not None:
                    curl_command += f" -d '{body_json}'"
                examples["curl"] = curl_command
                options = f"['headers' => {php_headers}"
                js_options = f"method: '{method}', headers: {js_headers}"
                python_options = f"headers={python_headers}"
                if body_json is not None:
                    php_body = body_json.replace("\\", "\\\\").replace("'", "\\'")
                    options += f", 'json' => json_decode('{php_body}', true)"
                    js_options += f", body: JSON.stringify({body_json})"
                    python_options += f", json=json.loads({body_json!r})"
                options += "]"
                examples["php"] = (
                    "$client = new \\GuzzleHttp\\Client();\n"
                    f"$response = $client->{method.lower()}({php_url}, {options});")
                examples["js"] = (
                    f"const baseUrl = process.env.BIZ_BASE_URL;\n"
                    f"const response = await fetch({js_url}, {{{js_options}}});")
                examples["python"] = (
                    "import os, requests, json\n"
                    "base_url = os.environ['BIZ_BASE_URL']\n"
                    f"response = requests.{method.lower()}({py_url}, {python_options})")
            if path.startswith("/api/integration/v1/"):
                section = path.split("/")[4]
                if section == "mobile-money":
                    section = "mobile-money-discovery"
                if section not in {"deposits", "payouts", "exchanges", "links", "transactions", "crypto", "mobile-money-discovery"}:
                    raise ValueError(f"Undocumented integration section: {path}")
            elif path.startswith("/api/integration/webhooks/"):
                section = "webhooks"
            elif path.startswith("/api/integration/credentials") or path.startswith(
                    "/api/integration/settings"):
                section = "authentication"
            else:
                section = "startup"
            decorated.append({
                **{key_name: value for key_name, value in item.items()
                   if key_name != "auth_type"},
                "path": path, "id": f"integration-endpoint-{index}",
                "title": title, "description": item["purpose"],
                "section": section,
                "parameters": params + headers, "request": request_body,
                "response": route_response, "errors": route_errors,
                "examples": examples,
            })
        return {
            "title": "API d’intégration Biz-transPay",
            "documentation_url": "https://biz-transppayy.com/integration/docs",
            "api_base_url": "https://biz-transppayy.com",
            "description": (
                "Utilisez les routes d’intégration disponibles pour créer et consulter des dépôts, "
                "des retraits, des opérations de change, des liens de paiement et des opérations."
            ),
            "sections": [
                {"id": "startup", "title": "Bien démarrer", "description":
                 "Définissez BIZ_BASE_URL sur l’origine qui héberge cette API. Créez des identifiants distincts pour les environnements test et live depuis les paramètres d’intégration Biz-transPay ; la clé secrète n’est affichée qu’une fois. N’envoyez les deux clés que depuis un serveur de confiance."},
                {"id": "authentication", "title": "Authentification", "description":
                  "Les routes versionnées exigent Authorization: Bearer <clé secrète> et X-Public-Key du même environnement. Créez, renouvelez ou supprimez les clés dans la console du marchand ; stockez la clé secrète uniquement sur votre serveur. Pour connecter un autre agent, partagez cette documentation, jamais les clés secrètes dans une conversation ou un dépôt."},
                {"id": "sandbox", "title": "Environnements test et live", "description":
                 "L’estimation de change est accessible dans les deux environnements. Les routes de création financière refusent les identifiants test avec HTTP 503 tant qu’un environnement de test isolé et officiel du prestataire n’est pas configuré ; aucun fonds n’est déplacé. Les retraits exigent en plus une autorisation explicite en production et la portée payouts:write."},
                 {"id": "deposits", "title": "Dépôts", "description":
                  "POST /api/integration/v1/deposits lance un dépôt Mobile Money et renvoie {id,status,deposit}. Le montant demandé est le total payé par le client : pour 2 000 de paiement et 500 de frais, le client paie 2 000 et le portefeuille marchand reçoit 1 500. Le champ fee_bearer historique est accepté mais ignoré. La route GET par identifiant renvoie l’état public du dépôt ; la route de liste renvoie les enregistrements d’opération d’intégration. Envoyez Idempotency-Key lors de la création."},
                 {"id": "payouts", "title": "Retraits", "description":
                  "POST /api/integration/v1/payouts renvoie {id,status,payout} ; payout contient le résultat du transfert. Le bénéficiaire reçoit le montant demandé intact : pour 2 000 de retrait et 500 de frais, le portefeuille marchand est débité de 2 500 et le bénéficiaire reçoit 2 000. Le champ fee_bearer historique est accepté mais ignoré. Activez l’autorisation de retrait en production avant d’accorder payouts:write. Un état pending ne prouve pas que l’opération est terminée."},
                *burkina_guides(),
                {"id": "crypto", "title": "Cryptomonnaies", "description":
                  "GET /api/integration/v1/crypto/assets?direction=deposit|payout liste les actifs et réseaux actifs (asset_code) de l’environnement servi ; les clés test peuvent consulter ce catalogue, mais ne peuvent pas créer d’opération. POST /crypto/deposits crée une adresse de paiement à transmettre au payeur avec le montant amount_to_send, le réseau et, si nécessaire, le mémo ; seuls les dépôts confirmés sont crédités dans le portefeuille crypto/réseau du marchand. POST /crypto/payouts débite le portefeuille réseau correspondant puis lance un retrait on-chain ; la réponse pending ne signifie pas que le retrait est confirmé. Les montants acceptent au plus 6 décimales ; sender ajoute les frais au débit, receiver les déduit du montant reçu si le net est aussi représentable à 6 décimales. Les deux créations exigent Idempotency-Key et les portées deposits:write ou payouts:write ; les retraits exigent aussi l’autorisation explicite en production. Les routes GET par identifiant donnent l’état courant ; les listes renvoient les opérations de l’intégration. Le statut confirmed d’un dépôt, ou completed d’un retrait, signale la réussite. Les webhooks crypto_deposit.pending/success/failed et crypto_payout.pending/success/failed sont signés et émis avec l’identifiant et l’état ; vérifiez la signature et l’événement, puis consultez GET avant de finaliser une commande. Si pending_manual vaut true ou si le dépôt n’a pas encore d’adresse, ne transférez rien et demandez une vérification de l’opération ; les fonds d’un retrait incertain restent réservés. Ne réémettez pas un paiement sur une nouvelle clé si l’issue est incertaine. Les actifs désactivés ne sont plus proposés pour de nouvelles opérations, mais l’historique reste consultable."},
                {"id": "exchanges", "title": "Change", "description":
                 "GET /api/integration/v1/exchanges/quote renvoie from_currency, to_currency, amount, fee, rate, received et fee_currency. POST effectue l’opération de change et renvoie son résultat terminé avec la transaction du registre."},
                {"id": "links", "title": "Liens de paiement", "description":
                 "POST /api/integration/v1/links renvoie {id,status,link} ; les routes de liste renvoient des enregistrements d’opération. GET /links/{link_id}/payments liste les paiements associés au lien."},
                {"id": "transactions", "title": "Opérations et états", "description":
                 "GET /api/integration/v1/transactions liste les opérations pour le propriétaire et l’environnement des identifiants. Utilisez les routes GET propres à chaque ressource pour consulter l’état actuel d’un dépôt, d’un retrait ou d’une opération de change. Seuls completed/approved/paid/success indiquent une réussite ; pending n’est pas un état final."},
                {"id": "security", "title": "Sécurité", "description":
                  "Conservez les clés secrètes et les secrets de signature des webhooks côté serveur. Renouvelez les identifiants exposés et n’accordez que les portées nécessaires. Utilisez une Idempotency-Key unique par nouvelle opération ; en cas de résultat incertain, consultez l’état et réessayez uniquement la requête identique avec la même clé. Ne lancez pas une seconde opération avec une nouvelle clé."},
                {"id": "integration-examples", "title": "Exemples d’intégration", "description":
                 "Chaque route ci-dessous comporte un exemple de requête en cURL, PHP, JavaScript et Python. Les exemples utilisent BIZ_BASE_URL et des variables d’environnement pour les identifiants ; ne modifiez que les valeurs acceptées par le schéma de la route.",
                 "examples": {
                     "curl": """curl -X POST "$BIZ_BASE_URL/api/integration/v1/deposits" -H "Authorization: Bearer $BIZ_SECRET_KEY" -H "X-Public-Key: $BIZ_PUBLIC_KEY" -H "Idempotency-Key: order-125" -H "Content-Type: application/json" -d '{"amount":10000,"currency":"XOF","country":"TG","operator":"tmoney_tg","phone_number":"90000000","email":"buyer@example.com","full_name":"Buyer"}'""",
                     "php": "$response = $client->post(getenv('BIZ_BASE_URL') . '/api/integration/v1/deposits', ['headers' => ['Authorization' => 'Bearer ' . getenv('BIZ_SECRET_KEY'), 'X-Public-Key' => getenv('BIZ_PUBLIC_KEY'), 'Idempotency-Key' => 'order-125'], 'json' => ['amount' => 10000, 'currency' => 'XOF', 'country' => 'TG', 'operator' => 'tmoney_tg', 'phone_number' => '90000000', 'email' => 'buyer@example.com', 'full_name' => 'Buyer']]);",
                     "js": "const response = await fetch(`${process.env.BIZ_BASE_URL}/api/integration/v1/deposits`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.BIZ_SECRET_KEY}`, 'X-Public-Key': process.env.BIZ_PUBLIC_KEY, 'Idempotency-Key': 'order-125', 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 10000, currency: 'XOF', country: 'TG', operator: 'tmoney_tg', phone_number: '90000000', email: 'buyer@example.com', full_name: 'Buyer' }) });",
                     "python": "response = requests.post(os.environ['BIZ_BASE_URL'] + '/api/integration/v1/deposits', headers={'Authorization': 'Bearer ' + os.environ['BIZ_SECRET_KEY'], 'X-Public-Key': os.environ['BIZ_PUBLIC_KEY'], 'Idempotency-Key': 'order-125'}, json={'amount': 10000, 'currency': 'XOF', 'country': 'TG', 'operator': 'tmoney_tg', 'phone_number': '90000000', 'email': 'buyer@example.com', 'full_name': 'Buyer'})",
                 }},
                 {"id": "webhooks", "title": "Webhooks et vérification de signature", "description":
                  "Un environnement peut avoir plusieurs destinations webhook, chacune avec son propre secret de signature ; les mêmes identifiants API restent partagés pour cet environnement. Chaque événement est envoyé à toutes les destinations actives. La charge utile correspond exactement au corps JSON brut reçu. Vérifiez que X-BizTransPay-Timestamp date de moins de 300 secondes, puis comparez X-BizTransPay-Signature en temps constant à sha256=HMAC-SHA256(secret, timestamp + '.' + raw_body). L’identifiant de l’événement figure dans X-BizTransPay-Event-Id et dans la propriété JSON id ; utilisez-le pour éviter les doublons.",
                 "examples": {
                     "php": "$rawBody = file_get_contents('php://input');\n$timestamp = $_SERVER['HTTP_X_BIZTRANSPAY_TIMESTAMP'] ?? '';\n$signature = $_SERVER['HTTP_X_BIZTRANSPAY_SIGNATURE'] ?? '';\nif (!ctype_digit($timestamp) || abs(time() - (int)$timestamp) > 300) { http_response_code(401); exit; }\n$expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $webhookSecret);\nif (!hash_equals($expected, $signature)) { http_response_code(401); exit; }\n$event = json_decode($rawBody, true);",
                     "js": "import crypto from 'node:crypto';\nconst chunks = []; for await (const chunk of req) chunks.push(chunk);\nconst rawBody = Buffer.concat(chunks);\nconst timestamp = req.headers['x-biztranspay-timestamp'] || '';\nconst signature = req.headers['x-biztranspay-signature'] || '';\nif (!/^\\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('stale timestamp');\nconst expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(Buffer.concat([Buffer.from(timestamp + '.'), rawBody])).digest('hex');\nconst a = Buffer.from(expected); const b = Buffer.from(signature);\nif (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('invalid signature');\nconst event = JSON.parse(rawBody.toString('utf8'));",
                     "python": "import time, hmac, hashlib, json\nraw_body = request.get_data(cache=True)\ntimestamp = request.headers.get('X-BizTransPay-Timestamp', '')\nsignature = request.headers.get('X-BizTransPay-Signature', '')\nif not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:\n    abort(401)\nexpected = 'sha256=' + hmac.new(webhook_secret.encode(), timestamp.encode() + b'.' + raw_body, hashlib.sha256).hexdigest()\nif not hmac.compare_digest(expected, signature):\n    abort(401)\nevent = json.loads(raw_body)",
                 }},
                {"id": "http", "title": "Codes de réponse HTTP", "description":
                  "200 : requête acceptée ou ressource renvoyée. 400 : Idempotency-Key invalide ou absente, ou condition métier non satisfaite. 401 : identifiants absents ou invalides. 403 : clé désactivée, portée manquante, compte non marchand ou autorisation de retrait absente. 404 : opération ou ressource appartenant au propriétaire introuvable. 409 : conflit ou issue incertaine d’idempotence. 422 : paramètres ou corps invalides. 429 : limite de débit atteinte. 502 : échec du prestataire. 503 : environnement de test ou prestataire indisponible."},
                {"id": "errors", "title": "Erreurs et nouvelles tentatives", "description":
                 "Les corps d’erreur suivent la structure FastAPI {detail: ...}. Les erreurs de validation contiennent un tableau d’erreurs de champ ; les erreurs de portée et d’Idempotency-Key absente utilisent les objets detail structurés indiqués pour chaque route. Réutilisez une même Idempotency-Key uniquement pour une requête identique ; une issue incertaine 409 n’autorise pas à soumettre une seconde opération. Exception explicite : après HTTP 400 OTP_REQUIRED avant toute soumission de dépôt, vous pouvez compléter otp avec la même clé, selon le guide Orange Burkina."},
            ],
            "endpoints": decorated,
        }

    @router.get("/documentation")
    async def documentation():
        return documentation_payload()

    @router.get("/documentation.pdf")
    async def documentation_pdf():
        from io import BytesIO
        from xml.sax.saxutils import escape
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_LEFT
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted,
        )

        payload = documentation_payload()
        output = BytesIO()
        doc = SimpleDocTemplate(
            output, pagesize=A4, rightMargin=17 * mm, leftMargin=17 * mm,
            topMargin=17 * mm, bottomMargin=17 * mm,
            title=payload["title"], author="Biz-transPay",
        )
        styles = getSampleStyleSheet()
        styles.add(ParagraphStyle(name="Endpoint", parent=styles["Heading2"],
                                  fontSize=11, leading=14, textColor=colors.HexColor("#12345a")))
        styles.add(ParagraphStyle(name="SmallBody", parent=styles["BodyText"],
                                  fontSize=8.5, leading=11))
        styles.add(ParagraphStyle(name="CodeSmall", fontName="Courier",
                                  fontSize=6.5, leading=8, wordWrap="CJK"))
        story = [
            Paragraph(escape(payload["title"]), styles["Title"]),
            Paragraph(escape(payload["description"]), styles["BodyText"]),
            Paragraph("Documentation publique : " + escape(payload["documentation_url"]),
                      styles["BodyText"]),
            Paragraph("URL de base API : " + escape(payload["api_base_url"]),
                      styles["BodyText"]),
            Spacer(1, 8),
        ]
        for section in payload["sections"]:
            story.extend([
                Paragraph(escape(section["title"]), styles["Heading1"]),
                Paragraph(escape(section["description"]), styles["BodyText"]),
                Spacer(1, 5),
            ])
            for language, code in section.get("examples", {}).items():
                story.extend([
                    Paragraph(escape(language.upper()), styles["SmallBody"]),
                    Preformatted(escape(code), styles["CodeSmall"]),
                ])
        story.append(Paragraph("Référence des endpoints implémentés", styles["Heading1"]))
        for endpoint in payload["endpoints"]:
            story.append(Paragraph(
                f"{escape(endpoint['method'])} &nbsp; {escape(endpoint['path'])}",
                styles["Endpoint"]))
            story.append(Paragraph(
                f"{escape(endpoint['description'])}<br/>"
                f"<b>Authentification :</b> {escape(endpoint['auth'])}",
                styles["SmallBody"]))
            if endpoint["parameters"]:
                rows = [["Paramètre / en-tête", "Description"]]
                rows.extend([[escape(p["name"]), escape(p["description"])]
                             for p in endpoint["parameters"]])
                table = Table(rows, colWidths=[42 * mm, 125 * mm], repeatRows=1)
                table.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eef5")),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#bdc7d3")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                    ("LEADING", (0, 0), (-1, -1), 9),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]))
                story.extend([Spacer(1, 3), table])
            if endpoint["request"] is not None:
                story.extend([
                    Paragraph("<b>Exemple de requête JSON</b>", styles["SmallBody"]),
                    Preformatted(json.dumps(endpoint["request"], ensure_ascii=False, indent=2),
                                 styles["CodeSmall"]),
                ])
            story.append(Paragraph(
                "<b>Réponse illustrative :</b> " +
                escape(json.dumps(endpoint["response"], ensure_ascii=False)),
                styles["SmallBody"]))
            story.append(Paragraph(
                "<b>Erreurs possibles :</b> " + escape(", ".join(
                    f"{e['status']} — {e['description']} "
                    f"{json.dumps(e['example'], ensure_ascii=False)}"
                    for e in endpoint["errors"])),
                styles["SmallBody"]))
            for language, code in endpoint["examples"].items():
                story.extend([
                    Paragraph(escape(language.upper()), styles["SmallBody"]),
                    Preformatted(escape(code), styles["CodeSmall"]),
                ])
            story.append(Spacer(1, 8))
        doc.build(story)
        return Response(output.getvalue(), media_type="application/pdf",
                        headers={"Content-Disposition": 'attachment; filename="biz-transpay-api.pdf"'})

    router.include_router(v1)
    return router