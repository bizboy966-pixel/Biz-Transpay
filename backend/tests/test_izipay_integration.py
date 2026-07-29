"""
Tests for IzichangePay integration:
- Crypto Deposit (POST /api/deposits/crypto)
- Webhook signature/HMAC/anti-replay/dedup (POST /api/webhooks/izipay)
- Crypto Transfer / payout (POST /api/transfers biz_to_crypto)
- Payment Link crypto pay (POST /api/links/pay)
- Merchant API (POST /api/v1/payments)
- Security: webhook secret / api key not exposed in frontend bundle

Run:
  pytest /app/backend/tests/test_izipay_integration.py -v \
    --junitxml=/app/test_reports/pytest/izipay_results.xml
"""
import os
import time
import json
import hmac
import hashlib
import subprocess
import glob
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://secure-pay-preview.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

TEST_EMAIL = "test@biztranspay.com"
TEST_PASSWORD = "Password123!"

WEBHOOK_SECRET = "whsec_2a08fc49a8abfc2fc4f035db615ea72263d02d73d5aa085eaacfa0cdf0a568ab"
API_KEY_SENSITIVE_PART = "sk_live_41cc"
WHSEC_SENSITIVE_PART = "whsec_2a08"


# ---------------- Fixtures ----------------
@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": TEST_EMAIL, "password": TEST_PASSWORD}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Cannot login test user: {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _me(auth_headers):
    r = requests.get(f"{API}/auth/me", headers=auth_headers, timeout=15)
    r.raise_for_status()
    return r.json()


def _sign(body_bytes: bytes) -> str:
    return "sha256=" + hmac.new(WEBHOOK_SECRET.encode(), body_bytes, hashlib.sha256).hexdigest()


def _post_webhook(event: dict, sig_header: str | None = None):
    body = json.dumps(event).encode()
    headers = {"Content-Type": "application/json"}
    if sig_header is None:
        headers["X-IziPay-Signature"] = _sign(body)
    elif sig_header != "__omit__":
        headers["X-IziPay-Signature"] = sig_header
    return requests.post(f"{API}/webhooks/izipay", data=body, headers=headers, timeout=15)


# ==================== 1) SECURITY: FRONTEND BUNDLE ====================
class TestSecurityFrontendBundle:
    def test_sensitive_keys_not_in_frontend_src(self):
        # grep the /app/frontend/src directory
        result = subprocess.run(
            ["grep", "-r", "-l", "-E", f"{API_KEY_SENSITIVE_PART}|{WHSEC_SENSITIVE_PART}",
             "/app/frontend/src"], capture_output=True, text=True
        )
        assert result.returncode != 0 or not result.stdout.strip(), \
            f"Sensitive keys found in frontend/src: {result.stdout}"

    def test_sensitive_keys_not_in_built_bundle(self):
        # Try /app/frontend/build first, then loading the served page for main.js references
        # We check both static build files (if present) and .env exposure
        # First: any file under frontend/build
        found_files = []
        for pattern in ["/app/frontend/build/**/*.js", "/app/frontend/build/**/*.html"]:
            for f in glob.glob(pattern, recursive=True):
                try:
                    with open(f, "r", encoding="utf-8", errors="ignore") as fh:
                        content = fh.read()
                    if API_KEY_SENSITIVE_PART in content or WHSEC_SENSITIVE_PART in content:
                        found_files.append(f)
                except Exception:
                    pass
        assert not found_files, f"Sensitive keys leaked in built bundle: {found_files}"

    def test_no_izipay_config_endpoint_public(self):
        # Making sure there's no accidental endpoint that returns the config
        # A quick heuristic: /api/config or /api/izipay/config should NOT return the secret
        for path in ["/api/config", "/api/izipay/config", "/api/settings"]:
            try:
                r = requests.get(f"{BASE_URL}{path}", timeout=5)
                if r.status_code == 200:
                    txt = r.text
                    assert API_KEY_SENSITIVE_PART not in txt, f"Leaked in {path}"
                    assert WHSEC_SENSITIVE_PART not in txt, f"Leaked in {path}"
            except requests.RequestException:
                pass


# ==================== 2) CRYPTO DEPOSIT ====================
class TestCryptoDeposit:
    def test_deposit_end_to_end(self, auth_headers):
        me_before = _me(auth_headers)
        bal_before = float(me_before.get("balance_usdt") or 0)

        payload = {"amount": 15, "coin": "USDT",
                   "accepted_networks": ["TRC20", "BEP20"],
                   "origin_url": "https://example.com"}
        r = requests.post(f"{API}/deposits/crypto", json=payload, headers=auth_headers, timeout=30)
        assert r.status_code == 200, f"deposit create failed: {r.status_code} {r.text}"
        d = r.json()
        assert d.get("id")
        assert d.get("izipay_intent_id"), f"No intent id: {d}"
        assert d.get("payment_url", "").startswith("http"), f"No payment_url: {d}"
        assert "pay.izichange.com" in d["payment_url"], f"payment_url looks wrong: {d['payment_url']}"
        assert d["amount"] == 15
        assert d["coin"] == "USDT"
        assert d["status"] == "initiated"
        assert d.get("accepted_coins") == ["USDT.TRC20", "USDT.BEP20"]

        deposit_id = d["id"]

        # GET the deposit
        r2 = requests.get(f"{API}/deposits/crypto/{deposit_id}", headers=auth_headers, timeout=15)
        assert r2.status_code == 200
        assert r2.json()["id"] == deposit_id

        # Simulate webhook payment_intent.completed
        event = {
            "event": "payment_intent.completed",
            "timestamp": int(time.time()),
            "data": {"intentId": d["izipay_intent_id"] or "pi_test",
                     "merchantReference": deposit_id},
        }
        wr = _post_webhook(event)
        assert wr.status_code == 200, f"Webhook failed: {wr.status_code} {wr.text}"
        assert wr.json().get("received") is True

        # Verify balance credited
        me_after = _me(auth_headers)
        bal_after = float(me_after.get("balance_usdt") or 0)
        assert abs(bal_after - (bal_before + 15)) < 0.001, \
            f"Balance not credited: before={bal_before} after={bal_after}"

        # Duplicate webhook: same event_id → duplicate:true, no re-credit
        wr2 = _post_webhook(event)
        assert wr2.status_code == 200
        assert wr2.json().get("duplicate") is True, f"Expected duplicate:true, got {wr2.json()}"

        me_final = _me(auth_headers)
        bal_final = float(me_final.get("balance_usdt") or 0)
        assert abs(bal_final - bal_after) < 0.001, "Duplicate webhook re-credited balance!"


# ==================== 3) WEBHOOK SECURITY ====================
class TestWebhookSecurity:
    def test_invalid_signature_400(self):
        event = {"event": "payment_intent.completed", "timestamp": int(time.time()), "data": {"intentId": "x"}}
        r = _post_webhook(event, sig_header="sha256=deadbeef")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        assert "signature" in r.text.lower()

    def test_missing_signature_header_400(self):
        event = {"event": "payment_intent.completed", "timestamp": int(time.time()), "data": {"intentId": "x"}}
        r = _post_webhook(event, sig_header="__omit__")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"

    def test_old_timestamp_replay_400(self):
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()) - 3600,
                 "data": {"intentId": "old_pi"}}
        r = _post_webhook(event)
        assert r.status_code == 400
        assert "timestamp" in r.text.lower() or "replay" in r.text.lower()

    def test_unknown_merchant_reference_is_noop_200(self):
        event = {"event": "payment_intent.completed",
                 "timestamp": int(time.time()),
                 "data": {"intentId": "pi_unknown_" + str(int(time.time())),
                          "merchantReference": "nonexistent_" + str(int(time.time()))}}
        r = _post_webhook(event)
        assert r.status_code == 200, f"Unknown ref should be no-op 200: {r.status_code} {r.text}"


# ==================== 4) CRYPTO TRANSFER (payout) ====================
class TestCryptoTransfer:
    @pytest.fixture(scope="class")
    def enable_crypto(self):
        # Requires admin. Test user is super_admin.
        r = requests.post(f"{API}/auth/login", json={"email": TEST_EMAIL, "password": TEST_PASSWORD}, timeout=15)
        if r.status_code != 200:
            pytest.skip("cannot login")
        tok = r.json()["token"]
        hdrs = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
        # Full restore of crypto sub-config (state was corrupted by previous test runs)
        full_crypto = {
            "enabled": True,
            "cryptos": [
                {"code": "USDT", "name": "Tether", "active": True,
                 "networks": ["TRC20", "BEP20", "ERC20"],
                 "fee_pct": 1.0, "fee_fixed": 1.0, "min": 1, "max": 100000},
            ],
            "networks": [
                {"code": "TRC20", "name": "Tron (TRC20)", "active": True,
                 "address_regex": "^T[A-Za-z1-9]{33}$"},
                {"code": "BEP20", "name": "BNB Smart Chain (BEP20)", "active": True,
                 "address_regex": "^0x[a-fA-F0-9]{40}$"},
                {"code": "ERC20", "name": "Ethereum (ERC20)", "active": True,
                 "address_regex": "^0x[a-fA-F0-9]{40}$"},
            ],
            "usdt_networks": ["TRC20", "BEP20", "ERC20"],
        }
        pr = requests.patch(f"{API}/admin/transfer/config",
                            json={"crypto": full_crypto}, headers=hdrs, timeout=15)
        assert pr.status_code == 200, f"Cannot enable crypto: {pr.status_code} {pr.text}"
        yield hdrs
        # Cleanup — disable crypto (keep full config for future tests)
        try:
            full_crypto["enabled"] = False
            requests.patch(f"{API}/admin/transfer/config",
                           json={"crypto": full_crypto}, headers=hdrs, timeout=15)
        except Exception:
            pass

    def test_biz_to_crypto_creates_pending_tx_and_debits(self, enable_crypto, auth_headers):
        hdrs = enable_crypto
        # Ensure sufficient balance by simulating a deposit webhook of 100 USDT
        deposit_payload = {"amount": 100, "coin": "USDT",
                           "accepted_networks": ["TRC20"],
                           "origin_url": "https://example.com"}
        dr = requests.post(f"{API}/deposits/crypto", json=deposit_payload, headers=hdrs, timeout=30)
        if dr.status_code != 200:
            pytest.skip(f"cannot create deposit for balance top-up: {dr.text}")
        did = dr.json()["id"]
        event = {"event": "payment_intent.completed", "timestamp": int(time.time()),
                 "data": {"intentId": dr.json().get("izipay_intent_id") or "pi_top",
                          "merchantReference": did}}
        wr = _post_webhook(event)
        assert wr.status_code == 200

        bal_before = float(_me(hdrs).get("balance_usdt") or 0)
        assert bal_before >= 5, f"Balance still too low: {bal_before}"

        tpayload = {"transfer_type": "biz_to_crypto",
                    "recipient": "TXYZabcdefghijklmnopqrstuvwxyz1234",
                    "crypto": "USDT", "network": "TRC20",
                    "wallet_address": "TXYZabcdefghijklmnopqrstuvwxyz1234",
                    "amount": 5, "currency": "USDT", "fee_bearer": "sender"}
        tr = requests.post(f"{API}/transfers", json=tpayload, headers=hdrs, timeout=30)

        if tr.status_code != 200:
            # BUG: izipay.create_payout sends wrong payload keys (coin/address/metadata)
            # IziPay expects: assetCode/destinationAddress (see /v1/payouts docs).
            # Verify that refund happened (balance restored).
            bal_after = float(_me(hdrs).get("balance_usdt") or 0)
            assert abs(bal_after - bal_before) < 0.01, \
                f"Balance NOT refunded after payout rejection! before={bal_before} after={bal_after}"
            pytest.fail(f"BUG in izipay.create_payout — wrong payload schema. "
                        f"IziPay response: {tr.status_code} {tr.text}. "
                        f"Refund logic OK (balance restored to {bal_after}).")

        # If it succeeded (unexpected), verify the happy path
        body = tr.json()
        tx = body.get("transaction") or {}
        assert tx.get("status") == "pending"
        assert body.get("payout_id")
        assert (tx.get("metadata") or {}).get("izipay_payout_id")

        bal_after = float(_me(hdrs).get("balance_usdt") or 0)
        assert bal_before - bal_after >= 5

        pevent = {"event": "payout.confirmed",
                  "timestamp": int(time.time()),
                  "data": {"payoutId": body["payout_id"],
                           "merchantReference": tx["id"],
                           "txHash": "0xdeadbeef1234"}}
        pwr = _post_webhook(pevent)
        assert pwr.status_code == 200

        txr = requests.get(f"{API}/transactions", headers=hdrs, timeout=15)
        assert txr.status_code == 200
        found = next((t for t in txr.json() if t.get("id") == tx["id"]), None)
        assert found and found.get("status") == "completed"
        assert (found.get("metadata") or {}).get("tx_hash") == "0xdeadbeef1234"


def _get_crypto(hdrs):
    r = requests.get(f"{API}/admin/transfer/config", headers=hdrs, timeout=15)
    r.raise_for_status()
    return r.json().get("crypto") or {}


# ==================== 5) PAYMENT LINK CRYPTO ====================
class TestLinkCrypto:
    def test_link_pay_flow(self, auth_headers):
        # Create link
        cr = requests.post(f"{API}/links", json={"title": "TEST_izipay_link",
                                                  "amount_type": "fixed",
                                                  "amount": 30, "currency": "XOF",
                                                  "fee_bearer": "customer"},
                           headers=auth_headers, timeout=15)
        assert cr.status_code == 200, f"link create failed: {cr.text}"
        link = cr.json()
        slug = link["slug"]

        me_before = _me(auth_headers)
        bal_before = float(me_before.get("balance_usdt") or 0)

        # Start crypto payment
        pr = requests.post(f"{API}/links/pay",
                           json={"slug": slug, "coin": "USDT",
                                 "accepted_networks": ["TRC20"],
                                 "origin_url": "https://example.com",
                                 "customer_email": "test@x.com"}, timeout=30)
        assert pr.status_code == 200, f"link pay failed: {pr.text}"
        p = pr.json()
        assert p.get("payment_url", "").startswith("http")
        assert "pay.izichange.com" in p["payment_url"]
        lp_id = p["id"]

        # Simulate completion webhook
        event = {"event": "payment_intent.completed", "timestamp": int(time.time()),
                 "data": {"intentId": "pi_link_" + str(int(time.time())),
                          "merchantReference": lp_id}}
        wr = _post_webhook(event)
        assert wr.status_code == 200

        # Merchant balance credited by 30 USDT
        me_after = _me(auth_headers)
        bal_after = float(me_after.get("balance_usdt") or 0)
        assert abs(bal_after - (bal_before + 30)) < 0.001, \
            f"Merchant not credited: before={bal_before} after={bal_after}"

        # link_payment status paid
        s = requests.get(f"{API}/links/payments/{lp_id}", timeout=15)
        assert s.status_code == 200
        assert s.json().get("status") == "paid"


# ==================== 6) MERCHANT API ====================
class TestMerchantAPI:
    def test_merchant_api_flow(self, auth_headers):
        # Get keys
        kr = requests.get(f"{API}/api-keys", headers=auth_headers, timeout=15)
        assert kr.status_code == 200, kr.text
        secret = kr.json()["secret_key"]
        assert secret.startswith(("sk_test_", "sk_live_"))

        # Create payment
        payload = {"amount": 20, "coin": "USDT",
                   "accepted_networks": ["TRC20"], "reference": "ORDER-1"}
        r = requests.post(f"{API}/v1/payments", json=payload,
                          headers={"Authorization": f"Bearer {secret}",
                                   "Content-Type": "application/json"}, timeout=30)
        assert r.status_code == 200, f"merchant payment failed: {r.text}"
        d = r.json()
        assert d.get("id")
        assert d.get("payment_url", "").startswith("http")
        assert d["amount"] == 20
        assert d["status"] == "initiated"
        mp_id = d["id"]

        # Invalid key → 401
        bad = requests.post(f"{API}/v1/payments", json=payload,
                            headers={"Authorization": "Bearer sk_test_invalid_xxxx",
                                     "Content-Type": "application/json"}, timeout=15)
        assert bad.status_code == 401

        # GET payment
        g = requests.get(f"{API}/v1/payments/{mp_id}",
                         headers={"Authorization": f"Bearer {secret}"}, timeout=15)
        assert g.status_code == 200
        assert g.json()["id"] == mp_id
        assert g.json()["status"] == "initiated"

        # Simulate completion
        bal_before = float(_me(auth_headers).get("balance_usdt") or 0)
        event = {"event": "payment_intent.completed", "timestamp": int(time.time()),
                 "data": {"intentId": "pi_merch_" + str(int(time.time())),
                          "merchantReference": mp_id}}
        wr = _post_webhook(event)
        assert wr.status_code == 200

        bal_after = float(_me(auth_headers).get("balance_usdt") or 0)
        assert abs(bal_after - (bal_before + 20)) < 0.001, \
            f"Merchant not credited: {bal_before} -> {bal_after}"

        g2 = requests.get(f"{API}/v1/payments/{mp_id}",
                          headers={"Authorization": f"Bearer {secret}"}, timeout=15)
        assert g2.json()["status"] == "paid"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
