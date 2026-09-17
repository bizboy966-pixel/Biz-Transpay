"""JWT auth utilities."""
import os
import jwt
import bcrypt
import base64
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

SECRET = os.environ.get("JWT_SECRET") or os.environ.get("SESSION_SECRET")
if not SECRET:
    raise RuntimeError(
        "JWT_SECRET or SESSION_SECRET must be configured; refusing to use a development JWT secret"
    )
ALGO = os.environ.get("JWT_ALGORITHM", "HS256")
EXPIRE_HOURS = int(os.environ.get("JWT_EXPIRE_HOURS", "168"))

bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


PASSWORD_MIN_LENGTH = 6


def password_policy_errors(password: str) -> list[str]:
    """Return user-safe password policy errors without exposing hash details."""
    value = password or ""
    errors = []
    if len(value) < PASSWORD_MIN_LENGTH:
        errors.append(f"au moins {PASSWORD_MIN_LENGTH} caractères")
    if len(value) > 72:
        errors.append("au maximum 72 caractères")
    if not any(char.islower() for char in value):
        errors.append("une lettre minuscule")
    if not any(char.isupper() for char in value):
        errors.append("une lettre majuscule")
    if not any(char.isdigit() for char in value):
        errors.append("un chiffre")
    if not any(not char.isalnum() and not char.isspace() for char in value):
        errors.append("un caractère spécial")
    if any(char.isspace() for char in value):
        errors.append("aucun espace")
    if value.lower() in {
        "password123!", "password123", "azerty123!", "azerty123",
        "admin123!", "123456789012", "qwerty123!",
    }:
        errors.append("un mot de passe moins courant")
    return errors


def admin_password_policy_errors(password: str) -> list[str]:
    """Stricter policy for administrator credentials."""
    errors = password_policy_errors(password)
    value = password or ""
    if len(value) < 14:
        errors.append("un mot de passe administrateur d'au moins 14 caractères")
    return list(dict.fromkeys(errors))


def _fernet_key() -> bytes:
    secret = os.environ.get("SESSION_SECRET") or SECRET
    return base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())


def encrypt_mfa_secret(value: str) -> str:
    from cryptography.fernet import Fernet
    return Fernet(_fernet_key()).encrypt(value.encode()).decode()


def decrypt_mfa_secret(value: str) -> str:
    from cryptography.fernet import Fernet
    return Fernet(_fernet_key()).decrypt(value.encode()).decode()


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _totp_counter(secret: str, timestamp: int) -> int:
    return int(timestamp // 30)


def totp_code(secret: str, timestamp: Optional[int] = None) -> str:
    timestamp = int(time.time()) if timestamp is None else int(timestamp)
    padded = secret.upper() + "=" * (-len(secret) % 8)
    key = base64.b32decode(padded)
    counter = _totp_counter(secret, timestamp).to_bytes(8, "big")
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    number = (int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF) % 1_000_000
    return f"{number:06d}"


def verify_totp(secret: str, code: str, last_counter: Optional[int] = None) -> Optional[int]:
    normalized = "".join(char for char in str(code or "") if char.isdigit())
    if len(normalized) != 6:
        return None
    current = _totp_counter(secret, int(time.time()))
    for counter in (current - 1, current, current + 1):
        if last_counter is not None and counter <= int(last_counter):
            continue
        if hmac.compare_digest(totp_code(secret, counter * 30), normalized):
            return counter
    return None


def totp_uri(secret: str, account: str, issuer: str = "Biz-transPay") -> str:
    from urllib.parse import quote
    return (
        f"otpauth://totp/{quote(issuer)}:{quote(account)}"
        f"?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"
    )


def create_mfa_token(user_id: str, purpose: str, **extra) -> str:
    payload = {
        "sub": user_id,
        "purpose": purpose,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        "iat": datetime.now(timezone.utc),
        **extra,
    }
    return jwt.encode(payload, SECRET, algorithm=ALGO)


def decode_mfa_token(token: str, purpose: str) -> dict:
    try:
        payload = jwt.decode(token, SECRET, algorithms=[ALGO])
        if payload.get("purpose") != purpose:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton de sécurité invalide")
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton de sécurité expiré")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton de sécurité invalide")


def create_token(user_id: str, session_id: Optional[str] = None) -> str:
    payload = {
        "sub": user_id,
        "sid": session_id,
        "typ": "session",
        "exp": datetime.now(timezone.utc) + timedelta(hours=EXPIRE_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, SECRET, algorithm=ALGO)


def decode_token_payload(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET, algorithms=[ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


def decode_token(token: str) -> str:
    return decode_token_payload(token)["sub"]


async def get_current_user_id(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(bearer),
) -> str:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing token")
    token = creds.credentials
    request.state.session_token = token
    return decode_token(token)
