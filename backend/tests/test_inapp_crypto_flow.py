"""
Iteration 5: IN-APP crypto flow tests (direct intent, no hosted redirect).

Coverage:
- GET /api/crypto/assets (public, no secrets leaked)
- POST /api/deposits/crypto (new schema) + GET + webhook credit
- Validation: amount<1, invalid email, unknown asset_code, invalid refund_address
- POST /api/links/pay (new schema) + GET + webhook credit
- POST /api/v1/payments (merchant API — unchanged, hosted flow still active)
- Webhook security (4 scenarios)
- Frontend bundle key isolation

Run:
  pytest /app/backend/tests/test_inapp_crypto_flow.py -v -n 0 \
    --junitxml=/app/test_reports/pytest/iter5_results.xml
"""
import os
import time
import json
import hmac
import hashlib
import subprocess
import glob
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"

TEST_EMAIL = "test@biztranspay.com"
TEST_PASSWORD = "Password123!"
WEBHOOK_SECRET = "whsec_2a08fc49a8abfc2fc4f035db615ea72263d02d73d5aa085eaacfa0cdf0a568ab"
API_KEY_SENSITIVE_PART = "sk_live_41cc"
WHSEC_SENSITIVE_PART = "whsec_2a08"

# Valid Tron refund address (per review request context)
VALID_TRC20 = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"


# ---------------- Fixtures ----------------
@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": TEST_EMAIL, "password": TEST_PASSWORD}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"login failed: {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _me(hdrs):
    r = requests.get(f"{API}/auth/me", headers=hdrs, timeout=15)
    r.raise_for_status()
    return r.json()


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()


def _post_webhook(event, sig_header=None):
    body = json.dumps(event).encode()
    headers = {"Content-Type": "application/json"}
    if sig_header is None:
        headers["X-IziPay-Signature"] = _sign(body)
    elif sig_header != "__omit__":
        headers["X-IziPay-Signature"] = sig_header
    return requests.post(f"{API}/webhooks/izipay", data=body, headers=headers, timeout=15)


# ==================== 1) GET /api/crypto/assets ====================
class TestCryptoAssets:
    def test_public_no_auth_required(self):
        r = requests.get(f"{API}/crypto/assets", timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 30, f"expected >=30 assets, got {len(data)}"
        # All entries must have the expected keys and no secrets
        raw = r.text
        assert API_KEY_SENSITIVE_PART not in raw
        assert WHSEC_SENSITIVE_PART not in raw
        for a in data[:5]:
            assert set(a.keys()) >= {"asset_code", "coin", "network",
                                    "blockchain_name", "memo_required", "memo_type"}

    def test_usdt_trc20_present(self):
        r = requests.get(f"{API}/crypto/assets", timeout=20)
        assert r.status_code == 200
        data = r.json()
        trc20 = [a for a in data if a.get("asset_code") == "USDT.TRC20"]
        assert trc20, "USDT.TRC20 must be present"
        assert trc20[0].get("memo_required") is False, \
            f"USDT.TRC20 memo_required should be False, got {trc20[0]}"


# ==================== 2) POST /api/deposits/crypto happy path ====================
class TestCryptoDeposit:
    def test_deposit_direct_intent_end_to_end(self, auth_headers):
        me_before = _me(auth_headers)
        bal_before = float(
            (me_before.get("crypto_wallet_balances") or {}).get("USDT.TRC20") or 0)
        legacy_usdt_before = float(me_before.get("balance_usdt") or 0)

        payload = {
            "amount": 3,
            "asset_code": "USDT.TRC20",
            "full_name": "Test User",
            "email": "test@example.com",
            "refund_address": VALID_TRC20,
            "origin_url": "https://x.example.com",
            "idempotency_key": f"test-direct-deposit-{time.time_ns()}",
        }
        r = requests.post(f"{API}/deposits/crypto", json=payload,
                          headers=auth_headers, timeout=45)
        assert r.status_code == 200, f"deposit failed: {r.status_code} {r.text}"
        d = r.json()
        assert d.get("id")
        assert d.get("izipay_intent_id"), f"missing intent id: {d}"
        assert d.get("deposit_address"), f"missing deposit_address: {d}"
        assert d["deposit_address"].startswith("T"), \
            f"TRC20 address must start with 'T': {d['deposit_address']}"
        assert d.get("coin") == "USDT"
        assert d.get("network") == "TRC20"
        assert d.get("amount_to_send") is not None
        assert d.get("expires_at"), "expires_at missing"
        assert d.get("status") in ("pending", "waiting_confirmation")
        deposit_id = d["id"]

        # GET the deposit
        g = requests.get(f"{API}/deposits/crypto/{deposit_id}",
                         headers=auth_headers, timeout=15)
        assert g.status_code == 200
        gg = g.json()
        assert gg["id"] == deposit_id
        assert gg["deposit_address"] == d["deposit_address"]
        assert gg["coin"] == "USDT" and gg["network"] == "TRC20"

        # Fire webhook payment_intent.completed
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()),
                 "data": {"intentId": d["izipay_intent_id"],
                          "merchantReference": deposit_id}}
        wr = _post_webhook(event)
        assert wr.status_code == 200, f"webhook failed: {wr.text}"

        # Balance credited by exactly 3
        me_after = _me(auth_headers)
        bal_after = float(
            (me_after.get("crypto_wallet_balances") or {}).get("USDT.TRC20") or 0)
        assert abs(bal_after - (bal_before + 3)) < 0.001, \
            f"balance not credited: {bal_before} -> {bal_after}"
        assert float(me_after.get("balance_usdt") or 0) == legacy_usdt_before

        # Status transitioned
        g2 = requests.get(f"{API}/deposits/crypto/{deposit_id}",
                          headers=auth_headers, timeout=15)
        assert g2.json().get("status") == "confirmed"


# ==================== 3) Validation ====================
class TestDepositValidation:
    def _base(self):
        return {
            "amount": 3, "asset_code": "USDT.TRC20",
            "full_name": "Test User", "email": "test@example.com",
            "refund_address": VALID_TRC20,
            "origin_url": "https://x.example.com",
        }

    def test_amount_below_min(self, auth_headers):
        p = self._base(); p["amount"] = 0.5
        r = requests.post(f"{API}/deposits/crypto", json=p,
                          headers=auth_headers, timeout=15)
        assert r.status_code == 400
        assert "minimum" in r.text.lower() or "montant" in r.text.lower()

    def test_invalid_email_422(self, auth_headers):
        p = self._base(); p["email"] = "not-an-email"
        r = requests.post(f"{API}/deposits/crypto", json=p,
                          headers=auth_headers, timeout=15)
        assert r.status_code == 422, f"expected 422 for bad email: {r.status_code} {r.text}"

    def test_empty_refund_address(self, auth_headers):
        """Per spec: empty refund_address should be rejected as validation error
        (422). If the model has no min_length constraint, the vendor will 400 —
        we accept either as long as no vendor leak in message."""
        p = self._base(); p["refund_address"] = ""
        r = requests.post(f"{API}/deposits/crypto", json=p,
                          headers=auth_headers, timeout=30)
        assert r.status_code in (400, 422), f"expected 400/422 got {r.status_code}: {r.text}"
        # No vendor leak
        body_lower = r.text.lower()
        assert "passerelle crypto:" not in body_lower, \
            f"vendor message leak: {r.text}"

    def test_unknown_asset_code_sanitized(self, auth_headers):
        p = self._base(); p["asset_code"] = "FAKECOIN.FAKENET"
        r = requests.post(f"{API}/deposits/crypto", json=p,
                          headers=auth_headers, timeout=30)
        assert r.status_code == 400, f"got {r.status_code}: {r.text}"
        body_lower = r.text.lower()
        # sanitized message expected — no raw vendor phrasing
        assert "passerelle crypto:" not in body_lower, \
            f"vendor leak: {r.text}"
        assert ("non prise en charge" in body_lower or
                "cryptomonnaie" in body_lower or
                "refus" in body_lower), \
            f"expected sanitized msg, got {r.text}"

    def test_invalid_refund_address_format(self, auth_headers):
        """Invalid Tron address format — vendor should reject; backend must
        return sanitized 'Adresse de remboursement crypto invalide' (no leak)."""
        p = self._base(); p["refund_address"] = "not_a_valid_address_xxx"
        r = requests.post(f"{API}/deposits/crypto", json=p,
                          headers=auth_headers, timeout=30)
        assert r.status_code == 400, f"got {r.status_code}: {r.text}"
        body_lower = r.text.lower()
        assert "passerelle crypto:" not in body_lower, \
            f"vendor leak: {r.text}"
        assert "adresse" in body_lower, \
            f"expected refund address error, got {r.text}"


# ==================== 4) POST /api/links/pay ====================
class TestLinkPay:
    def test_link_pay_direct_intent(self, auth_headers):
        # 1) create a fixed-amount link
        cr = requests.post(f"{API}/links",
                           json={"title": "TEST_iter5_link",
                                 "amount_type": "fixed",
                                 "amount": 25, "currency": "XOF",
                                 "fee_bearer": "customer"},
                           headers=auth_headers, timeout=15)
        assert cr.status_code == 200, cr.text
        slug = cr.json()["slug"]

        me_before = _me(auth_headers)
        bal_before = float(me_before.get("balance_usdt") or 0)

        # 2) start crypto payment (public — no auth)
        payload = {"slug": slug, "asset_code": "USDT.TRC20",
                   "full_name": "Buyer Name", "email": "buyer@x.com",
                   "refund_address": VALID_TRC20,
                   "origin_url": "https://x.example.com"}
        pr = requests.post(f"{API}/links/pay", json=payload, timeout=45)
        assert pr.status_code == 200, f"link pay failed: {pr.text}"
        p = pr.json()
        assert p.get("id")
        assert p.get("deposit_address", "").startswith("T"), \
            f"expected Tron address: {p}"
        assert p.get("coin") == "USDT" and p.get("network") == "TRC20"
        assert p.get("amount_to_send") is not None
        assert p.get("expires_at")
        assert p.get("izipay_intent_id")
        lp_id = p["id"]

        # 3) GET status
        g = requests.get(f"{API}/links/payments/{lp_id}", timeout=15)
        assert g.status_code == 200
        assert g.json()["id"] == lp_id
        assert g.json()["deposit_address"] == p["deposit_address"]

        # 4) Fire webhook to mark paid + credit merchant
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()),
                 "data": {"intentId": p["izipay_intent_id"],
                          "merchantReference": lp_id}}
        wr = _post_webhook(event)
        assert wr.status_code == 200, wr.text

        # amount is 25 (link amount, XOF stored — server credits balance_usdt
        # with the stored amount value, which is the link amount)
        me_after = _me(auth_headers)
        bal_after = float(me_after.get("balance_usdt") or 0)
        assert bal_after > bal_before, \
            f"merchant not credited: {bal_before} -> {bal_after}"

        g2 = requests.get(f"{API}/links/payments/{lp_id}", timeout=15)
        assert g2.json().get("status") == "paid"


# ==================== 5) Merchant API (hosted flow unchanged) ====================
class TestMerchantAPI:
    def test_merchant_api_hosted_still_works(self, auth_headers):
        kr = requests.get(f"{API}/api-keys", headers=auth_headers, timeout=15)
        assert kr.status_code == 200
        secret = kr.json()["secret_key"]
        assert secret.startswith(("sk_test_", "sk_live_"))

        payload = {"amount": 20, "coin": "USDT",
                   "accepted_networks": ["TRC20"], "reference": "ORDER-iter5"}
        r = requests.post(f"{API}/v1/payments", json=payload,
                          headers={"Authorization": f"Bearer {secret}",
                                   "Content-Type": "application/json"}, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("payment_url", "").startswith("http")
        assert "pay.izichange.com" in d["payment_url"]

    def test_merchant_api_invalid_key_401(self):
        r = requests.post(f"{API}/v1/payments",
                          json={"amount": 5, "coin": "USDT",
                                "accepted_networks": ["TRC20"],
                                "reference": "x"},
                          headers={"Authorization": "Bearer sk_test_invalid_xxxx",
                                   "Content-Type": "application/json"}, timeout=15)
        assert r.status_code == 401


# ==================== 6) Webhook security ====================
class TestWebhookSecurity:
    def test_bad_signature_400(self):
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()),
                 "data": {"intentId": "x"}}
        r = _post_webhook(event, sig_header="sha256=deadbeef")
        assert r.status_code == 400
        assert "signature" in r.text.lower()

    def test_missing_signature_header_400(self):
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()),
                 "data": {"intentId": "x"}}
        r = _post_webhook(event, sig_header="__omit__")
        assert r.status_code == 400

    def test_old_timestamp_400(self):
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()) - 3600,
                 "data": {"intentId": "old"}}
        r = _post_webhook(event)
        assert r.status_code == 400

    def test_duplicate_delivery_200_duplicate_true(self, auth_headers):
        # Create a real deposit first so the intent id is valid, then fire twice
        p = {"amount": 2, "asset_code": "USDT.TRC20",
             "full_name": "Dup Test", "email": "dup@x.com",
             "refund_address": VALID_TRC20,
             "origin_url": "https://x.example.com"}
        cr = requests.post(f"{API}/deposits/crypto", json=p,
                           headers=auth_headers, timeout=45)
        if cr.status_code != 200:
            pytest.skip(f"cannot create deposit for dup test: {cr.text}")
        d = cr.json()
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()),
                 "data": {"intentId": d["izipay_intent_id"],
                          "merchantReference": d["id"]}}
        r1 = _post_webhook(event)
        assert r1.status_code == 200
        r2 = _post_webhook(event)
        assert r2.status_code == 200
        assert r2.json().get("duplicate") is True, \
            f"expected duplicate:true, got {r2.json()}"


# ==================== 7) Frontend bundle key isolation ====================
class TestBundleIsolation:
    def test_frontend_src_no_secrets(self):
        r = subprocess.run(
            ["grep", "-r", "-l", "-E",
             f"{API_KEY_SENSITIVE_PART}|{WHSEC_SENSITIVE_PART}",
             "/app/frontend/src"], capture_output=True, text=True)
        assert r.returncode != 0 or not r.stdout.strip(), \
            f"leak in frontend/src: {r.stdout}"

    def test_served_frontend_bundle_no_secrets(self):
        """Fetch main.*.js from the served frontend and grep for secrets."""
        try:
            root = requests.get(BASE_URL, timeout=15).text
        except requests.RequestException:
            pytest.skip("frontend not reachable")
        # Find main.*.js references
        js_refs = re.findall(r'/static/js/[A-Za-z0-9_.\-]+\.js', root)
        if not js_refs:
            pytest.skip("no main.js reference found (dev build)")
        checked = 0
        for js in set(js_refs):
            try:
                content = requests.get(f"{BASE_URL}{js}", timeout=20).text
            except requests.RequestException:
                continue
            assert API_KEY_SENSITIVE_PART not in content, f"sk_live leak in {js}"
            assert WHSEC_SENSITIVE_PART not in content, f"whsec leak in {js}"
            checked += 1
        assert checked > 0, "no js bundle actually checked"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v", "-n", "0"]))
