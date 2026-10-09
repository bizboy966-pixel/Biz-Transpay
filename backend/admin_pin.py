"""Account-bound administrator PINs; never a replacement for sensitive-action MFA."""
import asyncio
import hashlib
import hmac
import re
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
import auth

MAX_FAILURES = 5
LOCK_SECONDS = 15 * 60


def _pin_material(user_id: str, pin: str) -> str:
    if not re.fullmatch(r"[0-9]{6}", pin or ""):
        raise ValueError("Le PIN doit contenir exactement six chiffres.")
    # A server-side pepper prevents offline enumeration of the small PIN space.
    return hmac.new(
        auth._fernet_key(),
        f"admin-login-pin:{user_id}:{pin}".encode(),
        hashlib.sha256,
    ).hexdigest()


def hash_pin(user_id: str, pin: str) -> str:
    return auth.hash_password(_pin_material(user_id, pin))


async def verify_pin(db, user: dict, pin: str) -> bool:
    uid = user["id"]
    hashed = user.get("admin_pin_hash")
    if not hashed:
        return False
    now = datetime.now(timezone.utc)
    locked_until = user.get("admin_pin_locked_until")
    if isinstance(locked_until, str):
        locked_until = datetime.fromisoformat(locked_until.replace("Z", "+00:00"))
    if locked_until and locked_until > now:
        seconds = max(1, int((locked_until - now).total_seconds()))
        raise HTTPException(
            429,
            detail={"code": "ADMIN_PIN_LOCKED",
                    "message": "PIN temporairement bloqué. Utilisez l’authentificateur ou réessayez plus tard.",
                    "retry_after": seconds},
            headers={"Retry-After": str(seconds)},
        )
    if locked_until:
        await db.users.update_one(
            {"id": uid, "admin_pin_hash": hashed,
             "admin_pin_locked_until": user["admin_pin_locked_until"]},
            {"$set": {"admin_pin_failures": 0},
             "$unset": {"admin_pin_locked_until": ""}},
        )
    try:
        material = _pin_material(uid, pin)
    except ValueError:
        material = ""
    valid = bool(material) and await asyncio.to_thread(
        auth.verify_password, material, hashed)
    if valid:
        # Compare-and-set rejects a PIN changed while bcrypt was running.
        result = await db.users.update_one(
            {"id": uid, "admin_pin_hash": hashed,
             "admin_pin_failures": {"$lt": MAX_FAILURES}},
            {"$set": {"admin_pin_failures": 0},
             "$unset": {"admin_pin_locked_until": ""}},
        )
        return result.matched_count == 1
    await db.users.update_one(
        {"id": uid, "admin_pin_hash": hashed},
        {"$inc": {"admin_pin_failures": 1}},
    )
    fresh = await db.users.find_one({"id": uid}, {"_id": 0})
    if fresh and fresh.get("admin_pin_hash") == hashed and int(
            fresh.get("admin_pin_failures", 0)) >= MAX_FAILURES:
        await db.users.update_one(
            {"id": uid, "admin_pin_hash": hashed,
             "admin_pin_failures": {"$gte": MAX_FAILURES}},
            {"$set": {"admin_pin_locked_until": now + timedelta(seconds=LOCK_SECONDS)}},
        )
    return False
