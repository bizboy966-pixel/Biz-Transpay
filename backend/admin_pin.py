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


def _pin_material(user_id: str, pin: str, purpose: str = "admin") -> str:
    if not re.fullmatch(r"[0-9]{6}", pin or ""):
        raise ValueError("Le PIN doit contenir exactement six chiffres.")
    # A server-side pepper prevents offline enumeration of the small PIN space.
    return hmac.new(
        auth._fernet_key(),
        f"{purpose}-login-pin:{user_id}:{pin}".encode(),
        hashlib.sha256,
    ).hexdigest()


def hash_pin(user_id: str, pin: str, purpose: str = "admin") -> str:
    return auth.hash_password(_pin_material(user_id, pin, purpose))


async def verify_pin(db, user: dict, pin: str, field_prefix: str = "admin_pin") -> bool:
    uid = user["id"]
    hash_key = f"{field_prefix}_hash"
    failures_key = f"{field_prefix}_failures"
    lock_key = f"{field_prefix}_locked_until"
    hashed = user.get(hash_key)
    if not hashed:
        return False
    now = datetime.now(timezone.utc)
    locked_until = user.get(lock_key)
    if isinstance(locked_until, str):
        locked_until = datetime.fromisoformat(locked_until.replace("Z", "+00:00"))
    if locked_until and locked_until > now:
        seconds = max(1, int((locked_until - now).total_seconds()))
        raise HTTPException(
            429,
            detail={
                "code": "ADMIN_PIN_LOCKED" if field_prefix == "admin_pin" else "USER_PIN_LOCKED",
                "message": (
                    "PIN temporairement bloqué. Utilisez l’authentificateur ou réessayez plus tard."
                    if field_prefix == "admin_pin"
                    else "Code PIN temporairement bloqué. Réessayez plus tard."
                ),
                    "retry_after": seconds},
            headers={"Retry-After": str(seconds)},
        )
    if locked_until:
        await db.users.update_one(
            {"id": uid, hash_key: hashed, lock_key: user[lock_key]},
            {"$set": {failures_key: 0}, "$unset": {lock_key: ""}},
        )
    try:
        material = _pin_material(
            uid, pin, "user" if field_prefix == "user_pin" else "admin")
    except ValueError:
        material = ""
    valid = bool(material) and await asyncio.to_thread(
        auth.verify_password, material, hashed)
    if valid:
        # Compare-and-set rejects a PIN changed while bcrypt was running.
        result = await db.users.update_one(
            {"id": uid, hash_key: hashed,
             failures_key: {"$lt": MAX_FAILURES}},
            {"$set": {failures_key: 0}, "$unset": {lock_key: ""}},
        )
        return result.matched_count == 1
    await db.users.update_one(
        {"id": uid, hash_key: hashed},
        {"$inc": {failures_key: 1}},
    )
    fresh = await db.users.find_one({"id": uid}, {"_id": 0})
    if fresh and fresh.get(hash_key) == hashed and int(
            fresh.get(failures_key, 0)) >= MAX_FAILURES:
        await db.users.update_one(
            {"id": uid, hash_key: hashed,
             failures_key: {"$gte": MAX_FAILURES}},
            {"$set": {lock_key: now + timedelta(seconds=LOCK_SECONDS)}},
        )
    return False
