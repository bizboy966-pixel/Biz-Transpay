"""Iteration 10 — Real-time notification system tests.

Covers:
- Notification creation on KYC approve / reject / resubmit
- GET /notifications sorting, unread-count, mark-read, mark-all
- User-isolation on mark-read
- SSE /notifications/stream: connected preamble, real-time push, invalid token 401
- Regression: iter9 fixes still work (USDT public link, crypto guard, admin cleanup 403)
"""
import os
import json
import time
import threading
import uuid
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://secure-pay-preview.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PWD = "Password123!"


# ------------------------ fixtures ------------------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=15)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def merchant():
    """Register a fresh merchant m_notif_<rand>@test.com."""
    suffix = uuid.uuid4().hex[:6]
    email = f"m_notif_{suffix}@test.com"
    username = f"mnotif{suffix}"
    payload = {
        "full_name": "Notif Merchant",
        "username": username,
        "account_type": "merchant",
        "country": "SN",
        "phone": "+221771234567",
        "email": email,
        "password": "Password123!",
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    assert r.status_code == 200, f"Register failed: {r.status_code} {r.text}"
    j = r.json()
    return {"token": j["token"], "id": j["user"]["id"], "email": email}


@pytest.fixture(scope="session")
def second_merchant():
    suffix = uuid.uuid4().hex[:6]
    email = f"m_notif2_{suffix}@test.com"
    payload = {
        "full_name": "Notif Merchant B",
        "username": f"mnotifb{suffix}",
        "account_type": "merchant",
        "country": "SN",
        "phone": "+221771234568",
        "email": email,
        "password": "Password123!",
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    assert r.status_code == 200
    j = r.json()
    return {"token": j["token"], "id": j["user"]["id"], "email": email}


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _submit_kyc(token):
    r = requests.post(f"{API}/kyc/submit", headers=_auth(token), json={
        "full_name": "Test Merchant",
        "phone": "+221770000000",
        "document_type": "cni",
        "document_number": "SN" + uuid.uuid4().hex[:8].upper(),
        "activity_description": "Ecommerce test",
    }, timeout=15)
    assert r.status_code == 200, f"KYC submit failed: {r.status_code} {r.text}"


# ------------------------ tests ------------------------
class TestNotificationsCore:
    def test_kyc_approve_creates_notification(self, admin_token, merchant):
        _submit_kyc(merchant["token"])
        r = requests.post(f"{API}/admin/kyc/{merchant['id']}/decision",
                          headers=_auth(admin_token),
                          json={"approve": True, "reason": ""}, timeout=15)
        assert r.status_code == 200, r.text
        # give notify() a moment
        time.sleep(0.5)
        r = requests.get(f"{API}/notifications", headers=_auth(merchant["token"]), timeout=15)
        assert r.status_code == 200
        docs = r.json()
        assert any(d["type"] == "kyc_verified" for d in docs), f"No kyc_verified notif in {docs}"
        # Check structure
        n = next(d for d in docs if d["type"] == "kyc_verified")
        assert n["read"] is False
        assert "id" in n and "title" in n and "body" in n and "created_at" in n
        assert "_id" not in n

    def test_kyc_reject_creates_notification_with_reason(self, admin_token, second_merchant):
        _submit_kyc(second_merchant["token"])
        reason = "Document illisible - iter10 test"
        r = requests.post(f"{API}/admin/kyc/{second_merchant['id']}/decision",
                          headers=_auth(admin_token),
                          json={"approve": False, "reason": reason}, timeout=15)
        assert r.status_code == 200, r.text
        time.sleep(0.5)
        r = requests.get(f"{API}/notifications", headers=_auth(second_merchant["token"]), timeout=15)
        assert r.status_code == 200
        docs = r.json()
        rej = [d for d in docs if d["type"] == "kyc_rejected"]
        assert rej, f"No kyc_rejected notif: {docs}"
        assert reason in rej[0]["body"]
        assert rej[0]["data"].get("reason") == reason

    def test_list_sorted_desc(self, merchant):
        r = requests.get(f"{API}/notifications", headers=_auth(merchant["token"]), timeout=15)
        assert r.status_code == 200
        docs = r.json()
        assert isinstance(docs, list)
        if len(docs) >= 2:
            for i in range(len(docs) - 1):
                assert docs[i]["created_at"] >= docs[i + 1]["created_at"], "Not sorted desc"

    def test_unread_count(self, merchant):
        r = requests.get(f"{API}/notifications/unread-count", headers=_auth(merchant["token"]), timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "count" in data and isinstance(data["count"], int)
        assert data["count"] >= 1

    def test_mark_single_read(self, merchant):
        docs = requests.get(f"{API}/notifications", headers=_auth(merchant["token"])).json()
        unread = [d for d in docs if not d["read"]]
        assert unread, "expected at least one unread notif"
        nid = unread[0]["id"]
        before = requests.get(f"{API}/notifications/unread-count", headers=_auth(merchant["token"])).json()["count"]
        r = requests.post(f"{API}/notifications/{nid}/read", headers=_auth(merchant["token"]), timeout=15)
        assert r.status_code == 200
        after = requests.get(f"{API}/notifications/unread-count", headers=_auth(merchant["token"])).json()["count"]
        assert after == before - 1
        # Verify persisted
        docs2 = requests.get(f"{API}/notifications", headers=_auth(merchant["token"])).json()
        target = next(d for d in docs2 if d["id"] == nid)
        assert target["read"] is True

    def test_mark_all_read(self, second_merchant):
        # ensure there's at least 1 unread
        _submit_kyc(second_merchant["token"])
        # Also queue an approve so notif count > 0 for this merchant (already has rejected)
        r = requests.post(f"{API}/notifications/read-all", headers=_auth(second_merchant["token"]), timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert "updated" in j
        after = requests.get(f"{API}/notifications/unread-count", headers=_auth(second_merchant["token"])).json()["count"]
        assert after == 0

    def test_user_isolation_mark_read_404(self, merchant, second_merchant):
        docs_b = requests.get(f"{API}/notifications", headers=_auth(second_merchant["token"])).json()
        assert docs_b, "second_merchant should have notifs"
        # Mark all first so we get fresh unread by submitting kyc via admin
        # Try to have A mark B's notification
        target_id = docs_b[0]["id"]
        r = requests.post(f"{API}/notifications/{target_id}/read", headers=_auth(merchant["token"]), timeout=15)
        assert r.status_code == 404


class TestSSEStream:
    def test_stream_invalid_token(self):
        r = requests.get(f"{API}/notifications/stream", params={"token": "bogus.token.here"}, timeout=10, stream=True)
        assert r.status_code == 401

    def test_stream_missing_token(self):
        r = requests.get(f"{API}/notifications/stream", timeout=10)
        # FastAPI Query(...) => 422 for missing required query
        assert r.status_code in (401, 422)

    def test_stream_connected_and_push(self, admin_token, merchant):
        """Open SSE stream, then trigger a KYC resubmit → expect notification event within ~5s."""
        url = f"{API}/notifications/stream?token={merchant['token']}"
        events = []
        collected_connected = threading.Event()
        got_event = threading.Event()

        def reader():
            try:
                with requests.get(url, stream=True, timeout=20) as resp:
                    assert resp.status_code == 200
                    assert "text/event-stream" in resp.headers.get("Content-Type", "")
                    buf = ""
                    for chunk in resp.iter_content(chunk_size=1, decode_unicode=True):
                        if chunk is None:
                            continue
                        buf += chunk
                        if ": connected" in buf and not collected_connected.is_set():
                            collected_connected.set()
                        # SSE frames end with blank line
                        while "\n\n" in buf:
                            frame, buf = buf.split("\n\n", 1)
                            events.append(frame)
                            if frame.startswith("event: notification"):
                                got_event.set()
                                return
                        if got_event.is_set():
                            return
            except Exception as e:
                events.append(f"ERR:{e}")

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        # Wait for connection
        assert collected_connected.wait(timeout=8), f"No ': connected' preamble received; events={events}"

        # Trigger a KYC resubmit (creates kyc_resubmit_requested notification)
        _submit_kyc(merchant["token"])
        r = requests.post(f"{API}/admin/kyc/{merchant['id']}/decision",
                          headers=_auth(admin_token),
                          json={"approve": False, "request_resubmit": True,
                                "reason": "iter10 sse push test"}, timeout=15)
        assert r.status_code == 200, r.text

        # Wait up to 5s for the pushed event
        got = got_event.wait(timeout=6)
        assert got, f"SSE push not received within 6s. events collected: {events[:5]}"
        # Validate frame structure
        notif_frame = next(f for f in events if f.startswith("event: notification"))
        data_line = [ln for ln in notif_frame.split("\n") if ln.startswith("data:")][0]
        payload = json.loads(data_line[len("data:"):].strip())
        assert payload["type"] == "kyc_resubmit_requested"
        assert payload["user_id"] == merchant["id"]


# ------------------------ regression: iter9 fixes ------------------------
class TestIter9Regression:
    def test_usdt_public_link_still_exists(self):
        r = requests.get(f"{API}/links/public/nmfHFYS7DBE", timeout=15)
        # May return 200 if link exists, or 404 if wiped between iterations
        # We only assert no 500
        assert r.status_code in (200, 404)
        if r.status_code == 200:
            assert r.json().get("currency") == "USDT"

    def test_crypto_guard_on_xof_link(self):
        # If XOF link still exists, /links/pay should be rejected with 400
        r = requests.get(f"{API}/links/public/BD31WwuyhTA", timeout=15)
        if r.status_code != 200:
            pytest.skip("XOF public link no longer exists")
        pay = requests.post(f"{API}/links/pay", json={
            "slug": "BD31WwuyhTA",
            "method": "crypto",
            "amount": 100,
            "customer_email": "x@x.com",
            "customer_name": "x",
            "coin": "USDT",
            "network": "TRC20",
            "refund_address": "T" + "x" * 33,
            "origin_url": BASE,
        }, timeout=15)
        assert pay.status_code == 400
        assert "crypto" in pay.text.lower()

    def test_admin_cleanup_forbidden_without_token(self):
        r = requests.post(f"{API}/admin/users/cleanup-test-users", timeout=15)
        assert r.status_code in (401, 403)

    def test_admin_cleanup_forbidden_with_bogus(self):
        r = requests.post(f"{API}/admin/users/cleanup-test-users",
                          headers={"Authorization": "Bearer bogus"}, timeout=15)
        assert r.status_code in (401, 403)
