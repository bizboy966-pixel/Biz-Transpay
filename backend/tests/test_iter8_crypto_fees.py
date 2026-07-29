"""Iteration 8 - New per-coin crypto withdrawal fees.

Covers:
 1. GET /api/admin/crypto/coins (admin-only) returns 22 distinct tickers with fee_pct
 2. PATCH /api/admin/transfer/config with {crypto:{fees:{...}}} deep-merges and preserves cryptos/networks
 3. biz_to_crypto applies fees_map[coin] on withdrawal (100 * 4% USDT; 100 * 3% ETH), refund on gateway failure
"""
import os
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
CREDS = {"email": "test@biztranspay.com", "password": "Password123!"}


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json=CREDS, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module", autouse=True)
def _setup_crypto_config(auth):
    """Enable crypto config + seed known USDT/ETH cryptos so biz_to_crypto validates.
    Runs once for the whole module."""
    # enable crypto
    r = auth.patch(f"{BASE_URL}/api/admin/transfer/config", json={
        "crypto": {
            "enabled": True,
            "cryptos": [
                {"code": "USDT", "name": "Tether", "active": True,
                 "networks": ["TRC20", "BEP20", "ERC20"],
                 "fee_pct": 1.5, "fee_fixed": 0, "min": 1, "max": 100000},
                {"code": "ETH", "name": "Ethereum", "active": True,
                 "networks": ["ERC20"],
                 "fee_pct": 1.5, "fee_fixed": 0, "min": 0.001, "max": 50},
                {"code": "BTC", "name": "Bitcoin", "active": True,
                 "networks": ["BTC"], "fee_pct": 1.5, "fee_fixed": 0, "min": 0.0001, "max": 5},
                {"code": "LTC", "name": "Litecoin", "active": True,
                 "networks": ["LTC"], "fee_pct": 1.5, "fee_fixed": 0, "min": 0.01, "max": 1000},
            ],
            "networks": [
                {"code": "TRC20", "name": "Tron (TRC20)", "active": True,
                 "address_regex": "^T[A-Za-z1-9]{33}$"},
                {"code": "ERC20", "name": "Ethereum (ERC20)", "active": True,
                 "address_regex": "^0x[a-fA-F0-9]{40}$"},
                {"code": "BEP20", "name": "BNB Smart Chain (BEP20)", "active": True,
                 "address_regex": "^0x[a-fA-F0-9]{40}$"},
                {"code": "BTC", "name": "Bitcoin", "active": True,
                 "address_regex": "^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$"},
                {"code": "LTC", "name": "Litecoin", "active": True,
                 "address_regex": "^(ltc1|[LM3])[a-zA-HJ-NP-Z0-9]{25,62}$"},
            ],
        }
    }, timeout=15)
    assert r.status_code == 200, r.text
    yield
    # teardown: disable crypto
    auth.patch(f"{BASE_URL}/api/admin/transfer/config", json={"crypto": {"enabled": False}}, timeout=15)


# ---------- 1) coins endpoint ----------
class TestCryptoCoinsEndpoint:
    def test_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/crypto/coins", timeout=15)
        # No token → 401 (auth layer); with bogus admin (non-admin user) → 403.
        assert r.status_code in (401, 403), r.text

    def test_bogus_token_returns_401(self):
        r = requests.get(
            f"{BASE_URL}/api/admin/crypto/coins",
            headers={"Authorization": "Bearer notavalidtoken"}, timeout=15)
        assert r.status_code == 401

    def test_returns_at_least_20_distinct_coins(self, auth):
        r = auth.get(f"{BASE_URL}/api/admin/crypto/coins", timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 20, f"only {len(data)} coins"
        coins = [c["coin"] for c in data]
        # Must contain the main tickers
        for expected in ("USDT", "BTC", "ETH", "LTC", "TRX", "BNB", "SOL", "XRP", "DOGE"):
            assert expected in coins, f"missing {expected} in {coins}"
        # tickers must be prefix of assetCode (no "Bitcoin" etc.)
        assert all(c["coin"].isupper() and c["coin"].isalnum() for c in data)
        # each entry has coin/name/fee_pct floats
        for c in data:
            assert isinstance(c["coin"], str)
            assert isinstance(c["name"], str)
            assert isinstance(c["fee_pct"], (int, float))


# ---------- 2) fee patch ----------
class TestPatchCryptoFees:
    def test_patch_fees_reflected_and_preserves_structures(self, auth):
        # First read to snapshot cryptos/networks
        cur = auth.get(f"{BASE_URL}/api/admin/transfer/config").json()
        cryptos_before = cur.get("crypto", {}).get("cryptos", [])
        networks_before = cur.get("crypto", {}).get("networks", [])
        assert len(cryptos_before) > 0
        assert len(networks_before) > 0

        r = auth.patch(f"{BASE_URL}/api/admin/transfer/config", json={
            "crypto": {"fees": {"USDT": 4.0, "ETH": 3.0, "LTC": 2.0, "BTC": 5.5}}
        }, timeout=15)
        assert r.status_code == 200, r.text

        coins = {c["coin"]: c["fee_pct"] for c in auth.get(f"{BASE_URL}/api/admin/crypto/coins").json()}
        assert coins["USDT"] == 4.0
        assert coins["ETH"] == 3.0
        assert coins["LTC"] == 2.0
        assert coins["BTC"] == 5.5
        # Default 4.0 for any other coin
        for other in ("TRX", "SOL", "XRP", "DOGE"):
            if other in coins:
                assert coins[other] == 4.0, f"{other} should default 4.0 (got {coins[other]})"

        # Deep-merge preserved cryptos/networks
        cfg2 = auth.get(f"{BASE_URL}/api/admin/transfer/config").json()
        assert cfg2["crypto"]["enabled"] is True
        assert len(cfg2["crypto"].get("cryptos", [])) == len(cryptos_before)
        assert len(cfg2["crypto"].get("networks", [])) == len(networks_before)


# ---------- 3) fee applied on withdrawal ----------
class TestFeeApplication:
    def _get_balance(self, auth):
        return auth.get(f"{BASE_URL}/api/auth/me").json().get("balance_usdt", 0)

    def _list_last_tx(self, auth):
        r = auth.get(f"{BASE_URL}/api/transactions?limit=5", timeout=15)
        assert r.status_code == 200
        return r.json()

    def _find_tx_by_amount(self, auth, coin, amount):
        r = auth.get(f"{BASE_URL}/api/transactions?limit=20", timeout=15)
        assert r.status_code == 200
        for t in r.json():
            m = t.get("metadata") or {}
            if (m.get("transfer_type") == "biz_to_crypto"
                    and m.get("crypto") == coin
                    and abs(t.get("amount", 0) - amount) < 0.001):
                return t
        return None

    def test_usdt_withdraw_applies_4pct(self, auth):
        # Ensure fees {USDT:4, ETH:3}
        auth.patch(f"{BASE_URL}/api/admin/transfer/config",
                   json={"crypto": {"fees": {"USDT": 4.0, "ETH": 3.0}}})

        bal_before = self._get_balance(auth)
        # regex-valid TRC20 address but almost certainly rejected by vendor
        addr = "T" + "1" * 33
        r = auth.post(f"{BASE_URL}/api/transfers", json={
            "transfer_type": "biz_to_crypto",
            "crypto": "USDT", "network": "TRC20",
            "wallet_address": addr,
            "recipient": "x", "amount": 100,
            "currency": "USDT", "fee_bearer": "sender",
        }, timeout=30)
        assert r.status_code in (400, 502), r.text

        bal_after = self._get_balance(auth)
        assert abs(bal_after - bal_before) < 0.01, f"refund broken: before={bal_before} after={bal_after}"

        tx = self._find_tx_by_amount(auth, "USDT", 100)
        assert tx, "no USDT biz_to_crypto tx amount=100 recorded"
        m = tx["metadata"]
        assert abs(m.get("fee", 0) - 4.0) < 0.01, f"expected fee=4.0, got {m}"
        assert abs(m.get("total_debit", 0) - 104.0) < 0.01, f"expected total_debit=104.0, got {m}"
        assert tx["status"] == "failed"

    def test_eth_withdraw_applies_3pct(self, auth):
        # Amount must fit ETH limits (min=0.001,max=50). Use 10.
        auth.patch(f"{BASE_URL}/api/admin/transfer/config",
                   json={"crypto": {"fees": {"USDT": 4.0, "ETH": 3.0}}})
        bal_before = self._get_balance(auth)
        r = auth.post(f"{BASE_URL}/api/transfers", json={
            "transfer_type": "biz_to_crypto",
            "crypto": "ETH", "network": "ERC20",
            "wallet_address": "0x0000000000000000000000000000000000000000",
            "recipient": "x", "amount": 10,
            "currency": "USDT", "fee_bearer": "sender",
        }, timeout=30)
        assert r.status_code in (400, 502), r.text

        bal_after = self._get_balance(auth)
        assert abs(bal_after - bal_before) < 0.01, f"refund broken: before={bal_before} after={bal_after}"

        tx = self._find_tx_by_amount(auth, "ETH", 10)
        assert tx, "no ETH biz_to_crypto tx amount=10 recorded"
        m = tx["metadata"]
        # 10 * 3% = 0.3 → verifying config-based fee (NOT old hardcoded 1.5%)
        assert abs(m.get("fee", 0) - 0.3) < 0.01, f"expected fee=0.3 (3% of 10), got {m}"
        assert abs(m.get("total_debit", 0) - 10.3) < 0.01, f"expected total_debit=10.3, got {m}"
        assert tx["status"] == "failed"


# ---------- 4) Regression: toggles still auto-save ----------
class TestRegressionToggles:
    def test_toggle_crypto_partial_patch(self, auth):
        r = auth.patch(f"{BASE_URL}/api/admin/transfer/config", json={"crypto": {"enabled": True}})
        assert r.status_code == 200
        cfg = auth.get(f"{BASE_URL}/api/admin/transfer/config").json()
        assert cfg["crypto"]["enabled"] is True
        # cryptos/networks preserved
        assert len(cfg["crypto"].get("cryptos", [])) > 0
        assert len(cfg["crypto"].get("networks", [])) > 0

    def test_toggle_mobile_money(self, auth):
        r = auth.patch(f"{BASE_URL}/api/admin/transfer/config", json={"mobile_money": {"enabled": True}})
        assert r.status_code == 200
        cfg = auth.get(f"{BASE_URL}/api/admin/transfer/config").json()
        assert cfg["mobile_money"]["enabled"] is True
        assert len(cfg["mobile_money"].get("operators", [])) > 0
