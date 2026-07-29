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
import asyncio
import secrets
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

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

    def test_biz_to_crypto_schema_fix_no_property_errors(self, enable_crypto, auth_headers):
        """After schema fix, /v1/payouts must not return 'property should not exist' errors.
        With a placeholder TRC20 address it likely gets a 400 'Format d'adresse invalide'
        from IzichangePay itself — refund logic must restore balance exactly.
        """
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
                    "amount": 1, "currency": "USDT", "fee_bearer": "sender"}
        tr = requests.post(f"{API}/transfers", json=tpayload, headers=hdrs, timeout=30)

        # Schema check: 'property XYZ should not exist' MUST NOT appear anymore
        body_lower = tr.text.lower()
        for forbidden in ["property coin should not exist",
                          "property address should not exist",
                          "property metadata should not exist",
                          "property clientmetadata should not exist",
                          "property network should not exist"]:
            assert forbidden not in body_lower, \
                f"Schema error still present: {forbidden!r} in {tr.text}"

        if tr.status_code == 200:
            # Happy path — unexpected with the placeholder address but valid
            b = tr.json()
            tx = b.get("transaction") or {}
            assert tx.get("status") == "pending"
            assert b.get("payout_id")
        else:
            # Expected: IzichangePay rejects the placeholder address format
            # Backend must return a 400 with 'Passerelle crypto:' prefix
            assert tr.status_code == 400, f"Unexpected status: {tr.status_code} {tr.text}"
            assert "passerelle crypto" in body_lower, \
                f"Expected 'Passerelle crypto:' prefix, got {tr.text}"
            # Refund must be exact
            bal_after = float(_me(hdrs).get("balance_usdt") or 0)
            assert abs(bal_after - bal_before) < 0.001, \
                f"Balance NOT refunded exactly! before={bal_before} after={bal_after}"

    def test_payout_confirmed_webhook_completes_tx(self, enable_crypto, auth_headers):
        """Simulate payout.confirmed webhook against a hand-inserted pending tx."""
        hdrs = enable_crypto
        me = _me(hdrs)
        uid = me["id"]
        bal_before = float(me.get("balance_usdt") or 0)

        # Insert a pending tx directly into DB
        tx_id = "test-tx-" + secrets.token_hex(6)
        tx_doc = {
            "id": tx_id, "user_id": uid, "type": "transfer", "direction": "out",
            "amount": 2.0, "currency": "USDT", "status": "pending",
            "counterparty": "TXYZ", "reference": "BTP-TEST",
            "description": "sim payout confirm test",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "metadata": {"transfer_type": "biz_to_crypto",
                         "crypto": "USDT", "network": "TRC20",
                         "total_debit": 2.0,
                         "izipay_payout_id": "po_test_confirmed"},
        }

        async def _insert():
            client = AsyncIOMotorClient(MONGO_URL)
            try:
                await client[DB_NAME].transactions.insert_one(dict(tx_doc))
            finally:
                client.close()

        asyncio.run(_insert())

        # Fire signed payout.confirmed webhook
        pevent = {"event": "payout.confirmed",
                  "timestamp": int(time.time()),
                  "data": {"payoutId": "po_test_confirmed",
                           "merchantReference": tx_id,
                           "txHash": "0xabc123"}}
        pwr = _post_webhook(pevent)
        assert pwr.status_code == 200, f"webhook rejected: {pwr.status_code} {pwr.text}"

        # Verify tx moved to completed with tx_hash
        async def _fetch():
            client = AsyncIOMotorClient(MONGO_URL)
            try:
                doc = await client[DB_NAME].transactions.find_one({"id": tx_id})
                return doc
            finally:
                client.close()

        doc = asyncio.run(_fetch())
        assert doc is not None
        assert doc.get("status") == "completed", f"tx status should be completed, got {doc.get('status')}"
        assert (doc.get("metadata") or {}).get("tx_hash") == "0xabc123"

        # Balance UNCHANGED (we never debited on this hand-inserted tx)
        bal_after = float(_me(hdrs).get("balance_usdt") or 0)
        assert abs(bal_after - bal_before) < 0.001

    def test_payout_failed_webhook_refunds(self, enable_crypto, auth_headers):
        """Simulate payout.failed webhook — must refund balance and mark failed."""
        hdrs = enable_crypto
        me = _me(hdrs)
        uid = me["id"]
        bal_before = float(me.get("balance_usdt") or 0)

        tx_id = "test-tx-" + secrets.token_hex(6)
        tx_doc = {
            "id": tx_id, "user_id": uid, "type": "transfer", "direction": "out",
            "amount": 3.0, "currency": "USDT", "status": "pending",
            "counterparty": "TXYZ", "reference": "BTP-TEST",
            "description": "sim payout fail test",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "metadata": {"transfer_type": "biz_to_crypto",
                         "crypto": "USDT", "network": "TRC20",
                         "total_debit": 3.0,
                         "izipay_payout_id": "po_test_failed"},
        }

        async def _setup():
            client = AsyncIOMotorClient(MONGO_URL)
            try:
                await client[DB_NAME].transactions.insert_one(dict(tx_doc))
                # Simulate pre-transfer debit so we can verify refund brings it back
                await client[DB_NAME].users.update_one(
                    {"id": uid}, {"$inc": {"balance_usdt": -3.0}})
            finally:
                client.close()

        asyncio.run(_setup())

        bal_after_debit = float(_me(hdrs).get("balance_usdt") or 0)
        assert abs(bal_after_debit - (bal_before - 3.0)) < 0.001, \
            f"debit sim failed: {bal_before} -> {bal_after_debit}"

        pevent = {"event": "payout.failed",
                  "timestamp": int(time.time()),
                  "data": {"payoutId": "po_test_failed",
                           "merchantReference": tx_id,
                           "reason": "insufficient liquidity"}}
        pwr = _post_webhook(pevent)
        assert pwr.status_code == 200, f"webhook rejected: {pwr.status_code} {pwr.text}"

        # Verify refund
        bal_final = float(_me(hdrs).get("balance_usdt") or 0)
        assert abs(bal_final - bal_before) < 0.001, \
            f"Refund not exact! before={bal_before} final={bal_final}"

        # Verify tx status=failed
        async def _fetch():
            client = AsyncIOMotorClient(MONGO_URL)
            try:
                return await client[DB_NAME].transactions.find_one({"id": tx_id})
            finally:
                client.close()

        doc = asyncio.run(_fetch())
        assert doc and doc.get("status") == "failed"


# ==================== 4b) CONFIG DEEP-MERGE ====================
class TestConfigDeepMerge:
    """PATCH /api/admin/transfer/config with partial sub-dict must NOT wipe arrays."""

    @pytest.fixture(scope="class")
    def admin_hdrs(self):
        r = requests.post(f"{API}/auth/login",
                          json={"email": TEST_EMAIL, "password": TEST_PASSWORD}, timeout=15)
        if r.status_code != 200:
            pytest.skip("cannot login")
        tok = r.json()["token"]
        return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}

    @pytest.fixture(scope="class", autouse=True)
    def _seed_config(self, admin_hdrs):
        # Pre-seed a rich config so we can verify preservation
        full = {
            "crypto": {
                "enabled": False,
                "cryptos": [
                    {"code": "USDT", "name": "Tether", "active": True,
                     "networks": ["TRC20", "BEP20", "ERC20"],
                     "fee_pct": 1.0, "fee_fixed": 1.0, "min": 1, "max": 100000},
                    {"code": "BTC", "name": "Bitcoin", "active": True,
                     "networks": ["BTC"], "fee_pct": 1.0, "fee_fixed": 0.5, "min": 0.0001, "max": 10},
                    {"code": "ETH", "name": "Ethereum", "active": True,
                     "networks": ["ERC20"], "fee_pct": 1.0, "fee_fixed": 0.5, "min": 0.01, "max": 100},
                ],
                "networks": [
                    {"code": "TRC20", "name": "Tron", "active": True,
                     "address_regex": "^T[A-Za-z1-9]{33}$"},
                    {"code": "BEP20", "name": "BNB SC", "active": True,
                     "address_regex": "^0x[a-fA-F0-9]{40}$"},
                    {"code": "ERC20", "name": "Ethereum", "active": True,
                     "address_regex": "^0x[a-fA-F0-9]{40}$"},
                    {"code": "BTC", "name": "Bitcoin", "active": True,
                     "address_regex": "^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$"},
                ],
                "usdt_networks": ["TRC20", "BEP20", "ERC20"],
            },
            "mobile_money": {
                "enabled": True,
                "operators": [
                    {"code": "TMONEY", "name": "T-Money", "active": True, "countries": ["TG"]},
                    {"code": "MIXX", "name": "Mixx by Yas", "active": True, "countries": ["TG"]},
                ],
            },
            "bank": {
                "enabled": True,
                "banks": [
                    {"code": "ORABANK", "name": "Orabank", "active": True, "countries": ["TG"]},
                    {"code": "ECOBANK", "name": "Ecobank", "active": True, "countries": ["TG"]},
                ],
            },
        }
        r = requests.patch(f"{API}/admin/transfer/config", json=full,
                           headers=admin_hdrs, timeout=15)
        assert r.status_code == 200, f"seed config failed: {r.status_code} {r.text}"

    def test_crypto_toggle_enabled_true_preserves_arrays(self, admin_hdrs):
        r = requests.patch(f"{API}/admin/transfer/config",
                           json={"crypto": {"enabled": True}}, headers=admin_hdrs, timeout=15)
        assert r.status_code == 200
        cfg = r.json()
        crypto = cfg.get("crypto") or {}
        assert crypto.get("enabled") is True
        cryptos = crypto.get("cryptos") or []
        codes = {c.get("code") for c in cryptos}
        assert {"USDT", "BTC", "ETH"}.issubset(codes), f"cryptos wiped: {cryptos}"
        networks = crypto.get("networks") or []
        ncodes = {n.get("code") for n in networks}
        assert {"TRC20", "BEP20", "ERC20"}.issubset(ncodes), f"networks wiped: {networks}"
        assert crypto.get("usdt_networks"), "usdt_networks wiped"

    def test_crypto_toggle_enabled_false_preserves_arrays(self, admin_hdrs):
        r = requests.patch(f"{API}/admin/transfer/config",
                           json={"crypto": {"enabled": False}}, headers=admin_hdrs, timeout=15)
        assert r.status_code == 200
        cfg = r.json()
        crypto = cfg.get("crypto") or {}
        assert crypto.get("enabled") is False
        codes = {c.get("code") for c in (crypto.get("cryptos") or [])}
        assert {"USDT", "BTC", "ETH"}.issubset(codes), "cryptos wiped after disable"

    def test_mobile_money_toggle_preserves_operators(self, admin_hdrs):
        r = requests.patch(f"{API}/admin/transfer/config",
                           json={"mobile_money": {"enabled": True}},
                           headers=admin_hdrs, timeout=15)
        assert r.status_code == 200
        mm = r.json().get("mobile_money") or {}
        assert mm.get("enabled") is True
        ops = {o.get("code") for o in (mm.get("operators") or [])}
        assert {"TMONEY", "MIXX"}.issubset(ops), f"operators wiped: {mm}"

    def test_bank_toggle_preserves_banks(self, admin_hdrs):
        r = requests.patch(f"{API}/admin/transfer/config",
                           json={"bank": {"enabled": True}},
                           headers=admin_hdrs, timeout=15)
        assert r.status_code == 200
        bk = r.json().get("bank") or {}
        assert bk.get("enabled") is True
        codes = {b.get("code") for b in (bk.get("banks") or [])}
        assert {"ORABANK", "ECOBANK"}.issubset(codes), f"banks wiped: {bk}"


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
