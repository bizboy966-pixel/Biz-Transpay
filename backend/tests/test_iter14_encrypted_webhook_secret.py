"""Iteration 14 — Phase 3b: Encrypt webhook secrets at rest (Fernet) and sign
outbound webhooks with the PLAINTEXT secret (not the SHA-256 hash) so that
merchants can verify signatures using the secret they copied from the one-time
reveal modal.

Also covers regression of Iterations 9-13 basics.
"""
import os
import sys
import json
import time
import hmac
import hashlib
import uuid
import asyncio

import pytest
import requests

# Load backend env so we can decrypt via cryptography.Fernet directly
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

from cryptography.fernet import Fernet  # noqa: E402

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or "https://secure-pay-preview.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PW = "Password123!"

created_merchant_ids = []


# --------------------------------------------------------------------------
# Direct Mongo helper (for verifying encrypted-at-rest storage)
# --------------------------------------------------------------------------
def _mongo_api_keys(user_id: str) -> dict:
    from pymongo import MongoClient
    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ["DB_NAME"]
    with MongoClient(mongo_url) as c:
        return c[db_name].api_keys.find_one({"user_id": user_id}) or {}


def _clear_secret_encrypted(user_id: str) -> None:
    from pymongo import MongoClient
    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ["DB_NAME"]
    with MongoClient(mongo_url) as c:
        c[db_name].api_keys.update_one(
            {"user_id": user_id},
            {"$unset": {"webhook.secret_encrypted": ""}},
        )


def _make_merchant():
    suf = uuid.uuid4().hex[:8]
    email = f"iter14_{suf}@test.com"
    r = requests.post(f"{API}/auth/register", json={
        "full_name": f"Iter14 Merchant {suf}",
        "username": f"iter14_{suf}",
        "account_type": "merchant",
        "country": "SN",
        "phone": "+221700000000",
        "email": email,
        "password": "Password123!",
    })
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    j = r.json()
    tok = j["token"]
    uid = j["user"]["id"]
    created_merchant_ids.append(uid)
    return tok, uid, email


@pytest.fixture(scope="module")
def admin_ctx():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    return {"h": {"Authorization": f"Bearer {tok}"}}


@pytest.fixture(scope="module")
def merchant_ctx():
    tok, uid, email = _make_merchant()
    return {"token": tok, "uid": uid, "email": email,
            "h": {"Authorization": f"Bearer {tok}"}}


# ----------------------------------------------------------------------
# Env / Fernet setup
# ----------------------------------------------------------------------
class TestEnvSetup:
    def test_secrets_encryption_key_present(self):
        key = os.environ.get("SECRETS_ENCRYPTION_KEY")
        assert key, "SECRETS_ENCRYPTION_KEY missing from /app/backend/.env"
        # Do NOT print the value. Validate it's a valid Fernet key.
        f = Fernet(key.encode())
        ct = f.encrypt(b"ping")
        assert f.decrypt(ct) == b"ping"


# ----------------------------------------------------------------------
# Encrypted-at-rest webhook secret
# ----------------------------------------------------------------------
class TestEncryptedAtRest:
    def test_first_reveal_gives_plaintext(self, merchant_ctx):
        r = requests.get(f"{API}/api-keys", headers=merchant_ctx["h"])
        assert r.status_code == 200, r.text
        d = r.json()
        assert "_reveal" in d, "expected one-time reveal on first GET"
        assert d["_reveal"]["webhook_secret"].startswith("whsec_")
        merchant_ctx["plaintext_webhook_secret"] = d["_reveal"]["webhook_secret"]
        merchant_ctx["plaintext_test_secret"] = d["_reveal"]["test_secret"]

    def test_db_has_secret_hash_and_secret_encrypted(self, merchant_ctx):
        doc = _mongo_api_keys(merchant_ctx["uid"])
        wh = doc.get("webhook") or {}
        assert wh.get("secret_hash"), "secret_hash missing in DB"
        assert wh.get("secret_encrypted"), "secret_encrypted missing in DB"
        assert wh["secret_encrypted"].startswith("gAAAAA"), (
            f"Fernet ciphertext should start with 'gAAAAA': {wh['secret_encrypted'][:20]}")

    def test_decrypted_matches_plaintext_revealed(self, merchant_ctx):
        doc = _mongo_api_keys(merchant_ctx["uid"])
        ct = doc["webhook"]["secret_encrypted"]
        key = os.environ["SECRETS_ENCRYPTION_KEY"]
        pt = Fernet(key.encode()).decrypt(ct.encode()).decode()
        assert pt == merchant_ctx["plaintext_webhook_secret"], \
            "decrypted secret_encrypted must equal plaintext from _reveal"

    def test_hash_matches_plaintext(self, merchant_ctx):
        doc = _mongo_api_keys(merchant_ctx["uid"])
        expected = hashlib.sha256(
            merchant_ctx["plaintext_webhook_secret"].encode()).hexdigest()
        assert doc["webhook"]["secret_hash"] == expected


# ----------------------------------------------------------------------
# Regenerate webhook secret rotates BOTH fields
# ----------------------------------------------------------------------
class TestRegenerateWebhookSecret:
    def test_regenerate_updates_both_fields(self, merchant_ctx):
        # Capture pre-values
        pre = _mongo_api_keys(merchant_ctx["uid"])["webhook"]
        pre_hash = pre["secret_hash"]
        pre_enc = pre["secret_encrypted"]

        r = requests.post(f"{API}/api-keys/webhook/regenerate-secret",
                          headers=merchant_ctx["h"])
        assert r.status_code == 200, r.text
        d = r.json()
        new_plain = d["webhook_secret"]
        assert new_plain.startswith("whsec_")

        post = _mongo_api_keys(merchant_ctx["uid"])["webhook"]
        assert post["secret_hash"] != pre_hash, "secret_hash not rotated"
        assert post["secret_encrypted"] != pre_enc, "secret_encrypted not rotated"
        assert post["secret_encrypted"].startswith("gAAAAA")
        # Decrypt and confirm match with the returned plaintext
        key = os.environ["SECRETS_ENCRYPTION_KEY"]
        dec = Fernet(key.encode()).decrypt(
            post["secret_encrypted"].encode()).decode()
        assert dec == new_plain
        # Also hash matches
        assert post["secret_hash"] == hashlib.sha256(new_plain.encode()).hexdigest()
        # Update ctx for downstream tests
        merchant_ctx["plaintext_webhook_secret"] = new_plain


# ----------------------------------------------------------------------
# Round-trip: webhook fired uses PLAINTEXT for HMAC
# ----------------------------------------------------------------------
class TestPlaintextHmacRoundTrip:
    def test_set_webhook_url_and_regen_test_key(self, merchant_ctx):
        # 1. set webhook URL to httpbin
        r = requests.patch(f"{API}/api-keys/webhook",
                           json={"url": "https://httpbin.org/post"},
                           headers=merchant_ctx["h"])
        assert r.status_code == 200, r.text
        assert r.json()["url"] == "https://httpbin.org/post"

        # 2. regen test key so we have a fresh plaintext to POST payments with
        r = requests.post(f"{API}/api-keys/regenerate",
                          json={"env": "test"}, headers=merchant_ctx["h"])
        assert r.status_code == 200, r.text
        merchant_ctx["plaintext_test_secret"] = r.json()["secret_key"]

    def test_payment_created_signature_verifies_with_plaintext(self, merchant_ctx):
        # 3. POST /api/v1/payments to trigger payment.created webhook
        headers = {"Authorization": f"Bearer {merchant_ctx['plaintext_test_secret']}"}
        r = requests.post(f"{API}/v1/payments",
                          json={"amount": 5, "reference": "ITER14_ORDER",
                                "customer_email": "buyer@test.com"},
                          headers=headers)
        assert r.status_code == 200, f"payment create failed: {r.status_code} {r.text}"

        # 4. Sleep for fire-and-forget webhook + httpbin round-trip
        time.sleep(6)

        # 5. Fetch deliveries and find the payment.created delivery
        r = requests.get(f"{API}/api-keys/webhook/deliveries",
                         headers=merchant_ctx["h"])
        assert r.status_code == 200, r.text
        items = r.json()
        created = [d for d in items if d.get("event_type") == "payment.created"]
        assert created, "no payment.created delivery found"
        # Get most recent delivered one
        delivered = [d for d in created if d.get("status") == "delivered"]
        assert delivered, f"no delivered payment.created among: {[c.get('status') for c in created]}"
        d0 = delivered[0]
        assert d0.get("status_code") == 200

        # 6. Parse httpbin echoed response body to extract headers + raw data
        body_text = d0.get("response_body") or ""
        assert body_text, "httpbin echoed nothing"
        # httpbin.org/post returns JSON with 'data', 'headers', etc.
        try:
            echo = json.loads(body_text)
        except json.JSONDecodeError:
            pytest.fail(f"couldn't parse httpbin echo: {body_text[:300]}")
        echoed_headers = {k.lower(): v for k, v in echo.get("headers", {}).items()}
        received_sig = echoed_headers.get("x-biztranspay-signature")
        received_ts = echoed_headers.get("x-biztranspay-timestamp")
        raw_body = echo.get("data", "")
        assert received_sig and received_ts and raw_body, \
            f"missing sig/ts/data in echo: sig={received_sig} ts={received_ts} data={raw_body[:80]}"
        assert received_sig.startswith("sha256=")

        # 7. Recompute HMAC with the PLAINTEXT webhook secret
        plaintext = merchant_ctx["plaintext_webhook_secret"]
        expected_sig = "sha256=" + hmac.new(
            plaintext.encode(),
            f"{received_ts}.{raw_body}".encode(),
            hashlib.sha256,
        ).hexdigest()

        assert hmac.compare_digest(expected_sig, received_sig), (
            "HMAC computed with PLAINTEXT secret does NOT match received signature.\n"
            f"expected={expected_sig[:30]}... got={received_sig[:30]}...\n"
            "This means _deliver_webhook is not signing with the decrypted plaintext."
        )

        # 8. Sanity: signature does NOT match the HASH-based signature (proving we're on plaintext path)
        hashed = hashlib.sha256(plaintext.encode()).hexdigest()
        hash_sig = "sha256=" + hmac.new(
            hashed.encode(),
            f"{received_ts}.{raw_body}".encode(),
            hashlib.sha256,
        ).hexdigest()
        assert hash_sig != received_sig, (
            "Signature ambiguously matches BOTH plaintext AND hash paths — impossible unless HMAC collided")


# ----------------------------------------------------------------------
# Legacy fallback: no secret_encrypted → sign with hash, still delivers
# ----------------------------------------------------------------------
class TestLegacyFallback:
    def test_legacy_delivery_falls_back_to_hash(self, merchant_ctx):
        # Manually clear secret_encrypted to simulate a legacy iter13 account
        _clear_secret_encrypted(merchant_ctx["uid"])
        doc = _mongo_api_keys(merchant_ctx["uid"])
        assert "secret_encrypted" not in (doc.get("webhook") or {}), \
            "secret_encrypted not cleared"

        # Trigger another payment.created webhook
        headers = {"Authorization": f"Bearer {merchant_ctx['plaintext_test_secret']}"}
        r = requests.post(f"{API}/v1/payments",
                          json={"amount": 5, "reference": "ITER14_LEGACY",
                                "customer_email": "buyer@test.com"},
                          headers=headers)
        assert r.status_code == 200, f"legacy payment create failed: {r.text}"

        time.sleep(6)

        r = requests.get(f"{API}/api-keys/webhook/deliveries",
                         headers=merchant_ctx["h"])
        assert r.status_code == 200
        items = r.json()
        # Find delivery for the ITER14_LEGACY reference (most recent)
        legacy = [
            d for d in items
            if d.get("event_type") == "payment.created"
            and d.get("status") in ("delivered", "failed", "pending")
        ]
        assert legacy, "no delivery record after legacy fallback"
        # It must not crash — status should be delivered (httpbin returns 200)
        recent = legacy[0]
        assert recent.get("status") == "delivered", \
            f"legacy fallback delivery status: {recent.get('status')} — expected delivered"


# ----------------------------------------------------------------------
# Regression from iter13
# ----------------------------------------------------------------------
class TestRegression:
    def test_admin_login(self, admin_ctx):
        r = requests.get(f"{API}/auth/me", headers=admin_ctx["h"])
        assert r.status_code == 200
        assert r.json()["email"] == ADMIN_EMAIL

    def test_notifications(self, admin_ctx):
        r = requests.get(f"{API}/notifications", headers=admin_ctx["h"])
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_exchange_rate(self):
        r = requests.get(f"{API}/exchange/rate?from_currency=XOF&to_currency=XAF")
        assert r.status_code == 200
        assert "rate" in r.json()

    def test_v1_payments_still_requires_auth(self):
        r = requests.post(f"{API}/v1/payments", json={"amount": 5})
        assert r.status_code == 401


# ----------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------
def test_zzz_cleanup(admin_ctx):
    for uid in list(created_merchant_ids):
        try:
            requests.delete(f"{API}/admin/users/{uid}", headers=admin_ctx["h"])
        except Exception:
            pass
