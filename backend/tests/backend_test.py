"""Biz-transPay backend API test suite."""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://secure-pay-preview.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


# ---------- fixtures ----------
@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def unique_suffix():
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="session")
def merchant_user(session, unique_suffix):
    """Register a fresh merchant user for the entire test session."""
    payload = {
        "full_name": "TEST Merchant User",
        "username": f"testm{unique_suffix}",
        "account_type": "merchant",
        "country": "TG",
        "phone": "+22890000000",
        "email": f"test_m_{unique_suffix}@biztranspay.com",
        "password": "Password123!",
    }
    r = session.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and "user" in data
    return {"token": data["token"], "user": data["user"], "payload": payload}


@pytest.fixture(scope="session")
def personal_user(session, unique_suffix):
    payload = {
        "full_name": "TEST Personal User",
        "username": f"testp{unique_suffix}",
        "account_type": "personal",
        "country": "TG",
        "phone": "+22890000001",
        "email": f"test_p_{unique_suffix}@biztranspay.com",
        "password": "Password123!",
    }
    r = session.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    return {"token": data["token"], "user": data["user"], "payload": payload}


@pytest.fixture
def auth_headers(merchant_user):
    return {"Authorization": f"Bearer {merchant_user['token']}"}


# ---------- Auth tests ----------
class TestAuth:
    def test_register_returns_token_and_bonuses(self, merchant_user):
        u = merchant_user["user"]
        assert u["balance_xof"] == 25000.0
        assert u["balance_xaf"] == 15000.0
        assert u["account_type"] == "merchant"
        assert u["kyc_status"] == "not_started"

    def test_register_duplicate_email(self, session, merchant_user):
        r = session.post(f"{API}/auth/register", json=merchant_user["payload"])
        assert r.status_code == 400

    def test_login_with_email(self, session, merchant_user):
        r = session.post(f"{API}/auth/login", json={
            "email": merchant_user["payload"]["email"],
            "password": merchant_user["payload"]["password"],
        })
        assert r.status_code == 200
        assert "token" in r.json()

    def test_login_with_username(self, session, merchant_user):
        r = session.post(f"{API}/auth/login", json={
            "email": merchant_user["payload"]["username"],
            "password": merchant_user["payload"]["password"],
        })
        assert r.status_code == 200

    def test_login_invalid(self, session, merchant_user):
        r = session.post(f"{API}/auth/login", json={
            "email": merchant_user["payload"]["email"],
            "password": "wrong",
        })
        assert r.status_code == 401

    def test_me_requires_token(self, session):
        r = session.get(f"{API}/auth/me")
        assert r.status_code in (401, 403)

    def test_me_returns_user(self, session, auth_headers, merchant_user):
        r = session.get(f"{API}/auth/me", headers=auth_headers)
        assert r.status_code == 200
        assert r.json()["email"] == merchant_user["payload"]["email"]


# ---------- Wallet ----------
class TestWallet:
    def test_wallet_summary(self, session, auth_headers):
        r = session.get(f"{API}/wallet/summary", headers=auth_headers)
        assert r.status_code == 200
        d = r.json()
        for k in ("balance_xof", "balance_xaf", "transactions_count", "kyc_status"):
            assert k in d


# ---------- Transfer ----------
class TestTransfers:
    def test_biz_to_biz_transfer(self, session, auth_headers, personal_user, merchant_user):
        # merchant -> personal via username
        payload = {
            "transfer_type": "biz_to_biz",
            "recipient": personal_user["payload"]["username"],
            "recipient_name": personal_user["payload"]["full_name"],
            "amount": 1000,
            "currency": "XOF",
            "description": "TEST b2b",
        }
        r = session.post(f"{API}/transfers", headers=auth_headers, json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["transaction"]["reference"].startswith("BTP-")
        assert d["fee"] == 0.0

        # verify sender debited
        me = session.get(f"{API}/auth/me", headers=auth_headers).json()
        assert me["balance_xof"] <= 25000.0 - 1000

        # verify recipient credited
        pheaders = {"Authorization": f"Bearer {personal_user['token']}"}
        pme = session.get(f"{API}/auth/me", headers=pheaders).json()
        assert pme["balance_xof"] >= 25000.0 + 1000

    def test_biz_to_mobile_fee_1pct(self, session, auth_headers):
        r = session.post(f"{API}/transfers", headers=auth_headers, json={
            "transfer_type": "biz_to_mobile",
            "recipient": "+22890111111",
            "amount": 500,
            "currency": "XOF",
        })
        assert r.status_code == 200, r.text
        assert r.json()["fee"] == 5.0

    def test_biz_to_bank_fee_1_5pct(self, session, auth_headers):
        r = session.post(f"{API}/transfers", headers=auth_headers, json={
            "transfer_type": "biz_to_bank",
            "recipient": "TG123456789",
            "amount": 1000,
            "currency": "XOF",
        })
        assert r.status_code == 200, r.text
        assert r.json()["fee"] == 15.0

    def test_transfer_insufficient(self, session, auth_headers):
        r = session.post(f"{API}/transfers", headers=auth_headers, json={
            "transfer_type": "biz_to_biz",
            "recipient": "nobody",
            "amount": 9_999_999,
            "currency": "XOF",
        })
        assert r.status_code == 400


# ---------- Deposit (Stripe) ----------
class TestDeposit:
    def test_deposit_checkout_returns_url(self, session, auth_headers):
        r = session.post(f"{API}/deposits/checkout", headers=auth_headers, json={
            "amount": 5000,
            "currency": "XOF",
            "origin_url": "https://secure-pay-preview.preview.emergentagent.com",
        })
        # Stripe may or may not be reachable with sk_test_emergent
        if r.status_code == 500:
            pytest.skip(f"Stripe unavailable: {r.text}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert "checkout_url" in d and d["checkout_url"].startswith("https://")
        assert "session_id" in d
        # status endpoint (no auth)
        r2 = requests.get(f"{API}/payments/status/{d['session_id']}")
        assert r2.status_code == 200
        assert r2.json()["payment_status"] in ("pending", "paid")

    def test_deposit_minimum(self, session, auth_headers):
        r = session.post(f"{API}/deposits/checkout", headers=auth_headers, json={
            "amount": 10, "currency": "XOF",
            "origin_url": "https://x.example",
        })
        assert r.status_code == 400


# ---------- Exchange ----------
class TestExchange:
    def test_exchange_rate(self, session):
        r = session.get(f"{API}/exchange/rate?from_currency=XOF&to_currency=XAF")
        assert r.status_code == 200
        d = r.json()
        assert "rate" in d and "fee_pct" in d

    def test_exchange_execute(self, session, auth_headers):
        r = session.post(f"{API}/exchange", headers=auth_headers, json={
            "from_currency": "XOF", "to_currency": "XAF", "amount": 1000,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["fee"] == 5.0
        assert d["received"] == 995.0

    def test_exchange_same_currency(self, session, auth_headers):
        r = session.post(f"{API}/exchange", headers=auth_headers, json={
            "from_currency": "XOF", "to_currency": "XOF", "amount": 100,
        })
        assert r.status_code == 400


# ---------- Payment links ----------
class TestPaymentLinks:
    link_id = None
    slug = None

    def test_create_link(self, session, auth_headers):
        r = session.post(f"{API}/links", headers=auth_headers, json={
            "title": "TEST link", "amount": 5000, "currency": "XOF",
            "description": "test",
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["title"] == "TEST link"
        assert d["slug"]
        TestPaymentLinks.link_id = d["id"]
        TestPaymentLinks.slug = d["slug"]

    def test_list_links(self, session, auth_headers):
        r = session.get(f"{API}/links", headers=auth_headers)
        assert r.status_code == 200
        assert any(l["id"] == TestPaymentLinks.link_id for l in r.json())

    def test_public_link_no_auth(self, session):
        r = requests.get(f"{API}/links/public/{TestPaymentLinks.slug}")
        assert r.status_code == 200
        assert r.json()["slug"] == TestPaymentLinks.slug
        assert "merchant" in r.json()

    def test_update_link(self, session, auth_headers):
        r = session.patch(f"{API}/links/{TestPaymentLinks.link_id}", headers=auth_headers, json={
            "title": "TEST link updated"
        })
        assert r.status_code == 200
        assert r.json()["title"] == "TEST link updated"

    def test_delete_link(self, session, auth_headers):
        r = session.delete(f"{API}/links/{TestPaymentLinks.link_id}", headers=auth_headers)
        assert r.status_code == 200


# ---------- Transactions ----------
class TestTransactions:
    def test_list_transactions(self, session, auth_headers):
        r = session.get(f"{API}/transactions", headers=auth_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_filter_by_type(self, session, auth_headers):
        r = session.get(f"{API}/transactions?type=transfer", headers=auth_headers)
        assert r.status_code == 200
        for t in r.json():
            assert t["type"] == "transfer"


# ---------- KYC ----------
class TestKyc:
    def test_kyc_get(self, session, auth_headers):
        r = session.get(f"{API}/kyc", headers=auth_headers)
        assert r.status_code == 200

    def test_kyc_submit_auto_verified(self, session, auth_headers):
        r = session.post(f"{API}/kyc/submit", headers=auth_headers, json={
            "document_type": "id_card",
            "document_number": "TG1234567",
            "address": "Lome",
            "city": "Lome",
        })
        assert r.status_code == 200
        assert r.json()["status"] == "verified"
        me = session.get(f"{API}/auth/me", headers=auth_headers).json()
        assert me["kyc_status"] == "verified"


# ---------- API keys ----------
class TestApiKeys:
    def test_merchant_can_view(self, session, auth_headers):
        r = session.get(f"{API}/api-keys", headers=auth_headers)
        assert r.status_code == 200
        d = r.json()
        assert d["public_key"].startswith("pk_test_")
        assert d["secret_key"].startswith("sk_test_")

    def test_personal_blocked(self, session, personal_user):
        r = session.get(f"{API}/api-keys", headers={
            "Authorization": f"Bearer {personal_user['token']}"
        })
        assert r.status_code == 403

    def test_regenerate(self, session, auth_headers):
        old = session.get(f"{API}/api-keys", headers=auth_headers).json()
        r = session.post(f"{API}/api-keys/regenerate", headers=auth_headers)
        assert r.status_code == 200
        assert r.json()["secret_key"] != old["secret_key"]

    def test_set_webhook(self, session, auth_headers):
        r = session.patch(f"{API}/api-keys/webhook", headers=auth_headers, json={
            "webhook_url": "https://example.com/webhook"
        })
        assert r.status_code == 200
        assert r.json()["webhook_url"] == "https://example.com/webhook"


# ---------- Settings ----------
class TestSettings:
    def test_update_profile(self, session, auth_headers):
        r = session.patch(f"{API}/settings/profile", headers=auth_headers, json={
            "full_name": "TEST Updated Name", "language": "en",
        })
        assert r.status_code == 200
        assert r.json()["full_name"] == "TEST Updated Name"
        assert r.json()["language"] == "en"

    def test_change_password_wrong_current(self, session, auth_headers):
        r = session.post(f"{API}/settings/password", headers=auth_headers, json={
            "current_password": "wrong", "new_password": "NewPass456!",
        })
        assert r.status_code == 400

    def test_change_password_ok(self, session, auth_headers, merchant_user):
        r = session.post(f"{API}/settings/password", headers=auth_headers, json={
            "current_password": merchant_user["payload"]["password"],
            "new_password": "NewPass456!",
        })
        assert r.status_code == 200
        # restore
        session.post(f"{API}/settings/password", headers=auth_headers, json={
            "current_password": "NewPass456!",
            "new_password": merchant_user["payload"]["password"],
        })


# ---------- Support ----------
class TestSupport:
    def test_create_and_list_ticket(self, session, auth_headers):
        r = session.post(f"{API}/support/tickets", headers=auth_headers, json={
            "subject": "TEST subject", "message": "hello", "category": "general",
        })
        assert r.status_code == 200
        assert r.json()["subject"] == "TEST subject"
        r2 = session.get(f"{API}/support/tickets", headers=auth_headers)
        assert r2.status_code == 200
        assert len(r2.json()) >= 1
