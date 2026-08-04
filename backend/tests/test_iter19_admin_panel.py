"""Iteration 19 — Admin panel: crypto sub-buckets, manual approve/reject,
notification side-effects, PDF documentation download.

Tests are structured to avoid modifying business-critical seeded data:
- Uses the existing super-admin (bizboy966@gmail.com)
- Creates PENDING transactions via direct MongoDB insertion in a fixture
- Approves / rejects them via the admin API
- Verifies status transitions, balance side-effects, notifications
- Also confirms /api/documentation.pdf returns a valid PDF
- Regression sanity on /api/v1/health
"""
import os
import re
import asyncio
import pytest
import requests
from datetime import datetime, timezone

def _load_frontend_env():
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _load_frontend_env() or "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL missing"
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PASSWORD = "Password123!"


# ---------------------------- Fixtures ---------------------------------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=15)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"no token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}",
            "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def admin_user_id(admin_headers):
    r = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ---------- Helper: insert a pending tx directly into Mongo (sync pymongo) ----------
def _get_sync_db():
    from pymongo import MongoClient
    # Read backend .env
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        try:
            with open("/app/backend/.env") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("MONGO_URL="):
                        mongo_url = line.split("=", 1)[1].strip().strip('"').strip("'")
                    elif line.startswith("DB_NAME="):
                        db_name = line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
    assert mongo_url and db_name, "MONGO_URL / DB_NAME missing"
    return MongoClient(mongo_url)[db_name]


def _new_id():
    import uuid
    return uuid.uuid4().hex


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _insert_pending(uid: str, kind: str) -> str:
    """kind in {'deposit_mm','deposit_crypto','withdrawal_mm','withdrawal_crypto'}"""
    db = _get_sync_db()
    tx_id = _new_id()
    if kind == "deposit_mm":
        doc = {"id": tx_id, "user_id": uid, "type": "deposit", "direction": "in",
               "amount": 1000, "currency": "XOF", "status": "pending",
               "reference": "TEST_ITER19_DEP_MM",
               "metadata": {"operator": "mtn_bj", "phone_number": "22999999999",
                            "fee": 10, "amount_net": 990},
               "created_at": _now_iso()}
    elif kind == "deposit_crypto":
        doc = {"id": tx_id, "user_id": uid, "type": "deposit", "direction": "in",
               "amount": 10, "currency": "USDT", "status": "pending",
               "reference": "TEST_ITER19_DEP_CR",
               "metadata": {"coin": "USDT", "network": "BSC",
                            "izipay_intent_id": "iz_test_123",
                            "fee": 0.1, "amount_net": 9.9},
               "created_at": _now_iso()}
    elif kind == "withdrawal_mm":
        doc = {"id": tx_id, "user_id": uid, "type": "withdrawal", "direction": "out",
               "amount": 500, "currency": "XOF", "status": "pending",
               "reference": "TEST_ITER19_WD_MM",
               "metadata": {"operator": "mtn_bj", "phone_number": "22999999999",
                            "fee": 25, "total_debit": 525},
               "created_at": _now_iso()}
    elif kind == "withdrawal_crypto":
        doc = {"id": tx_id, "user_id": uid, "type": "withdrawal", "direction": "out",
               "amount": 5, "currency": "USDT", "status": "pending",
               "reference": "TEST_ITER19_WD_CR",
               "metadata": {"transfer_type": "biz_to_crypto",
                            "crypto": {"coin": "USDT", "network": "BSC",
                                       "address": "0xdeadbeef"},
                            "fee": 0.2, "total_debit": 5.2},
               "created_at": _now_iso()}
    else:
        raise ValueError(kind)
    db.transactions.insert_one(doc)
    return tx_id


def _find_notification(uid: str, tx_id: str):
    db = _get_sync_db()
    return db.notifications.find_one({"user_id": uid, "metadata.tx_id": tx_id})


# ============================ TESTS ==========================================

# ---- Health / regression ----
class TestRegression:
    def test_v1_health(self):
        r = requests.get(f"{API}/v1/health", timeout=10)
        assert r.status_code == 200, r.text
        j = r.json()
        # Just make sure it returns JSON with something like status/ok
        assert isinstance(j, dict)


# ---- Admin stats shape ----
class TestAdminStatsShape:
    def test_stats_has_channel_buckets(self, admin_headers):
        r = requests.get(f"{API}/admin/stats?period=year",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        tx = r.json().get("transactions", {})
        dep_ch = tx.get("deposits_by_channel", {})
        wd_ch = tx.get("withdrawals_by_channel", {})
        for side, buckets in (("deposits", dep_ch), ("withdrawals", wd_ch)):
            for ch in ("mobile_money", "crypto"):
                assert ch in buckets, f"{side}.{ch} missing"
                b = buckets[ch]
                for k in ("pending", "valid", "rejected"):
                    assert k in b, f"{side}.{ch}.{k} missing"
                    assert "count" in b[k] and "amount" in b[k]


# ---- Deposit approve/reject + balance side-effects ----
class TestDepositApproveReject:
    def test_approve_deposit_credits_xof(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "deposit_mm")
        # Get balance before
        me1 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_before = float(me1.get("balance_xof", 0) or 0)
        # Approve
        r = requests.post(f"{API}/admin/transactions/{tx_id}/approve",
                          headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("ok") is True
        assert j["tx"]["status"] == "completed"
        # Balance credited by amount_net (990)
        me2 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_after = float(me2.get("balance_xof", 0) or 0)
        assert round(bal_after - bal_before, 2) == 990.0, \
            f"expected +990 XOF, got {bal_after-bal_before}"

    def test_reject_deposit_no_credit(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "deposit_mm")
        me1 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_before = float(me1.get("balance_xof", 0) or 0)
        r = requests.post(f"{API}/admin/transactions/{tx_id}/reject",
                          headers=admin_headers,
                          json={"reason": "test reject deposit"}, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["tx"]["status"] == "failed"
        me2 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_after = float(me2.get("balance_xof", 0) or 0)
        assert abs(bal_after - bal_before) < 0.01, \
            "deposit reject must NOT credit balance"


# ---- Withdrawal approve/reject ----
class TestWithdrawalApproveReject:
    def test_approve_withdrawal_no_balance_change(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "withdrawal_mm")
        me1 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_before = float(me1.get("balance_xof", 0) or 0)
        r = requests.post(f"{API}/admin/transactions/{tx_id}/approve",
                          headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["tx"]["status"] == "completed"
        me2 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_after = float(me2.get("balance_xof", 0) or 0)
        assert abs(bal_after - bal_before) < 0.01

    def test_reject_withdrawal_refunds_total_debit_crypto(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "withdrawal_crypto")
        me1 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_before = float(me1.get("balance_usdt", 0) or 0)
        r = requests.post(f"{API}/admin/transactions/{tx_id}/reject",
                          headers=admin_headers,
                          json={"reason": "kyc missing"}, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["tx"]["status"] == "failed"
        assert abs(float(j.get("refunded", 0)) - 5.2) < 0.01, j
        me2 = requests.get(f"{API}/auth/me", headers=admin_headers).json()
        bal_after = float(me2.get("balance_usdt", 0) or 0)
        assert round(bal_after - bal_before, 2) == 5.2

    def test_double_action_rejected(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "withdrawal_mm")
        r1 = requests.post(f"{API}/admin/transactions/{tx_id}/approve",
                           headers=admin_headers, timeout=15)
        assert r1.status_code == 200
        # Second attempt → 400
        r2 = requests.post(f"{API}/admin/transactions/{tx_id}/approve",
                           headers=admin_headers, timeout=15)
        assert r2.status_code == 400, r2.text
        r3 = requests.post(f"{API}/admin/transactions/{tx_id}/reject",
                           headers=admin_headers, json={"reason": "x"}, timeout=15)
        assert r3.status_code == 400, r3.text


# ---- Detail endpoint ----
class TestAdminTxDetail:
    def test_detail_returns_user_info(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "deposit_crypto")
        r = requests.get(f"{API}/admin/transactions/{tx_id}",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["id"] == tx_id
        assert "user" in j and isinstance(j["user"], dict)
        assert j["user"].get("email") == ADMIN_EMAIL
        assert "metadata" in j
        assert j["metadata"].get("coin") == "USDT"

    def test_detail_404(self, admin_headers):
        r = requests.get(f"{API}/admin/transactions/nope-does-not-exist",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 404


# ---- Notifications ----
class TestNotificationSideEffect:
    def test_notification_created_on_approve(self, admin_headers, admin_user_id):
        tx_id = _insert_pending(admin_user_id, "deposit_mm")
        r = requests.post(f"{API}/admin/transactions/{tx_id}/approve",
                          headers=admin_headers, timeout=15)
        assert r.status_code == 200
        n = _find_notification(admin_user_id, tx_id)
        assert n is not None, "notification not persisted"
        assert "valid" in n["title"].lower()


# ---- PDF documentation ----
class TestDocumentationPDF:
    def test_pdf_download(self, admin_headers):
        r = requests.get(f"{API}/documentation.pdf",
                         headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"status={r.status_code} body={r.text[:200]}"
        ct = r.headers.get("content-type", "")
        assert "application/pdf" in ct, f"unexpected content-type: {ct}"
        assert r.content[:5] == b"%PDF-", "not a valid PDF header"
        assert len(r.content) > 5000, f"PDF too small ({len(r.content)} bytes)"

    def test_pdf_requires_auth(self):
        r = requests.get(f"{API}/documentation.pdf", timeout=10)
        assert r.status_code in (401, 403), r.status_code
