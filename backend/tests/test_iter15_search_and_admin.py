"""Iter15 — Backend tests for:
  * BUG: transactions search across many fields (user + admin)
  * FEATURE 1: biz_to_bank permanently removed
  * FEATURE 2: admin PATCH account_type + auto-provision API keys
  * FEATURE 3: admin /admin/links + /admin/api-keys (list, suspend/reactivate/regen/delete)
"""
import os
import secrets as _sec
import uuid
import pytest
import requests

def _read_frontend_env():
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


BASE = (os.environ.get("REACT_APP_BACKEND_URL") or _read_frontend_env() or "").rstrip("/")
assert BASE, "REACT_APP_BACKEND_URL not configured"
API = f"{BASE}/api"
ADMIN_EMAIL = "bizboy966@gmail.com"
ADMIN_PWD = "Password123!"

TEST_TAG = f"iter15_{_sec.token_hex(3)}"


def _rand_email(prefix="m"):
    return f"{TEST_TAG}_{prefix}_{_sec.token_hex(3)}@example.com"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _register(account_type="merchant"):
    email = _rand_email("u")
    uname = f"{TEST_TAG}u{_sec.token_hex(3)}"
    r = requests.post(f"{API}/auth/register", json={
        "full_name": f"Test {TEST_TAG}", "username": uname,
        "email": email, "password": "Password123!", "phone": f"+228{_sec.randbelow(89999999)+10000000}",
        "country": "TG", "account_type": account_type,
    }, timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    return d["user"], d["token"]


@pytest.fixture(scope="module")
def merchant():
    """Fresh merchant persisted for the whole module."""
    u, tok = _register("merchant")
    yield {"user": u, "token": tok, "hdr": {"Authorization": f"Bearer {tok}"}}


# ---------------- BUG: transactions search ----------------
class TestTransactionSearchBug:
    """Create a transaction with several identifiable fields, then search each of them."""

    @pytest.fixture(scope="class")
    def seeded(self, merchant, admin_hdr):
        """Insert one transaction directly via a Biz-to-Biz transfer so we get real IDs.
        Also do an admin-credit + record a synthetic tx with rich metadata."""
        uid = merchant["user"]["id"]
        # Credit user first so they have balance
        r = requests.post(f"{API}/admin/users/{uid}/credit",
                          headers=admin_hdr,
                          json={"currency": "XOF", "amount": 5000, "note": "iter15 seed"},
                          timeout=15)
        assert r.status_code == 200, r.text
        # Now insert a synthetic transaction via direct DB manipulation isn't possible from client.
        # Instead exercise real search across the "deposit" credit tx we just created.
        return {"uid": uid}

    def _search(self, hdr, q):
        r = requests.get(f"{API}/transactions", headers=hdr, params={"q": q}, timeout=15)
        assert r.status_code == 200, r.text
        return r.json()

    def _admin_search(self, hdr, q):
        r = requests.get(f"{API}/admin/transactions", headers=hdr, params={"q": q}, timeout=15)
        assert r.status_code == 200, r.text
        return r.json()

    def test_search_returns_all_when_empty(self, merchant, seeded):
        txs = self._search(merchant["hdr"], "")
        assert isinstance(txs, list) and len(txs) >= 1

    def test_search_by_reference_case_insensitive(self, merchant, seeded):
        all_txs = self._search(merchant["hdr"], "")
        ref = all_txs[0]["reference"]
        # exact
        got = self._search(merchant["hdr"], ref)
        assert any(t["reference"] == ref for t in got), f"exact ref {ref} not found"
        # lowercase (reference is upper)
        got_low = self._search(merchant["hdr"], ref.lower())
        assert any(t["reference"] == ref for t in got_low), "case-insensitive search failed"
        # partial substring
        got_part = self._search(merchant["hdr"], ref[4:9])
        assert any(t["reference"] == ref for t in got_part), "substring search failed"

    def test_search_by_id(self, merchant, seeded):
        all_txs = self._search(merchant["hdr"], "")
        tid = all_txs[0]["id"]
        got = self._search(merchant["hdr"], tid[:8])
        assert any(t["id"] == tid for t in got)

    def test_search_by_currency(self, merchant, seeded):
        got = self._search(merchant["hdr"], "xof")
        assert any(t["currency"] == "XOF" for t in got)

    def test_search_no_results(self, merchant, seeded):
        got = self._search(merchant["hdr"], f"NOMATCH{uuid.uuid4().hex}")
        assert got == []

    def test_admin_search_by_user_email(self, admin_hdr, merchant, seeded):
        email = merchant["user"]["email"]
        # take a substring so we're not testing exact email
        needle = email.split("@")[0]
        got = self._admin_search(admin_hdr, needle)
        # Must include at least our merchant's tx
        assert any(t.get("user_id") == merchant["user"]["id"] for t in got), \
            f"admin search by email substring '{needle}' did not surface our merchant's tx"

    def test_admin_search_by_username(self, admin_hdr, merchant, seeded):
        uname = merchant["user"]["username"]
        got = self._admin_search(admin_hdr, uname)
        assert any(t.get("user_id") == merchant["user"]["id"] for t in got)

    def test_admin_search_case_insensitive_email(self, admin_hdr, merchant, seeded):
        email_up = merchant["user"]["email"].upper()
        got = self._admin_search(admin_hdr, email_up)
        assert any(t.get("user_id") == merchant["user"]["id"] for t in got)


# ---------------- FEATURE 1: biz_to_bank removed ----------------
class TestBizToBankRemoved:
    def test_biz_to_bank_returns_410(self, merchant):
        r = requests.post(f"{API}/transfers", headers=merchant["hdr"], json={
            "transfer_type": "biz_to_bank",
            "amount": 1000, "currency": "XOF",
            "recipient": "acct", "bank": "SGBS",
        }, timeout=15)
        assert r.status_code == 410, r.text
        assert "bancaire" in (r.json().get("detail") or "").lower()


# ---------------- FEATURE 2: account_type switch + auto keys ----------------
class TestAccountTypeSwitch:
    def test_personal_to_merchant_provisions_keys(self, admin_hdr):
        u, tok = _register("personal")
        hdr = {"Authorization": f"Bearer {tok}"}
        # Before: personal → GET /api-keys returns 403
        r = requests.get(f"{API}/api-keys", headers=hdr, timeout=15)
        assert r.status_code == 403
        # Promote via admin PATCH
        r = requests.patch(f"{API}/admin/users/{u['id']}", headers=admin_hdr,
                           json={"account_type": "merchant"}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["account_type"] == "merchant"
        # After: keys must exist immediately
        r = requests.get(f"{API}/api-keys", headers=hdr, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["keys"]["test"]["public_key"].startswith("pk_test_")

    def test_merchant_to_personal(self, admin_hdr):
        u, _tok = _register("merchant")
        r = requests.patch(f"{API}/admin/users/{u['id']}", headers=admin_hdr,
                           json={"account_type": "personal"}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["account_type"] == "personal"


# ---------------- FEATURE 3: admin /admin/links ----------------
class TestAdminLinks:
    @pytest.fixture(scope="class")
    def link(self, merchant):
        slug = f"iter15{_sec.token_hex(4)}"
        r = requests.post(f"{API}/links", headers=merchant["hdr"], json={
            "title": f"iter15 link {TEST_TAG}", "slug": slug,
            "amount_type": "fixed", "amount": 5.0, "currency": "USDT",
            "description": "iter15 test",
        }, timeout=15)
        assert r.status_code == 200, r.text
        return r.json()

    def test_admin_lists_link_with_owner(self, admin_hdr, link, merchant):
        r = requests.get(f"{API}/admin/links", headers=admin_hdr,
                        params={"q": link["slug"]}, timeout=15)
        assert r.status_code == 200, r.text
        rows = r.json()
        match = [row for row in rows if row["id"] == link["id"]]
        assert match, f"link {link['id']} not returned by admin listing"
        owner = match[0].get("owner") or {}
        assert owner.get("username") == merchant["user"]["username"]
        assert owner.get("email") == merchant["user"]["email"]
        assert owner.get("account_type") in ("merchant", "personal")

    def test_admin_search_by_owner_email(self, admin_hdr, link, merchant):
        needle = merchant["user"]["email"].split("@")[0]
        r = requests.get(f"{API}/admin/links", headers=admin_hdr,
                        params={"q": needle}, timeout=15)
        assert r.status_code == 200
        assert any(row["id"] == link["id"] for row in r.json())

    def test_suspend_then_link_pay_returns_404(self, admin_hdr, link):
        r = requests.post(f"{API}/admin/links/{link['id']}/action/suspend",
                         headers=admin_hdr, timeout=15)
        assert r.status_code == 200
        # /links/pay filters by active=True → suspended slug should be 404
        r = requests.post(f"{API}/links/pay", json={
            "slug": link["slug"], "asset_code": "USDT.TRC20",
            "full_name": "Test User", "email": "buyer@example.com",
            "refund_address": "TQmSxYQpwYcXbo3jaBEbi8jHUKq5Xd8Y6M",
            "origin_url": "https://example.com",
        }, timeout=15)
        assert r.status_code == 404, f"suspended link should be 404, got {r.status_code}: {r.text}"

    def test_reactivate_link(self, admin_hdr, link):
        r = requests.post(f"{API}/admin/links/{link['id']}/action/reactivate",
                         headers=admin_hdr, timeout=15)
        assert r.status_code == 200
        # verify active=true
        rows = requests.get(f"{API}/admin/links", headers=admin_hdr,
                           params={"q": link["slug"]}, timeout=15).json()
        assert rows[0]["active"] is True

    def test_delete_link_cascades(self, admin_hdr, link):
        r = requests.post(f"{API}/admin/links/{link['id']}/action/delete",
                         headers=admin_hdr, timeout=15)
        assert r.status_code == 200
        rows = requests.get(f"{API}/admin/links", headers=admin_hdr,
                           params={"q": link["slug"]}, timeout=15).json()
        assert not any(row["id"] == link["id"] for row in rows), "link was not deleted"


# ---------------- FEATURE 3: admin /admin/api-keys ----------------
class TestAdminApiKeys:
    @pytest.fixture(scope="class")
    def merchant_with_key(self, admin_hdr):
        """Fresh merchant + fetched keys + one regeneration to get plaintext sk_test_."""
        u, tok = _register("merchant")
        hdr = {"Authorization": f"Bearer {tok}"}
        # Force _ensure_api_keys + regenerate → we get plaintext sk_test_
        r = requests.post(f"{API}/api-keys/regenerate", headers=hdr,
                         json={"env": "test"}, timeout=15)
        assert r.status_code == 200, r.text
        sk = r.json()["secret_key"]
        return {"user": u, "hdr": hdr, "sk_test": sk}

    def test_admin_list_never_leaks_secrets(self, admin_hdr, merchant_with_key):
        r = requests.get(f"{API}/admin/api-keys", headers=admin_hdr,
                        params={"q": merchant_with_key["user"]["email"].split("@")[0]},
                        timeout=15)
        assert r.status_code == 200, r.text
        rows = r.json()
        match = [row for row in rows if row["user_id"] == merchant_with_key["user"]["id"]]
        assert match, "merchant not in admin api-keys listing"
        row = match[0]
        assert row["test_public_key"].startswith("pk_test_")
        assert row.get("suspended") is False
        for k in row.keys():
            assert "secret_hash" not in k
            assert "secret_encrypted" not in k
            assert "secret_key" not in k
        assert (row.get("owner") or {}).get("email") == merchant_with_key["user"]["email"]

    def test_v1_payments_works_before_suspend(self, merchant_with_key):
        """POST /v1/payments should not return 401/403 with a valid key.
        (May return 400/502 from IziPay — that's still fine, we only check the auth branch.)"""
        r = requests.post(f"{API}/v1/payments",
                         headers={"Authorization": f"Bearer {merchant_with_key['sk_test']}"},
                         json={"amount": 5, "coin": "USDT"}, timeout=25)
        assert r.status_code not in (401, 403), f"unexpected auth failure: {r.status_code} {r.text}"

    def test_suspend_blocks_v1_payments(self, admin_hdr, merchant_with_key):
        uid = merchant_with_key["user"]["id"]
        r = requests.post(f"{API}/admin/api-keys/{uid}/action/suspend", headers=admin_hdr, timeout=15)
        assert r.status_code == 200, r.text
        r = requests.post(f"{API}/v1/payments",
                         headers={"Authorization": f"Bearer {merchant_with_key['sk_test']}"},
                         json={"amount": 5, "coin": "USDT"}, timeout=15)
        assert r.status_code == 403, f"suspended keys should return 403, got {r.status_code}"
        assert "suspend" in (r.json().get("detail") or "").lower()

    def test_reactivate_restores_auth(self, admin_hdr, merchant_with_key):
        uid = merchant_with_key["user"]["id"]
        r = requests.post(f"{API}/admin/api-keys/{uid}/action/reactivate", headers=admin_hdr, timeout=15)
        assert r.status_code == 200
        r = requests.post(f"{API}/v1/payments",
                         headers={"Authorization": f"Bearer {merchant_with_key['sk_test']}"},
                         json={"amount": 5, "coin": "USDT"}, timeout=25)
        assert r.status_code != 403, "reactivate did not lift 403"

    def test_regenerate_rotates_and_invalidates_old_secret(self, admin_hdr, merchant_with_key):
        uid = merchant_with_key["user"]["id"]
        # capture current public key
        rows = requests.get(f"{API}/admin/api-keys", headers=admin_hdr,
                           params={"q": merchant_with_key["user"]["email"].split("@")[0]},
                           timeout=15).json()
        old_pub = [r for r in rows if r["user_id"] == uid][0]["test_public_key"]
        # rotate
        r = requests.post(f"{API}/admin/api-keys/{uid}/action/regenerate", headers=admin_hdr, timeout=15)
        assert r.status_code == 200
        rows2 = requests.get(f"{API}/admin/api-keys", headers=admin_hdr,
                            params={"q": merchant_with_key["user"]["email"].split("@")[0]},
                            timeout=15).json()
        new_pub = [r for r in rows2 if r["user_id"] == uid][0]["test_public_key"]
        assert new_pub != old_pub, "regenerate did not rotate test public key"
        # Old sk should now be invalid
        r = requests.post(f"{API}/v1/payments",
                         headers={"Authorization": f"Bearer {merchant_with_key['sk_test']}"},
                         json={"amount": 5, "coin": "USDT"}, timeout=15)
        assert r.status_code == 401, f"old secret should be invalidated, got {r.status_code}"

    def test_delete_apikeys(self, admin_hdr, merchant_with_key):
        uid = merchant_with_key["user"]["id"]
        r = requests.post(f"{API}/admin/api-keys/{uid}/action/delete", headers=admin_hdr, timeout=15)
        assert r.status_code == 200
        rows = requests.get(f"{API}/admin/api-keys", headers=admin_hdr,
                           params={"q": merchant_with_key["user"]["email"].split("@")[0]},
                           timeout=15).json()
        assert not any(r["user_id"] == uid for r in rows), "api_keys doc was not deleted"


# ---------------- Cleanup ----------------
def test_zzz_cleanup(admin_hdr):
    """Delete all TEST_TAG-prefixed users we created during this run."""
    r = requests.get(f"{API}/admin/users", headers=admin_hdr,
                    params={"q": TEST_TAG, "limit": 200}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"cannot list users to cleanup: {r.status_code}")
    for u in r.json():
        if TEST_TAG in (u.get("email") or "") or TEST_TAG in (u.get("username") or ""):
            requests.delete(f"{API}/admin/users/{u['id']}", headers=admin_hdr, timeout=15)
