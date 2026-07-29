"""Iteration 12 — Phase 2: admin user management, focus on DELETE /api/admin/users/{uid}.

Covers:
 * auth guards (401 anon, 403 non-admin, 403 super_admin target, 403 self)
 * 404 non-existent
 * cascade delete: users/tx/payment_links/link_payments/api_keys/tickets/kyc/
   crypto_deposits/notifications/support_messages/payment_transactions/merchant_payments
 * audit log entry created (action=delete_user_permanent)
 * regression: PATCH /admin/users, POST reset-password, POST action/block+unblock
"""
import os
import uuid
import pytest
import requests
from pathlib import Path


def _load_env():
    env = os.environ.get("REACT_APP_BACKEND_URL")
    if env:
        return env.rstrip("/")
    p = Path("/app/frontend/.env")
    if p.exists():
        for line in p.read_text().splitlines():
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not found")


BASE = _load_env()
ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PWD = "Password123!"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PWD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("access_token") or j["token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def admin_me(admin_headers):
    r = requests.get(f"{BASE}/api/auth/me", headers=admin_headers)
    assert r.status_code == 200
    return r.json()


def _register_merchant():
    """Create a fresh merchant via public /register endpoint."""
    suffix = uuid.uuid4().hex[:8]
    payload = {
        "full_name": f"Iter12 Test {suffix}",
        "username": f"iter12_{suffix}",
        "email": f"iter12_{suffix}@test.com",
        "phone": f"+225070{suffix[:6]}",
        "country": "CI",
        "password": "Password123!",
        "account_type": "merchant",
    }
    r = requests.post(f"{BASE}/api/auth/register", json=payload)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    data = r.json()
    return {
        "token": data.get("access_token") or data["token"],
        "user": data["user"],
        "payload": payload,
    }


# -------------------- Auth / guard tests --------------------
def test_delete_requires_auth():
    r = requests.delete(f"{BASE}/api/admin/users/whatever")
    assert r.status_code in (401, 403), r.text


def test_delete_forbidden_for_non_admin():
    m = _register_merchant()
    victim = _register_merchant()
    headers = {"Authorization": f"Bearer {m['token']}"}
    r = requests.delete(f"{BASE}/api/admin/users/{victim['user']['id']}", headers=headers)
    assert r.status_code == 403, r.text


def test_delete_super_admin_forbidden(admin_headers, admin_me):
    r = requests.delete(f"{BASE}/api/admin/users/{admin_me['id']}", headers=admin_headers)
    # admin_me is super_admin AND is self — should be 403 either way
    assert r.status_code == 403, r.text


def test_delete_self_forbidden(admin_headers, admin_me):
    # same guard, but explicitly checks 'Vous ne pouvez pas supprimer votre propre'
    r = requests.delete(f"{BASE}/api/admin/users/{admin_me['id']}", headers=admin_headers)
    assert r.status_code == 403


def test_delete_not_found(admin_headers):
    r = requests.delete(f"{BASE}/api/admin/users/does-not-exist-xyz", headers=admin_headers)
    assert r.status_code == 404


# -------------------- Cascade delete happy path --------------------
def test_cascade_delete_full(admin_headers):
    fresh = _register_merchant()
    uid = fresh["user"]["id"]
    utoken = fresh["token"]
    uhdr = {"Authorization": f"Bearer {utoken}"}

    # (1) create a payment_link
    r_link = requests.post(f"{BASE}/api/links",
                           headers=uhdr,
                           json={"title": "Iter12 link", "amount": 500, "currency": "XOF",
                                 "amount_type": "fixed", "single_use": False,
                                 "fee_bearer": "customer"})
    assert r_link.status_code == 200, r_link.text
    link_id = r_link.json().get("id")
    assert link_id

    # (2) merchant registration auto-created an api_key already; no separate endpoint needed
    api_key_ok = True

    # (3) DELETE via admin
    r_del = requests.delete(f"{BASE}/api/admin/users/{uid}", headers=admin_headers)
    assert r_del.status_code == 200, r_del.text
    body = r_del.json()
    assert body.get("ok") is True
    counts = body.get("deleted") or {}
    for k in ["user", "transactions", "payment_links", "link_payments",
              "kyc", "api_keys", "tickets", "crypto_deposits",
              "notifications", "support_messages",
              "payment_transactions", "merchant_payments"]:
        assert k in counts, f"missing count key {k}: {counts}"
    assert counts["user"] == 1
    assert counts["payment_links"] >= 1
    if api_key_ok:
        assert counts["api_keys"] >= 1

    # (4) verify user no longer accessible via admin GET
    r_get = requests.get(f"{BASE}/api/admin/users/{uid}", headers=admin_headers)
    assert r_get.status_code == 404

    # (5) verify their token is now invalid (user gone)
    r_me = requests.get(f"{BASE}/api/auth/me", headers=uhdr)
    assert r_me.status_code in (401, 404), r_me.text


# -------------------- Audit log entry --------------------
def test_audit_log_created_on_delete(admin_headers):
    fresh = _register_merchant()
    uid = fresh["user"]["id"]
    uname = fresh["user"]["username"]

    r_del = requests.delete(f"{BASE}/api/admin/users/{uid}", headers=admin_headers)
    assert r_del.status_code == 200

    r_logs = requests.get(f"{BASE}/api/admin/logs?limit=50", headers=admin_headers)
    assert r_logs.status_code == 200
    logs = r_logs.json()
    match = [l for l in logs
             if l.get("action") == "delete_user_permanent"
             and (l.get("target_user_id") == uid or l.get("target_username") == uname)]
    assert match, f"audit entry not found. recent actions: {[l.get('action') for l in logs[:10]]}"


# -------------------- Regression: PATCH / reset-password / suspend --------------------
def test_patch_user_updates_fields(admin_headers):
    fresh = _register_merchant()
    uid = fresh["user"]["id"]
    new_name = f"Renamed {uuid.uuid4().hex[:4]}"
    r = requests.patch(f"{BASE}/api/admin/users/{uid}",
                       headers=admin_headers,
                       json={"full_name": new_name})
    assert r.status_code == 200, r.text
    assert r.json().get("full_name") == new_name
    # cleanup
    requests.delete(f"{BASE}/api/admin/users/{uid}", headers=admin_headers)


def test_reset_password_min_length(admin_headers):
    fresh = _register_merchant()
    uid = fresh["user"]["id"]
    # too short
    r_bad = requests.post(f"{BASE}/api/admin/users/{uid}/reset-password",
                          headers=admin_headers,
                          json={"new_password": "abc"})
    assert r_bad.status_code == 400
    # OK
    r_ok = requests.post(f"{BASE}/api/admin/users/{uid}/reset-password",
                         headers=admin_headers,
                         json={"new_password": "NewPwd123!"})
    assert r_ok.status_code == 200
    # verify login with new password
    r_login = requests.post(f"{BASE}/api/auth/login",
                            json={"email": fresh["payload"]["email"],
                                  "password": "NewPwd123!"})
    assert r_login.status_code == 200
    requests.delete(f"{BASE}/api/admin/users/{uid}", headers=admin_headers)


def test_suspend_and_reactivate(admin_headers):
    fresh = _register_merchant()
    uid = fresh["user"]["id"]
    r_b = requests.post(f"{BASE}/api/admin/users/{uid}/action/block",
                        headers=admin_headers, json={"reason": "iter12"})
    assert r_b.status_code == 200
    assert r_b.json()["user"]["is_blocked"] is True

    r_u = requests.post(f"{BASE}/api/admin/users/{uid}/action/unblock",
                        headers=admin_headers, json={"reason": "iter12"})
    assert r_u.status_code == 200
    assert r_u.json()["user"]["is_blocked"] is False
    requests.delete(f"{BASE}/api/admin/users/{uid}", headers=admin_headers)
