"""Iteration 7: BUG C retest — refund_address is REQUIRED again on /api/links/pay.

Expectations after revert:
- refund_address="" or missing -> 422 (Pydantic min_length=1)
- refund_address="INVALIDADDR" -> 400 with 'Adresse de remboursement invalide.'
- refund_address=valid TRC20 -> 200 with deposit_address populated
- /api/deposits/crypto empty refund -> 422 (unchanged, regression)
"""
import os
import requests
import pytest

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://secure-pay-preview.preview.emergentagent.com').rstrip('/')
API = f"{BASE_URL}/api"

EMAIL = "test@biztranspay.com"
PASSWORD = "Password123!"
SLUG = "NcjVJwMQNLY"
REFUND_ADDR = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ---------- BUG C: /api/links/pay refund_address required ----------
def test_link_pay_empty_refund_returns_422():
    body = {
        "slug": SLUG, "asset_code": "USDT.TRC20",
        "full_name": "Awa Diallo", "email": "awa@test.com",
        "refund_address": "", "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=30)
    assert r.status_code == 422, f"Expected 422, got {r.status_code}: {r.text[:400]}"


def test_link_pay_missing_refund_returns_422():
    body = {
        "slug": SLUG, "asset_code": "USDT.TRC20",
        "full_name": "No Refund", "email": "nr@test.com",
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=30)
    assert r.status_code == 422, f"Expected 422, got {r.status_code}: {r.text[:400]}"


def test_link_pay_invalid_refund_returns_400_with_message():
    body = {
        "slug": SLUG, "asset_code": "USDT.TRC20",
        "full_name": "Bad", "email": "bad@test.com",
        "refund_address": "INVALIDADDR123",
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=60)
    assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text[:400]}"
    detail = (r.json() or {}).get("detail", "")
    assert "remboursement" in detail.lower() or "adresse" in detail.lower(), detail


def test_link_pay_valid_refund_returns_200():
    body = {
        "slug": SLUG, "asset_code": "USDT.TRC20",
        "full_name": "Awa Diallo", "email": "awa@test.com",
        "refund_address": REFUND_ADDR,
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=60)
    assert r.status_code == 200, r.text[:400]
    d = r.json()
    assert d.get("deposit_address", "").startswith("T"), d
    assert d.get("amount_to_send"), d


# ---------- Regression: deposit crypto ----------
def test_deposit_crypto_empty_refund_returns_422(auth):
    body = {
        "amount": 2, "asset_code": "USDT.TRC20",
        "full_name": "T", "email": "t@t.com",
        "refund_address": "", "origin_url": "https://x",
    }
    r = requests.post(f"{API}/deposits/crypto", json=body, headers=auth, timeout=30)
    assert r.status_code == 422, r.text[:400]


def test_deposit_crypto_valid_returns_200(auth):
    body = {
        "amount": 2, "asset_code": "USDT.TRC20",
        "full_name": "T", "email": "t@t.com",
        "refund_address": REFUND_ADDR, "origin_url": "https://x",
    }
    r = requests.post(f"{API}/deposits/crypto", json=body, headers=auth, timeout=60)
    assert r.status_code == 200, r.text[:400]
    assert r.json().get("deposit_address", "").startswith("T")


# ---------- Auth regression ----------
def test_auth_me(auth):
    r = requests.get(f"{API}/auth/me", headers=auth, timeout=15)
    assert r.status_code == 200
