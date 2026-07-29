"""Iteration 6: bug fixes for /dashboard/deposit whitepage, PublicLink refund_address optional, and login flow."""
import os
import time
import requests
import pytest

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
API = f"{BASE_URL}/api"

EMAIL = "test@biztranspay.com"
PASSWORD = "Password123!"
SLUG = "NcjVJwMQNLY"
REFUND_ADDR = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth(token):
    return {"Authorization": f"Bearer {token}"}


# --- BUG API TEST: POST /api/links/pay with empty refund_address ---
def test_link_pay_empty_refund_address_returns_200():
    body = {
        "slug": SLUG,
        "asset_code": "USDT.TRC20",
        "full_name": "Awa Diallo",
        "email": "awa@test.com",
        "refund_address": "",
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=60)
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:400]}"
    data = r.json()
    assert data.get("deposit_address", "").startswith("T"), data
    assert data.get("amount_to_send"), data
    assert "id" in data


def test_link_pay_missing_refund_address_returns_200():
    body = {
        "slug": SLUG,
        "asset_code": "USDT.TRC20",
        "full_name": "No Refund",
        "email": "nr@test.com",
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=60)
    assert r.status_code == 200, r.text[:400]


def test_link_pay_with_valid_refund_returns_200():
    """Sanity: link/pay with real Tron address works — proves link flow OK."""
    body = {
        "slug": SLUG,
        "asset_code": "USDT.TRC20",
        "full_name": "Awa Diallo",
        "email": "awa@test.com",
        "refund_address": REFUND_ADDR,
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/links/pay", json=body, timeout=60)
    assert r.status_code == 200, r.text[:400]
    assert r.json().get("deposit_address", "").startswith("T")


# --- VALIDATION: deposit crypto still strict ---
def test_deposit_crypto_empty_refund_address_returns_422(auth):
    body = {
        "amount": 2,
        "asset_code": "USDT.TRC20",
        "full_name": "Test User",
        "email": "test@example.com",
        "refund_address": "",
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/deposits/crypto", json=body, headers=auth, timeout=30)
    assert r.status_code == 422, f"Expected 422, got {r.status_code}: {r.text[:400]}"


def test_deposit_crypto_valid_returns_200(auth):
    body = {
        "amount": 2,
        "asset_code": "USDT.TRC20",
        "full_name": "Test User",
        "email": "test@example.com",
        "refund_address": REFUND_ADDR,
        "origin_url": "https://biz-transppayy.com",
    }
    r = requests.post(f"{API}/deposits/crypto", json=body, headers=auth, timeout=60)
    assert r.status_code == 200, r.text[:400]
    d = r.json()
    assert d.get("deposit_address", "").startswith("T"), d
    assert d.get("amount_to_send"), d


# --- REGRESSION ---
def test_auth_me(auth):
    r = requests.get(f"{API}/auth/me", headers=auth, timeout=15)
    assert r.status_code == 200


def test_links_list(auth):
    r = requests.get(f"{API}/links", headers=auth, timeout=15)
    assert r.status_code == 200
    slugs = [x.get("slug") for x in r.json()]
    assert SLUG in slugs or len(slugs) > 0


def test_crypto_assets_public():
    r = requests.get(f"{API}/crypto/assets", timeout=15)
    assert r.status_code == 200
    assert any(a.get("asset_code") == "USDT.TRC20" for a in r.json())
