"""Iteration 2 targeted tests: Binance removal, toggle persistence, platform toggles."""
import os
import uuid
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "test@biztranspay.com"
ADMIN_PASS = "Password123!"


def _admin_headers():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    assert r.status_code == 200, f"admin login failed: {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}, r.json()["user"]


def test_admin_login_and_role():
    h, u = _admin_headers()
    assert u.get("role") in ("admin", "super_admin"), f"expected admin role, got {u.get('role')}"


# ---------- BUG 1: Binance removal ----------
def test_transfer_binance_rejected_by_pydantic():
    h, _ = _admin_headers()
    r = requests.post(f"{API}/transfers", headers=h, json={
        "transfer_type": "biz_to_binance",
        "recipient": "someone",
        "amount": 100,
        "currency": "USDT",
    })
    # Literal validation → 422 unprocessable entity
    assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text}"


def test_transfer_config_no_binance_section():
    h, _ = _admin_headers()
    r = requests.get(f"{API}/admin/transfer/config", headers=h)
    assert r.status_code == 200, r.text
    cfg = r.json()
    assert "binance" not in cfg, "binance key must be removed from transfer_config"
    # Must still have the three canonical sections
    for k in ("mobile_money", "bank", "crypto"):
        assert k in cfg


def test_transfer_config_user_view_no_binance():
    # Login as a normal user (register fresh)
    suf = uuid.uuid4().hex[:8]
    reg = requests.post(f"{API}/auth/register", json={
        "full_name": "TEST Bugfix User",
        "username": f"tbf{suf}",
        "account_type": "personal",
        "country": "TG",
        "phone": "+22890000099",
        "email": f"tbf_{suf}@biztranspay.com",
        "password": "Password123!",
    })
    assert reg.status_code == 200, reg.text
    tok = reg.json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    r = requests.get(f"{API}/transfer/config", headers=h)
    assert r.status_code == 200
    assert "binance" not in r.json()


# ---------- BUG 2: transfer/config toggle persistence ----------
def test_toggle_crypto_persists():
    h, _ = _admin_headers()
    initial = requests.get(f"{API}/admin/transfer/config", headers=h).json()
    initial_state = initial["crypto"].get("enabled", False)

    # PATCH to flip enabled - send whole crypto section merged
    new_crypto = {**initial["crypto"], "enabled": not initial_state}
    r = requests.patch(f"{API}/admin/transfer/config", headers=h, json={"crypto": new_crypto})
    assert r.status_code == 200, r.text
    assert r.json()["crypto"]["enabled"] == (not initial_state)

    # GET again to verify persistence
    r2 = requests.get(f"{API}/admin/transfer/config", headers=h)
    assert r2.json()["crypto"]["enabled"] == (not initial_state)

    # Restore original state
    restore = {**r2.json()["crypto"], "enabled": initial_state}
    requests.patch(f"{API}/admin/transfer/config", headers=h, json={"crypto": restore})
    final = requests.get(f"{API}/admin/transfer/config", headers=h).json()
    assert final["crypto"]["enabled"] == initial_state


def test_toggle_mobile_money_persists():
    h, _ = _admin_headers()
    initial = requests.get(f"{API}/admin/transfer/config", headers=h).json()
    initial_state = initial["mobile_money"].get("enabled", True)

    new_mm = {**initial["mobile_money"], "enabled": not initial_state}
    r = requests.patch(f"{API}/admin/transfer/config", headers=h, json={"mobile_money": new_mm})
    assert r.status_code == 200
    assert r.json()["mobile_money"]["enabled"] == (not initial_state)

    # Restore
    restore = {**r.json()["mobile_money"], "enabled": initial_state}
    requests.patch(f"{API}/admin/transfer/config", headers=h, json={"mobile_money": restore})
    final = requests.get(f"{API}/admin/transfer/config", headers=h).json()
    assert final["mobile_money"]["enabled"] == initial_state


def test_toggle_bank_persists():
    h, _ = _admin_headers()
    initial = requests.get(f"{API}/admin/transfer/config", headers=h).json()
    initial_state = initial["bank"].get("enabled", False)

    new_bank = {**initial["bank"], "enabled": not initial_state}
    r = requests.patch(f"{API}/admin/transfer/config", headers=h, json={"bank": new_bank})
    assert r.status_code == 200
    assert r.json()["bank"]["enabled"] == (not initial_state)

    restore = {**r.json()["bank"], "enabled": initial_state}
    requests.patch(f"{API}/admin/transfer/config", headers=h, json={"bank": restore})


# ---------- BUG 2b: platform config toggles ----------
def test_platform_fee_enabled_persists():
    h, _ = _admin_headers()
    initial = requests.get(f"{API}/admin/platform/config", headers=h).json()
    fee = initial.get("conversion_fee", {})
    orig_enabled = fee.get("enabled", True)

    new_fee = {**fee, "enabled": not orig_enabled}
    r = requests.patch(f"{API}/admin/platform/config", headers=h, json={"conversion_fee": new_fee})
    assert r.status_code == 200
    assert r.json()["conversion_fee"]["enabled"] == (not orig_enabled)

    # Verify persistence
    r2 = requests.get(f"{API}/admin/platform/config", headers=h)
    assert r2.json()["conversion_fee"]["enabled"] == (not orig_enabled)

    # Restore
    requests.patch(f"{API}/admin/platform/config", headers=h,
                   json={"conversion_fee": {**new_fee, "enabled": orig_enabled}})


def test_platform_auto_withdrawals_toggle_persists_and_impacts_transfer():
    h, _ = _admin_headers()
    # Turn ON auto_withdrawals_disabled
    r = requests.patch(f"{API}/admin/platform/config", headers=h,
                       json={"auto_withdrawals_disabled": True})
    assert r.status_code == 200
    assert r.json()["auto_withdrawals_disabled"] is True

    # Verify persistence
    r2 = requests.get(f"{API}/admin/platform/config", headers=h)
    assert r2.json()["auto_withdrawals_disabled"] is True

    # As a merchant user, attempt a biz_to_mobile transfer → should be pending_manual
    suf = uuid.uuid4().hex[:8]
    reg = requests.post(f"{API}/auth/register", json={
        "full_name": "TEST AW User",
        "username": f"taw{suf}",
        "account_type": "merchant",
        "country": "TG",
        "phone": "+22890000088",
        "email": f"taw_{suf}@biztranspay.com",
        "password": "Password123!",
    })
    assert reg.status_code == 200
    utok = reg.json()["token"]
    uh = {"Authorization": f"Bearer {utok}"}
    tr = requests.post(f"{API}/transfers", headers=uh, json={
        "transfer_type": "biz_to_mobile",
        "recipient": "+22890111111",
        "amount": 500,
        "currency": "XOF",
        "country": "TG",
        "operator": "flooz",
    })
    assert tr.status_code == 200, tr.text
    data = tr.json()
    assert data.get("pending_manual") is True
    assert "retraits automatiques" in data.get("message", "").lower()

    # RESTORE: turn back OFF
    restore = requests.patch(f"{API}/admin/platform/config", headers=h,
                             json={"auto_withdrawals_disabled": False})
    assert restore.json()["auto_withdrawals_disabled"] is False


# ---------- Cleanup: ensure final state matches original ----------
def test_final_state_restore():
    h, _ = _admin_headers()
    cfg = requests.get(f"{API}/admin/transfer/config", headers=h).json()
    # Enforce spec: crypto disabled, no binance
    assert "binance" not in cfg
    if cfg["crypto"].get("enabled"):
        restore = {**cfg["crypto"], "enabled": False}
        requests.patch(f"{API}/admin/transfer/config", headers=h, json={"crypto": restore})
    plat = requests.get(f"{API}/admin/platform/config", headers=h).json()
    assert plat["auto_withdrawals_disabled"] is False
