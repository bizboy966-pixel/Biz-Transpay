"""Iteration 17 — Biz-Transpay public API (v1) + merchant keys CRUD tests."""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback: read from frontend .env (test runs from repo root).
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")

ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PWD = "Password123!"


# ---------------- fixtures ----------------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def jwt_token(session):
    r = session.post(f"{BASE_URL}/api/auth/login",
                     json={"email": ADMIN_EMAIL, "password": ADMIN_PWD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def auth_headers(jwt_token):
    return {"Authorization": f"Bearer {jwt_token}"}


@pytest.fixture(scope="module")
def api_key(session, auth_headers):
    """Create a fresh sk_test_ merchant API key for the test module."""
    name = f"TEST_iter17_{uuid.uuid4().hex[:8]}"
    r = session.post(f"{BASE_URL}/api/merchant/keys",
                     json={"name": name, "env": "test"}, headers=auth_headers)
    assert r.status_code in (200, 201), f"create key: {r.status_code} {r.text}"
    body = r.json()
    assert "secret" in body and body["secret"].startswith("sk_test_"), body
    return {"id": body["id"], "secret": body["secret"], "name": name}


# ---------------- v1/health ----------------
class TestHealth:
    def test_health_public(self, session):
        r = session.get(f"{BASE_URL}/api/v1/health")
        assert r.status_code == 200
        j = r.json()
        assert j.get("status") == "ok"
        assert "version" in j
        assert isinstance(j.get("uptime_seconds"), int)


# ---------------- auth error format ----------------
class TestAuthErrors:
    def test_missing_auth_header_returns_normalised_401(self, session):
        r = session.post(f"{BASE_URL}/api/v1/payments", json={"amount": 5})
        assert r.status_code == 401
        j = r.json()
        assert j.get("code") == "MISSING_AUTH_HEADER"
        assert j.get("statusCode") == 401
        assert "message" in j

    def test_invalid_key_format(self, session):
        r = session.post(f"{BASE_URL}/api/v1/payments",
                         json={"amount": 5},
                         headers={"Authorization": "Bearer garbage_key"})
        assert r.status_code == 401
        assert r.json().get("code") == "INVALID_API_KEY_FORMAT"


# ---------------- merchant keys CRUD ----------------
class TestMerchantKeysCRUD:
    def test_list_keys_contains_created(self, session, auth_headers, api_key):
        r = session.get(f"{BASE_URL}/api/merchant/keys", headers=auth_headers)
        assert r.status_code == 200
        ids = [k["id"] for k in r.json().get("data", [])]
        assert api_key["id"] in ids

    def test_create_returns_plaintext_once(self, session, auth_headers):
        r = session.post(f"{BASE_URL}/api/merchant/keys",
                         json={"name": f"TEST_iter17_reveal_{uuid.uuid4().hex[:6]}",
                               "env": "test"}, headers=auth_headers)
        assert r.status_code in (200, 201)
        assert r.json().get("secret", "").startswith("sk_test_")
        # Refetch — plaintext must NOT be echoed anymore.
        r2 = session.get(f"{BASE_URL}/api/merchant/keys", headers=auth_headers)
        got = next((k for k in r2.json()["data"] if k["id"] == r.json()["id"]), None)
        assert got and "secret" not in got

    def test_regenerate_rotates_and_returns_new_plaintext(
            self, session, auth_headers):
        r = session.post(f"{BASE_URL}/api/merchant/keys",
                         json={"name": f"TEST_iter17_regen_{uuid.uuid4().hex[:6]}",
                               "env": "test"}, headers=auth_headers)
        kid = r.json()["id"]
        old_secret = r.json()["secret"]
        r2 = session.post(f"{BASE_URL}/api/merchant/keys/{kid}/regenerate",
                          headers=auth_headers)
        assert r2.status_code == 200
        new_secret = r2.json().get("secret")
        assert new_secret and new_secret != old_secret
        assert new_secret.startswith("sk_test_")

    def test_patch_disable_key_blocks_v1(self, session, auth_headers):
        # Create fresh key
        r = session.post(f"{BASE_URL}/api/merchant/keys",
                         json={"name": f"TEST_iter17_patch_{uuid.uuid4().hex[:6]}",
                               "env": "test"}, headers=auth_headers)
        kid = r.json()["id"]
        sec = r.json()["secret"]
        # Confirm it works first
        r0 = session.get(f"{BASE_URL}/api/v1/payments",
                         headers={"Authorization": f"Bearer {sec}"})
        assert r0.status_code == 200
        # Disable
        r1 = session.patch(f"{BASE_URL}/api/merchant/keys/{kid}",
                           json={"active": False}, headers=auth_headers)
        assert r1.status_code == 200
        assert r1.json()["active"] is False
        # Now v1 must reject
        r2 = session.get(f"{BASE_URL}/api/v1/payments",
                         headers={"Authorization": f"Bearer {sec}"})
        assert r2.status_code == 403
        assert r2.json().get("code") == "API_KEY_DISABLED"

    def test_delete_key(self, session, auth_headers):
        r = session.post(f"{BASE_URL}/api/merchant/keys",
                         json={"name": f"TEST_iter17_del_{uuid.uuid4().hex[:6]}",
                               "env": "test"}, headers=auth_headers)
        kid = r.json()["id"]
        r2 = session.delete(f"{BASE_URL}/api/merchant/keys/{kid}",
                            headers=auth_headers)
        assert r2.status_code == 200
        # Second delete → 404
        r3 = session.delete(f"{BASE_URL}/api/merchant/keys/{kid}",
                            headers=auth_headers)
        assert r3.status_code == 404


# ---------------- v1 payments (real IziChange) ----------------
class TestV1Payments:
    _shared: dict = {}

    def _hdr(self, api_key, extra=None):
        h = {"Authorization": f"Bearer {api_key['secret']}",
             "Content-Type": "application/json"}
        if extra:
            h.update(extra)
        return h

    def test_create_payment(self, session, api_key):
        ref = f"TEST_iter17_ref_{uuid.uuid4().hex[:6]}"
        r = session.post(f"{BASE_URL}/api/v1/payments",
                         json={"amount": 5, "coin": "USDT",
                               "accepted_networks": ["TRC20"],
                               "reference": ref},
                         headers=self._hdr(api_key))
        assert r.status_code in (200, 201), f"{r.status_code} {r.text}"
        j = r.json()
        assert "id" in j and j["status"] == "initiated"
        assert j.get("payment_url"), "payment_url missing"
        assert "expires_at" in j
        TestV1Payments._shared["id"] = j["id"]
        TestV1Payments._shared["reference"] = ref

    def test_idempotency_returns_same_id(self, session, api_key):
        idem = f"idem-{uuid.uuid4().hex}"
        payload = {"amount": 5, "coin": "USDT",
                   "accepted_networks": ["TRC20"],
                   "reference": f"TEST_iter17_idem_{uuid.uuid4().hex[:6]}"}
        r1 = session.post(f"{BASE_URL}/api/v1/payments", json=payload,
                          headers=self._hdr(api_key, {"Idempotency-Key": idem}))
        assert r1.status_code in (200, 201), r1.text
        r2 = session.post(f"{BASE_URL}/api/v1/payments", json=payload,
                          headers=self._hdr(api_key, {"Idempotency-Key": idem}))
        assert r2.status_code in (200, 201), r2.text
        assert r1.json()["id"] == r2.json()["id"], "idempotency violated"

    def test_get_payment_details(self, session, api_key):
        pid = self._shared.get("id")
        assert pid, "prior create test must have run first"
        r = session.get(f"{BASE_URL}/api/v1/payments/{pid}",
                        headers=self._hdr(api_key))
        assert r.status_code == 200
        assert r.json()["id"] == pid

    def test_get_payment_status(self, session, api_key):
        pid = self._shared["id"]
        r = session.get(f"{BASE_URL}/api/v1/payments/{pid}/status",
                        headers=self._hdr(api_key))
        assert r.status_code == 200
        j = r.json()
        assert set(j.keys()) >= {"id", "status", "updated_at"}
        assert j["id"] == pid

    def test_get_payment_completed(self, session, api_key):
        pid = self._shared["id"]
        r = session.get(f"{BASE_URL}/api/v1/payments/{pid}/completed",
                        headers=self._hdr(api_key))
        assert r.status_code == 200
        j = r.json()
        assert j["id"] == pid
        assert isinstance(j["completed"], bool)
        assert j["completed"] is False  # brand new intent

    def test_search_by_reference(self, session, api_key):
        ref = self._shared["reference"]
        r = session.get(f"{BASE_URL}/api/v1/payments/search",
                        params={"reference": ref},
                        headers=self._hdr(api_key))
        assert r.status_code == 200
        assert r.json()["reference"] == ref

    def test_search_unknown_reference_404(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payments/search",
                        params={"reference": "TEST_missing_ref_xyz"},
                        headers=self._hdr(api_key))
        assert r.status_code == 404
        assert r.json().get("code") == "PAYMENT_NOT_FOUND"

    def test_list_pagination(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payments",
                        params={"limit": 10, "offset": 0},
                        headers=self._hdr(api_key))
        assert r.status_code == 200
        j = r.json()
        for key in ("data", "count", "total", "offset", "limit", "has_more"):
            assert key in j, f"missing {key} in list response"
        assert isinstance(j["data"], list)

    def test_cancel_payment_idempotent(self, session, api_key):
        # Create a fresh payment to cancel (avoid mutating shared one)
        r = session.post(f"{BASE_URL}/api/v1/payments",
                         json={"amount": 5, "coin": "USDT",
                               "accepted_networks": ["TRC20"],
                               "reference": f"TEST_iter17_cancel_{uuid.uuid4().hex[:6]}"},
                         headers=self._hdr(api_key))
        assert r.status_code in (200, 201), r.text
        pid = r.json()["id"]
        r1 = session.post(f"{BASE_URL}/api/v1/payments/{pid}/cancel",
                          headers=self._hdr(api_key))
        assert r1.status_code == 200, r1.text
        assert r1.json()["status"] == "canceled"
        # Second call idempotent
        r2 = session.post(f"{BASE_URL}/api/v1/payments/{pid}/cancel",
                          headers=self._hdr(api_key))
        assert r2.status_code == 200
        assert r2.json()["status"] == "canceled"


# ---------------- Retired routes ----------------
class TestRetiredRoutes:
    def test_v1_mobile_money_gone(self, session, api_key):
        # These routes should not exist under /v1/*
        for path in ("/api/v1/mobile-money/pay", "/api/v1/mobile-money"):
            r = session.post(f"{BASE_URL}{path}", json={},
                             headers={"Authorization": f"Bearer {api_key['secret']}"})
            assert r.status_code == 404, f"{path} unexpectedly returned {r.status_code}"

    def test_legacy_api_keys_410(self, session, auth_headers):
        r = session.get(f"{BASE_URL}/api/api-keys", headers=auth_headers)
        assert r.status_code == 410
        assert r.json().get("code") == "MODULE_RETIRED"

    def test_legacy_webhooks_410(self, session, auth_headers):
        r = session.get(f"{BASE_URL}/api/merchant/webhooks", headers=auth_headers)
        assert r.status_code == 410
        assert r.json().get("code") == "MODULE_RETIRED"
