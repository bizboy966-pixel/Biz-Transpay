"""Crash-safe referral qualification and commission service."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import re
from typing import Any

from pymongo.errors import DuplicateKeyError


REQUIRED_REFERRALS = 5
DEFAULT_RATE_PERCENT = 2.0
MIN_RATE_PERCENT = 2.0
MAX_RATE_PERCENT = 2.5
CLAIM_ID_PREFIX = "referral:"
COMMISSION_OPERATION_PREFIX = "referral-commission:"


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalized_phone(user: dict, kyc: dict) -> str:
    phone = user.get("phone") or user.get("phone_number") or kyc.get("phone") or ""
    return re.sub(r"\D", "", str(phone))


def _identity(user: dict, kyc: dict) -> tuple[str, str, str] | None:
    country = str(kyc.get("country") or user.get("country") or "").strip().upper()
    document_type = str(
        kyc.get("document_type") or user.get("document_type") or ""
    ).strip().lower()
    number = kyc.get("document_number") or user.get("document_number") or ""
    normalized_number = re.sub(r"[^A-Z0-9]", "", str(number).upper())
    if not country or not document_type or not normalized_number:
        return None
    return country, document_type, normalized_number


def _is_blocked(user: dict) -> bool:
    status = str(user.get("status") or "").lower()
    return bool(
        user.get("banned")
        or user.get("is_banned")
        or user.get("blocked")
        or user.get("is_blocked")
        or status in {"banned", "blocked", "suspended"}
    )


def _net_amount(tx: dict) -> Decimal | None:
    metadata = tx.get("metadata") or {}
    raw = metadata.get("amount_net", metadata.get("net_amount", tx.get("amount")))
    try:
        amount = Decimal(str(raw))
    except Exception:
        return None
    if not amount.is_finite() or amount <= 0:
        return None
    return amount


def _eligible_shape(tx: dict) -> bool:
    metadata = tx.get("metadata") or {}
    if tx.get("status") != "completed" or tx.get("direction") != "in":
        return False
    if str(tx.get("type") or "").lower() not in {
        "deposit", "link_payment", "payment"
    }:
        return False
    if str(tx.get("currency") or "").upper() not in {"XOF", "XAF"}:
        return False
    if _net_amount(tx) is None:
        return False
    if metadata.get("admin_id") or metadata.get("operation_id") == "admin-balance":
        return False
    if not tx.get("id") or not tx.get("user_id"):
        return False
    return True


async def _build_identity_index(db) -> dict:
    """Load KYC identity data once for reuse throughout an event or reconcile batch."""
    users = await db.users.find({}, {
        "_id": 0, "id": 1, "kyc_status": 1, "status": 1, "banned": 1,
        "is_banned": 1, "blocked": 1, "is_blocked": 1, "phone": 1,
        "phone_number": 1, "country": 1, "document_type": 1,
        "document_number": 1, "referred_by_user_id": 1,
        "referral_first_tx_id": 1, "referral_first_amount": 1,
        "referral_first_currency": 1, "referral_qualified_at": 1,
    }).to_list(None)
    kyc_rows = await db.kyc.find({}, {
        "_id": 0, "user_id": 1, "phone": 1, "country": 1,
        "document_type": 1, "document_number": 1, "verified_at": 1,
        "status": 1,
    }).to_list(None)
    users_by_id = {str(user["id"]): user for user in users if user.get("id")}
    kyc_by_user = {}
    for kyc in kyc_rows:
        user_id = str(kyc.get("user_id") or "")
        if (user_id and user_id not in kyc_by_user
                and kyc.get("status") == "verified"
                and _parse_time(kyc.get("verified_at")) is not None):
            kyc_by_user[user_id] = kyc

    details_by_user = {}
    phone_users: dict[str, set[str]] = {}
    identity_users: dict[tuple[str, str, str], set[str]] = {}
    for user_id, user in users_by_id.items():
        kyc = kyc_by_user.get(user_id)
        if (not kyc or user.get("kyc_status") != "verified"
                or _is_blocked(user)):
            continue
        verified_at = _parse_time(kyc.get("verified_at"))
        if verified_at is None:
            continue
        phone = _normalized_phone(user, kyc)
        identity = _identity(user, kyc)
        details_by_user[user_id] = (kyc, verified_at, phone, identity)
        if phone:
            phone_users.setdefault(phone, set()).add(user_id)
        if identity is not None:
            identity_users.setdefault(identity, set()).add(user_id)
    return {
        "users_by_id": users_by_id,
        "details_by_user": details_by_user,
        "phone_users": phone_users,
        "identity_users": identity_users,
    }


def _identity_is_unique(index: dict, user_id: str, phone: str,
                        identity: tuple[str, str, str] | None) -> bool:
    if phone and index["phone_users"].get(phone, set()) - {user_id}:
        return False
    if identity is not None and index["identity_users"].get(identity, set()) - {user_id}:
        return False
    return True


def _eligible_candidate(tx: dict, index: dict) -> tuple[dict, Decimal, str] | None:
    if not _eligible_shape(tx):
        return None
    user = index["users_by_id"].get(str(tx["user_id"]))
    if not user or not user.get("referred_by_user_id"):
        return None
    details = index["details_by_user"].get(str(user["id"]))
    if details is None:
        return None
    _, verified_at, phone, identity = details
    tx_time = _parse_time(tx.get("completed_at") or tx.get("created_at"))
    if tx_time is None or tx_time <= verified_at:
        return None
    if not _identity_is_unique(index, str(user["id"]), phone, identity):
        return None
    amount = _net_amount(tx)
    assert amount is not None
    return user, amount, str(tx.get("currency")).upper()


def _earliest_eligible_transaction(rows: list[dict], index: dict):
    ordered = sorted(rows, key=lambda row: (
        _parse_time(row.get("completed_at") or row.get("created_at"))
        or datetime.max.replace(tzinfo=timezone.utc),
        str(row.get("id") or ""),
    ))
    for row in ordered:
        candidate = _eligible_candidate(row, index)
        if candidate is not None:
            return row, candidate
    return None


def _qualified_candidates(users: list[dict], index: dict, sponsor_id: str) -> list[dict]:
    candidates = []
    for user in users:
        if user.get("referred_by_user_id") != sponsor_id or not user.get("referral_first_tx_id"):
            continue
        details = index["details_by_user"].get(str(user.get("id")))
        if details is None:
            continue
        _, _, phone, identity = details
        if not _identity_is_unique(index, str(user.get("id")), phone, identity):
            continue
        amount = _net_amount({"amount": user.get("referral_first_amount")})
        currency = str(user.get("referral_first_currency") or "").upper()
        when = _parse_time(user.get("referral_qualified_at"))
        if amount is None or currency not in {"XOF", "XAF"} or when is None:
            continue
        candidates.append({
            "user_id": str(user["id"]),
            "tx_id": str(user.get("referral_first_tx_id")),
            "amount": amount,
            "currency": currency,
            "qualified_at": when,
        })
    return sorted(candidates, key=lambda row: (row["qualified_at"], row["tx_id"], row["user_id"]))


async def _rate_value(db) -> float:
    setting = await db.referral_settings.find_one({"id": "referral_settings"}, {"_id": 0})
    if not setting:
        return DEFAULT_RATE_PERCENT
    try:
        rate = float(setting["rate_percent"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Stored referral rate is invalid")
    if not MIN_RATE_PERCENT <= rate <= MAX_RATE_PERCENT:
        raise ValueError("Stored referral rate is outside the allowed range")
    return rate


async def _complete_claim(db, claim: dict, credit_wallet_once, record_tx) -> dict:
    sponsor_id = str(claim["sponsor_id"])
    currency = str(claim["currency"]).upper()
    amount = Decimal(str(claim["amount"])).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    if currency not in {"XOF", "XAF"} or amount <= 0:
        raise ValueError("Invalid pending referral commission")
    sponsor = await db.users.find_one(
        {"id": sponsor_id},
        {"_id": 0, "id": 1, "status": 1, "banned": 1, "is_banned": 1,
         "blocked": 1, "is_blocked": 1},
    )
    if sponsor is None:
        raise RuntimeError("Referral commission sponsor does not exist")
    if _is_blocked(sponsor):
        return claim
    operation_id = claim.get("operation_id") or f"{COMMISSION_OPERATION_PREFIX}{sponsor_id}"
    field = "balance_xof" if currency == "XOF" else "balance_xaf"
    credited = await credit_wallet_once(sponsor_id, field, float(amount), operation_id)
    if not credited:
        wallet = await db.users.find_one(
            {"id": sponsor_id},
            {"_id": 0, "id": 1, "wallet_credit_operation_ids": 1},
        )
        if not wallet or operation_id not in (wallet.get("wallet_credit_operation_ids") or []):
            raise RuntimeError("Referral commission wallet credit was not applied")
    await record_tx(
        sponsor_id, "referral_commission", "in", float(amount), currency,
        operation_id=operation_id,
        metadata={
            "referral_sponsor_id": sponsor_id,
            "referral_candidate_user_id": claim.get("candidate_user_id"),
            "referral_candidate_tx_id": claim.get("candidate_tx_id"),
            "rate_percent": claim["rate_percent"],
        },
    )
    completed_at = _now_iso()
    await db.referral_commissions.update_one(
        {"id": claim["id"], "status": "pending"},
        {"$set": {"status": "completed", "completed_at": completed_at}},
    )
    completed = await db.referral_commissions.find_one({"id": claim["id"]}, {"_id": 0})
    if not completed:
        raise RuntimeError("Referral commission claim disappeared during completion")
    return completed


async def _award_if_ready(db, sponsor_id, credit_wallet_once, record_tx,
                          identity_index: dict, users: list[dict]):
    claim_id = f"{CLAIM_ID_PREFIX}{sponsor_id}"
    existing = await db.referral_commissions.find_one({"id": claim_id}, {"_id": 0})
    if existing:
        if existing.get("status") == "completed":
            return existing
        return await _complete_claim(db, existing, credit_wallet_once, record_tx)

    qualified = _qualified_candidates(users, identity_index, str(sponsor_id))
    if len(qualified) < REQUIRED_REFERRALS:
        return None
    first_five = qualified[:REQUIRED_REFERRALS]
    chosen = min(first_five, key=lambda item: (item["amount"], item["qualified_at"], item["tx_id"], item["user_id"]))
    rate = await _rate_value(db)
    commission_amount = (
        (chosen["amount"] * Decimal(str(rate)) / Decimal("100"))
        .quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    )
    if commission_amount <= 0:
        return None
    claim = {
        "id": claim_id,
        "sponsor_id": str(sponsor_id),
        "status": "pending",
        "amount": float(commission_amount),
        "currency": chosen["currency"],
        "rate_percent": rate,
        "candidate_user_id": chosen["user_id"],
        "candidate_tx_id": chosen["tx_id"],
        "candidate_net_amount": float(chosen["amount"]),
        "candidate_currency": chosen["currency"],
        "qualified_user_ids": [item["user_id"] for item in first_five],
        "operation_id": f"{COMMISSION_OPERATION_PREFIX}{sponsor_id}",
        "created_at": _now_iso(),
    }
    try:
        await db.referral_commissions.insert_one(claim)
    except DuplicateKeyError:
        existing = await db.referral_commissions.find_one({"id": claim_id}, {"_id": 0})
        if not existing:
            raise
        claim = existing
    if claim.get("status") == "completed":
        return claim
    return await _complete_claim(db, claim, credit_wallet_once, record_tx)


async def award_if_ready(db, sponsor_id, credit_wallet_once, record_tx):
    """Freeze and pay a sponsor's first-five commission, idempotently."""
    identity_index = await _build_identity_index(db)
    users = list(identity_index["users_by_id"].values())
    return await _award_if_ready(
        db, sponsor_id, credit_wallet_once, record_tx, identity_index, users
    )


async def _qualify_user(db, user: dict, transaction_rows: list[dict],
                        identity_index: dict) -> bool:
    earliest = _earliest_eligible_transaction(transaction_rows, identity_index)
    if earliest is None:
        return False
    chosen_tx, candidate = earliest
    qualified_user, amount, currency = candidate
    qualified_at = _parse_time(
        chosen_tx.get("completed_at") or chosen_tx.get("created_at")
    )
    if qualified_at is None:
        return False
    result = await db.users.update_one(
        {"id": qualified_user["id"], "referral_first_tx_id": {"$exists": False}},
        {"$set": {
            "referral_first_tx_id": str(chosen_tx["id"]),
            "referral_first_amount": float(amount),
            "referral_first_currency": currency,
            "referral_qualified_at": qualified_at.isoformat(),
        }},
    )
    if result.modified_count:
        qualified_user.update({
            "referral_first_tx_id": str(chosen_tx["id"]),
            "referral_first_amount": float(amount),
            "referral_first_currency": currency,
            "referral_qualified_at": qualified_at.isoformat(),
        })
        return True
    persisted = await db.users.find_one(
        {"id": qualified_user["id"]},
        {"_id": 0, "referral_first_tx_id": 1, "referral_first_amount": 1,
         "referral_first_currency": 1, "referral_qualified_at": 1},
    )
    if persisted and persisted.get("referral_first_tx_id"):
        qualified_user.update(persisted)
        return True
    return False


async def process_transaction(db, tx: dict, credit_wallet_once, record_tx):
    """Record a referee's immutable earliest eligible transaction, then award."""
    if not _eligible_shape(tx):
        return None
    # Most payments are not referrals. Avoid scanning the platform's KYC and
    # transaction history on the synchronous settlement path for those users.
    referral = await db.users.find_one(
        {"id": str(tx["user_id"])},
        {"_id": 0, "id": 1, "referred_by_user_id": 1,
         "referral_first_tx_id": 1},
    )
    if not referral or not referral.get("referred_by_user_id"):
        return None
    if referral.get("referral_first_tx_id"):
        claim = await db.referral_commissions.find_one(
            {"id": f"{CLAIM_ID_PREFIX}{referral['referred_by_user_id']}"},
            {"_id": 0, "status": 1},
        )
        if claim and claim.get("status") == "completed":
            return None
    identity_index = await _build_identity_index(db)
    user = identity_index["users_by_id"].get(str(tx["user_id"]))
    if not user or not user.get("referred_by_user_id"):
        return None
    if not user.get("referral_first_tx_id"):
        user_rows = await db.transactions.find(
            {"user_id": str(tx["user_id"]), "status": "completed"},
            {"_id": 0, "id": 1, "user_id": 1, "type": 1, "direction": 1,
             "amount": 1, "currency": 1, "status": 1, "created_at": 1,
             "completed_at": 1, "metadata": 1},
        ).to_list(None)
        if not any(str(row.get("id")) == str(tx.get("id")) for row in user_rows):
            user_rows.append(tx)
        await _qualify_user(db, user, user_rows, identity_index)
    return await _award_if_ready(
        db, user["referred_by_user_id"], credit_wallet_once, record_tx,
        identity_index, list(identity_index["users_by_id"].values()),
    )


async def reconcile(db, credit_wallet_once, record_tx):
    """Repair referral work in one transaction scan and one identity-index pass."""
    pending = await db.referral_commissions.find(
        {"status": "pending"}, {"_id": 0}
    ).to_list(None)
    for claim in pending:
        await _complete_claim(db, claim, credit_wallet_once, record_tx)

    identity_index = await _build_identity_index(db)
    users = list(identity_index["users_by_id"].values())
    transactions = await db.transactions.find(
        {"status": "completed"},
        {"_id": 0, "id": 1, "user_id": 1, "type": 1, "direction": 1,
         "amount": 1, "currency": 1, "status": 1, "created_at": 1,
         "completed_at": 1, "metadata": 1},
    ).to_list(None)
    transactions_by_user: dict[str, list[dict]] = {}
    for tx in transactions:
        if tx.get("user_id"):
            transactions_by_user.setdefault(str(tx["user_id"]), []).append(tx)

    processed = 0
    sponsors = set()
    for user in users:
        if (user.get("kyc_status") != "verified"
                or user.get("referral_first_tx_id")
                or not user.get("referred_by_user_id")):
            continue
        rows = transactions_by_user.get(str(user.get("id")), [])
        if _earliest_eligible_transaction(rows, identity_index) is not None:
            if await _qualify_user(db, user, rows, identity_index):
                sponsors.add(user["referred_by_user_id"])
            processed += 1

    sponsors.update(
        user["referred_by_user_id"] for user in users
        if user.get("referred_by_user_id") and user.get("referral_first_tx_id")
    )
    for sponsor_id in sponsors:
        await _award_if_ready(
            db, sponsor_id, credit_wallet_once, record_tx, identity_index, users
        )
    return {"pending_repaired": len(pending),
            "users_checked": sum(bool(u.get("referred_by_user_id")) for u in users),
            "transactions_checked": processed, "sponsors_checked": len(sponsors)}


async def get_summary(db, user_id) -> dict:
    """Return sponsor-only aggregate referral status (no invitee data)."""
    sponsor = await db.users.find_one(
        {"id": str(user_id)}, {"_id": 0, "id": 1}
    )
    if not sponsor:
        raise ValueError("Referral sponsor not found")
    identity_index = await _build_identity_index(db)
    users = list(identity_index["users_by_id"].values())
    qualified = _qualified_candidates(
        users,
        identity_index,
        str(user_id),
    )
    claim = await db.referral_commissions.find_one(
        {"id": f"{CLAIM_ID_PREFIX}{user_id}"}, {"_id": 0}
    )
    commission = None
    if claim:
        commission = {
            "status": claim.get("status"),
            "amount": claim.get("amount"),
            "currency": claim.get("currency"),
            "rate_percent": claim.get("rate_percent"),
        }
    return {
        "code": sponsor["id"],
        "invited_count": sum(
            user.get("referred_by_user_id") == str(user_id) for user in users
        ),
        "qualified_count": len(qualified),
        "required_count": REQUIRED_REFERRALS,
        "commission": commission,
    }


async def get_rate(db) -> dict:
    return {"rate_percent": await _rate_value(db)}


async def set_rate(db, rate_percent) -> dict:
    try:
        rate = float(rate_percent)
    except (TypeError, ValueError):
        raise ValueError("Referral rate must be numeric")
    if not MIN_RATE_PERCENT <= rate <= MAX_RATE_PERCENT:
        raise ValueError("Referral rate must be between 2 and 2.5 percent")
    await db.referral_settings.update_one(
        {"id": "referral_settings"},
        {"$set": {"rate_percent": rate, "updated_at": _now_iso()},
         "$setOnInsert": {"id": "referral_settings"}},
        upsert=True,
    )
    return {"rate_percent": rate}