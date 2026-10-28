"""Synthetic compatibility fixtures; does not import server.py or read any database."""
import base64
import hashlib
import json
import os
import sys

os.environ["SESSION_SECRET"] = "synthetic-session-key-not-a-production-secret"
os.environ["JWT_SECRET"] = "synthetic-jwt-key-not-a-production-secret"
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "backend"))
import auth
import admin_pin
from cryptography.fernet import Fernet
import jwt

if len(sys.argv) > 1 and sys.argv[1] == "decrypt":
    print(auth.decrypt_mfa_secret(sys.stdin.read()))
    raise SystemExit(0)

session = os.environ["SESSION_SECRET"]
integration_key = base64.urlsafe_b64encode(
    hashlib.sha256(f"biz-transpay:secrets-encryption:{session}".encode()).digest())
explicit_integration_key = base64.urlsafe_b64encode(
    hashlib.sha256(b"synthetic-explicit-encryption-key").digest())
password_samples = [
    "", "abc", "Synthetic-password9!", "NoDigits!", "123456aA!",
    "abcdefghijklmnA1!", "A" * 73 + "a1!",
]
signature_vectors = []
for value in [500, 0.025, 0.00001, 0.0001, 1e16, -20, 0.1 + 0.2]:
    body = {
        "user_id": "synthetic-user", "direction": "credit",
        "increments": {"balance_xof": float(value)},
        "required_balance_field": None, "required_balance_amount": 0.0,
    }
    signature_vectors.append({
        "value": value,
        "signature": hashlib.sha256(
            json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
    })
print(json.dumps({
    "password_hash": auth.hash_password("Synthetic-password9!"),
    "user_pin_hash": admin_pin.hash_pin("synthetic-user", "123456", "user"),
    "admin_pin_hash": admin_pin.hash_pin("synthetic-user", "123456", "admin"),
    "user_pin_material": admin_pin._pin_material("synthetic-user", "123456", "user"),
    "encrypted_mfa": auth.encrypt_mfa_secret("JBSWY3DPEHPK3PXP"),
    "encrypted_integration": Fernet(integration_key).encrypt(b"synthetic-webhook-value").decode(),
    "explicit_integration_key": explicit_integration_key.decode(),
    "encrypted_explicit_integration": Fernet(explicit_integration_key).encrypt(
        b"synthetic-explicit-value").decode(),
    "password_policy": [
        {"user": auth.password_policy_errors(value),
         "admin": auth.admin_password_policy_errors(value)}
        for value in password_samples
    ],
    "totp": auth.totp_code("JBSWY3DPEHPK3PXP", 1700000000),
    "token": jwt.encode({"sub": "synthetic-user", "sid": "synthetic-session",
                         "typ": "session", "iat": 1700000000, "exp": 1700000300},
                        os.environ["JWT_SECRET"], algorithm="HS256"),
    "signature_vectors": signature_vectors,
}))
