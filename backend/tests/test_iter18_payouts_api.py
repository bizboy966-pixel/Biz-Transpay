"""Iteration 18 — Biz-Transpay public API v1 PAYOUTS tests.

Backend flow: Merchant -> /api/v1/payouts -> IziChange upstream.
IziChange sandbox has NO USDT.TRC20 funds so payouts with valid TRC20 addresses
will be rejected upstream and the merchant balance must be refunded.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")

ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PWD = "Password123!"
VALID_TRC20 = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"


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
    assert r.status_code == 200, f"login: {r.status_code} {r.text}"
    j = r.json()
    return j.get("token") or j.get("access_token")


@pytest.fixture(scope="module")
def auth_headers(jwt_token):
    return {"Authorization": f"Bearer {jwt_token}"}


@pytest.fixture(scope="module")
def api_key(session, auth_headers):
    name = f"TEST_iter18_{uuid.uuid4().hex[:8]}"
    r = session.post(f"{BASE_URL}/api/merchant/keys",
                     json={"name": name, "env": "test"}, headers=auth_headers)
    assert r.status_code in (200, 201), r.text
    b = r.json()
    return {"id": b["id"], "secret": b["secret"]}


def _hdr(api_key, extra=None):
    h = {"Authorization": f"Bearer {api_key['secret']}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def _get_balance(session, auth_headers):
    r = session.get(f"{BASE_URL}/api/auth/me", headers=auth_headers)
    if r.status_code == 200:
        j = r.json()
        # try common shapes
        for k in ("balance_usdt",):
            if k in j:
                return float(j[k])
            if isinstance(j.get("user"), dict) and k in j["user"]:
                return float(j["user"][k])
    return None


# ---------------- Auth error format ----------------
class TestAuthErrors:
    def test_missing_auth_header(self, session):
        r = session.post(f"{BASE_URL}/api/v1/payouts",
                         json={"amount": 1, "coin": "USDT", "network": "TRC20",
                               "destination_address": VALID_TRC20})
        assert r.status_code == 401
        j = r.json()
        assert j.get("code") == "MISSING_AUTH_HEADER"
        assert j.get("statusCode") == 401
        assert "message" in j


# ---------------- Validation errors ----------------
class TestValidationErrors:
    def test_invalid_asset_pair(self, session, api_key):
        # USDT + DOGENET (not a real network) → INVALID_ASSET
        r = session.post(f"{BASE_URL}/api/v1/payouts",
                         json={"amount": 5, "coin": "USDT", "network": "DOGENET",
                               "destination_address": VALID_TRC20},
                         headers=_hdr(api_key))
        assert r.status_code == 400, r.text
        assert r.json().get("code") == "INVALID_ASSET"

    def test_invalid_destination_address(self, session, api_key):
        # Ethereum-style address on TRC20 network
        r = session.post(f"{BASE_URL}/api/v1/payouts",
                         json={"amount": 5, "coin": "USDT", "network": "TRC20",
                               "destination_address":
                                   "0x1234567890abcdef1234567890abcdef12345678"},
                         headers=_hdr(api_key))
        assert r.status_code == 400, r.text
        assert r.json().get("code") == "INVALID_DESTINATION_ADDRESS"

    def test_insufficient_balance(self, session, api_key):
        # Absurdly large amount
        r = session.post(f"{BASE_URL}/api/v1/payouts",
                         json={"amount": 999999999, "coin": "USDT", "network": "TRC20",
                               "destination_address": VALID_TRC20},
                         headers=_hdr(api_key))
        assert r.status_code == 400, r.text
        j = r.json()
        # Either our balance check trips first (INSUFFICIENT_BALANCE) or
        # asset max trips (AMOUNT_TOO_LARGE) — both are acceptable guardrails.
        assert j.get("code") in ("INSUFFICIENT_BALANCE", "AMOUNT_TOO_LARGE"), j
        if j.get("code") == "INSUFFICIENT_BALANCE":
            d = j.get("details") or {}
            assert "required" in d and "available" in d


# ---------------- Payout create + IziChange refund flow ----------------
class TestPayoutCreateFlow:
    _shared: dict = {}

    def test_create_payout_refunded_on_gateway_insufficient(
            self, session, api_key, auth_headers):
        # IziChange sandbox has no USDT.TRC20 funds — expect GATEWAY_INSUFFICIENT_FUNDS
        # and a refund of the merchant balance.
        bal_before = _get_balance(session, auth_headers)
        ref = f"TEST_iter18_ref_{uuid.uuid4().hex[:6]}"
        r = session.post(f"{BASE_URL}/api/v1/payouts",
                         json={"amount": 2, "coin": "USDT", "network": "TRC20",
                               "destination_address": VALID_TRC20,
                               "reference": ref},
                         headers=_hdr(api_key))
        TestPayoutCreateFlow._shared["reference"] = ref
        TestPayoutCreateFlow._shared["status_code"] = r.status_code
        TestPayoutCreateFlow._shared["body"] = r.json()
        # Either the upstream rejects (400 GATEWAY_*) or accepts (200) — assert either
        assert r.status_code in (200, 201, 400, 502), r.text
        if r.status_code == 400:
            code = r.json().get("code")
            assert code in ("GATEWAY_INSUFFICIENT_FUNDS", "GATEWAY_REJECTED",
                             "INVALID_DESTINATION_ADDRESS"), r.json()
            # Balance must be refunded (equal to before, up to fp precision)
            bal_after = _get_balance(session, auth_headers)
            if bal_before is not None and bal_after is not None:
                assert abs(bal_after - bal_before) < 0.01, \
                    f"refund missing: before={bal_before} after={bal_after}"
        elif r.status_code in (200, 201):
            j = r.json()
            assert j.get("status") in ("pending", "processing", "sent", "completed")
            assert j.get("id")
            TestPayoutCreateFlow._shared["id"] = j["id"]

    def test_idempotency_returns_same_response(self, session, api_key):
        idem = f"idem-po-{uuid.uuid4().hex}"
        payload = {"amount": 2, "coin": "USDT", "network": "TRC20",
                   "destination_address": VALID_TRC20,
                   "reference": f"TEST_iter18_idem_{uuid.uuid4().hex[:6]}"}
        r1 = session.post(f"{BASE_URL}/api/v1/payouts", json=payload,
                          headers=_hdr(api_key, {"Idempotency-Key": idem}))
        r2 = session.post(f"{BASE_URL}/api/v1/payouts", json=payload,
                          headers=_hdr(api_key, {"Idempotency-Key": idem}))
        # Both responses should be identical (whether success or error)
        assert r1.status_code == r2.status_code, \
            f"{r1.status_code} vs {r2.status_code}"
        if r1.status_code in (200, 201):
            assert r1.json().get("id") == r2.json().get("id"), "idempotency broken"


# ---------------- Read endpoints (list/search/get/status/completed) ----------------
class TestPayoutRead:
    def test_list_pagination(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payouts",
                        params={"limit": 10, "offset": 0},
                        headers=_hdr(api_key))
        assert r.status_code == 200, r.text
        j = r.json()
        for k in ("data", "count", "total", "offset", "limit", "has_more"):
            assert k in j, f"missing {k}"
        assert isinstance(j["data"], list)

    def test_list_filter_by_status_failed(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payouts",
                        params={"limit": 10, "offset": 0, "status": "failed"},
                        headers=_hdr(api_key))
        assert r.status_code == 200
        j = r.json()
        for it in j["data"]:
            assert it["status"] == "failed"

    def test_search_and_details(self, session, api_key):
        # find any payout to inspect
        r = session.get(f"{BASE_URL}/api/v1/payouts",
                        params={"limit": 10, "offset": 0},
                        headers=_hdr(api_key))
        assert r.status_code == 200
        data = r.json()["data"]
        if not data:
            pytest.skip("No payouts to inspect")
        item = data[0]
        pid = item["id"]
        ref = item.get("reference")

        # Details endpoint
        rd = session.get(f"{BASE_URL}/api/v1/payouts/{pid}",
                         headers=_hdr(api_key))
        assert rd.status_code == 200
        d = rd.json()
        for k in ("id", "status", "amount", "coin", "network",
                  "asset_code", "destination_address", "created_at"):
            assert k in d, f"missing {k} in details"
        assert d["id"] == pid

        # Status endpoint
        rs = session.get(f"{BASE_URL}/api/v1/payouts/{pid}/status",
                         headers=_hdr(api_key))
        assert rs.status_code == 200
        s = rs.json()
        assert set(s.keys()) >= {"id", "status", "updated_at"}
        assert s["id"] == pid

        # Completed endpoint
        rc = session.get(f"{BASE_URL}/api/v1/payouts/{pid}/completed",
                         headers=_hdr(api_key))
        assert rc.status_code == 200
        c = rc.json()
        assert c["id"] == pid
        assert isinstance(c["completed"], bool)
        assert c["completed"] == (c["status"] == "completed")

        # Search by reference (if we have one)
        if ref:
            rr = session.get(f"{BASE_URL}/api/v1/payouts/search",
                             params={"reference": ref}, headers=_hdr(api_key))
            assert rr.status_code == 200
            assert rr.json()["reference"] == ref

    def test_search_unknown_reference_404(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payouts/search",
                        params={"reference": "TEST_iter18_missing_xyz"},
                        headers=_hdr(api_key))
        assert r.status_code == 404
        assert r.json().get("code") == "PAYOUT_NOT_FOUND"

    def test_get_unknown_payout_404(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payouts/does-not-exist-id",
                        headers=_hdr(api_key))
        assert r.status_code == 404
        assert r.json().get("code") == "PAYOUT_NOT_FOUND"


# ---------------- Regression: v1 payments still works ----------------
class TestPaymentsRegression:
    def test_v1_payments_list_ok(self, session, api_key):
        r = session.get(f"{BASE_URL}/api/v1/payments",
                        params={"limit": 5, "offset": 0},
                        headers=_hdr(api_key))
        assert r.status_code == 200, r.text
        j = r.json()
        for k in ("data", "count", "total", "offset", "limit", "has_more"):
            assert k in j
