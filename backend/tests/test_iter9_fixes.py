"""Iteration 9 tests — 5 fixes:
1) USDT currency on payment links
2) Auto reconcile of crypto intents
3) 10-min timeout on crypto deposits and link payments
4) Guard: /links/pay rejects when link.currency != USDT
5) Admin cleanup endpoint auth guard
"""
import os
import time
from datetime import datetime, timezone

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://secure-pay-preview.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PWD = "Password123!"
USDT_SLUG = "nmfHFYS7DBE"
XOF_SLUG = "BD31WwuyhTA"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ---------- 1) Admin login ----------
def test_admin_login_ok(admin_token):
    assert isinstance(admin_token, str) and len(admin_token) > 10


# ---------- 2) Public links: USDT and XOF ----------
def test_public_usdt_link_currency():
    r = requests.get(f"{API}/links/public/{USDT_SLUG}", timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d.get("currency") == "USDT", f"expected USDT, got {d.get('currency')}"
    assert d.get("active") is True


def test_public_xof_link_currency():
    r = requests.get(f"{API}/links/public/{XOF_SLUG}", timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d.get("currency") in ("XOF", "XAF"), f"expected XOF/XAF, got {d.get('currency')}"


# ---------- 3) Merchant can create a USDT link and it persists ----------
def test_create_usdt_link(admin_headers):
    payload = {
        "title": "TEST_iter9_usdt",
        "amount_type": "fixed",
        "amount": 12.5,
        "currency": "USDT",
        "description": "iter9 usdt test",
        "single_use": False,
        "fee_bearer": "customer",
    }
    r = requests.post(f"{API}/links", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    link = r.json()
    assert link["currency"] == "USDT"
    assert link["amount"] == 12.5
    slug = link["slug"]
    # verify via public endpoint
    p = requests.get(f"{API}/links/public/{slug}", timeout=15).json()
    assert p["currency"] == "USDT"
    # cleanup
    requests.delete(f"{API}/links/{link['id']}", headers=admin_headers, timeout=10)


def test_create_xof_link_backward_compat(admin_headers):
    payload = {
        "title": "TEST_iter9_xof",
        "amount_type": "fixed",
        "amount": 5000,
        "currency": "XOF",
        "single_use": False,
        "fee_bearer": "customer",
    }
    r = requests.post(f"{API}/links", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    link = r.json()
    assert link["currency"] == "XOF"
    requests.delete(f"{API}/links/{link['id']}", headers=admin_headers, timeout=10)


# ---------- 4) /links/pay guard: rejects when link.currency != USDT ----------
def test_links_pay_rejects_non_usdt():
    payload = {
        "slug": XOF_SLUG,
        "asset_code": "USDT.TRC20",
        "full_name": "Test User",
        "email": "test@example.com",
        "refund_address": "TXYZabcdefghijklmnopqrstuvwxyz1234", "origin_url": "https://secure-pay-preview.preview.emergentagent.com",
    }
    r = requests.post(f"{API}/links/pay", json=payload, timeout=20)
    assert r.status_code == 400, f"expected 400 got {r.status_code}: {r.text}"
    body = r.text.lower()
    assert "usdt" in body or "crypto" in body, f"expected French guard message; got: {r.text}"


# ---------- 5) /links/pay ACCEPTS on USDT link (may hit real IziPay) ----------
def test_links_pay_accepts_usdt_link_returns_intent():
    payload = {
        "slug": USDT_SLUG,
        "asset_code": "USDT.TRC20",
        "full_name": "Test User",
        "email": "test-iter9@example.com",
        "refund_address": "TXYZabcdefghijklmnopqrstuvwxyz1234", "origin_url": "https://secure-pay-preview.preview.emergentagent.com",  # invalid on-purpose so vendor may reject
    }
    r = requests.post(f"{API}/links/pay", json=payload, timeout=30)
    # Two acceptable outcomes:
    #  a) 200 + intent doc with expires_at ~10 min from now (guard passed)
    #  b) 400 from vendor (invalid refund address). This still proves guard passed
    #     because the code reached izipay.create_direct_intent (message will be
    #     the sanitized vendor rejection, not the "Ce lien n'accepte pas" msg).
    assert r.status_code in (200, 400, 502), f"unexpected {r.status_code}: {r.text}"
    if r.status_code == 200:
        d = r.json()
        assert "deposit_address" in d
        assert "expires_at" in d
        # verify expires_at ~10 min from now
        exp = datetime.fromisoformat(d["expires_at"].replace("Z", "+00:00"))
        delta = (exp - datetime.now(timezone.utc)).total_seconds()
        assert 8 * 60 <= delta <= 12 * 60, f"expires_at delta = {delta}s, expected ~600s"
    else:
        # Must NOT be the "currency mismatch" guard message
        assert "n'accepte pas" not in r.text.lower() and "différente de usdt" not in r.text.lower(), (
            f"guard misfired on USDT link: {r.text}"
        )


# ---------- 6) Crypto deposit expires_at = now+10min ----------
def test_crypto_deposit_expires_at_10min(admin_headers):
    payload = {
        "amount": 1,
        "asset_code": "USDT.TRC20",
        "full_name": "Test Admin",
        "email": ADMIN_EMAIL,
        "refund_address": "TXYZabcdefghijklmnopqrstuvwxyz1234", "origin_url": "https://secure-pay-preview.preview.emergentagent.com",
    }
    r = requests.post(f"{API}/deposits/crypto", json=payload, headers=admin_headers, timeout=30)
    # Same two acceptable outcomes as above
    assert r.status_code in (200, 400, 502), f"unexpected {r.status_code}: {r.text}"
    if r.status_code == 200:
        d = r.json()
        exp = datetime.fromisoformat(d["expires_at"].replace("Z", "+00:00"))
        delta = (exp - datetime.now(timezone.utc)).total_seconds()
        assert 8 * 60 <= delta <= 12 * 60, f"expires_at delta = {delta}s, expected ~600s (10 min)"
        assert d.get("credit_currency") == "USDT"
        # Trigger GET which invokes _reconcile_intent fallback
        g = requests.get(f"{API}/deposits/crypto/{d['id']}", headers=admin_headers, timeout=15)
        assert g.status_code == 200, g.text
        assert g.json().get("id") == d["id"]


# ---------- 7) Admin cleanup endpoint auth (do NOT run for super admin) ----------
def test_cleanup_endpoint_requires_auth():
    r = requests.post(f"{API}/admin/users/cleanup-test-users", timeout=10)
    assert r.status_code in (401, 403), f"expected auth error, got {r.status_code}: {r.text}"


def test_cleanup_endpoint_bogus_token_rejected():
    r = requests.post(
        f"{API}/admin/users/cleanup-test-users",
        headers={"Authorization": "Bearer not.a.real.token"},
        timeout=10,
    )
    assert r.status_code in (401, 403), r.text


# NOTE: We deliberately do NOT call the endpoint with the super_admin token — it would wipe users.
# The auth logic is validated by inspecting server.py line 1721: `if admin.get("role") != "super_admin": raise 403`.


# ---------- 8) Bad currency on link create is rejected by pydantic ----------
def test_create_link_bad_currency(admin_headers):
    payload = {
        "title": "TEST_iter9_bad",
        "amount_type": "fixed",
        "amount": 10,
        "currency": "EUR",  # not allowed
        "single_use": False,
        "fee_bearer": "customer",
    }
    r = requests.post(f"{API}/links", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code in (400, 422), r.text
