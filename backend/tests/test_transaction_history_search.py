"""Deterministic tests for user transaction-history visibility and search."""
import asyncio
import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def _value(document, path):
    value = document
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, term) for term in expected):
                return False
            continue
        if key == "$nor":
            if any(_matches(document, term) for term in expected):
                return False
            continue
        actual = _value(document, key)
        if isinstance(expected, dict) and "$regex" in expected:
            flags = re.IGNORECASE if expected.get("$options") == "i" else 0
            if actual is None or not re.search(expected["$regex"], str(actual), flags):
                return False
        elif isinstance(expected, dict) and "$ne" in expected:
            if actual == expected["$ne"]:
                return False
        elif actual != expected:
            return False
    return True


class _Cursor:
    def __init__(self, documents):
        self.documents = list(documents)

    def sort(self, field, direction):
        self.documents.sort(
            key=lambda row: str(_value(row, field) or ""),
            reverse=direction < 0,
        )
        return self

    async def to_list(self, limit):
        return copy.deepcopy(self.documents[:limit])


class _Collection:
    def __init__(self, documents):
        self.documents = copy.deepcopy(documents)

    def find(self, query, projection=None):
        return _Cursor(
            row for row in self.documents if _matches(row, query)
        )

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next(
            (row for row in self.documents if _matches(row, query)), None
        ))


class _Database:
    def __init__(self):
        self.transactions = _Collection([
            {
                "id": "valid-incoming", "user_id": "owner-1",
                "type": "deposit", "direction": "in", "status": "completed",
                "amount": 1000, "currency": "XOF",
                "reference": "BTP-PD-VALID0000000001",
                "created_at": "2026-09-25T12:00:00Z",
                "metadata": {"provider_reference": "provider-admin-ref"},
            },
            {
                "id": "failed-incoming-ledger", "user_id": "owner-1",
                "type": "deposit", "direction": "in", "status": "failed",
                "amount": 1200, "currency": "XOF",
                "reference": "BTP-PD-LEDGER00000001",
                "created_at": "2026-09-25T11:00:00Z",
                "metadata": {
                    "customer_phone": "+22890000001",
                    "customer_email": "payer@example.test",
                    "provider_reference": "provider-ledger-ref",
                },
            },
            {
                "id": "pending-incoming", "user_id": "owner-1",
                "type": "deposit", "direction": "in", "status": "pending",
                "amount": 1300, "currency": "XOF",
                "reference": "BTP-PD-PENDING000001",
                "created_at": "2026-09-25T10:00:00Z", "metadata": {},
            },
            {
                "id": "failed-withdrawal", "user_id": "owner-1",
                "type": "withdrawal", "direction": "out", "status": "failed",
                "amount": 1400, "currency": "XOF",
                "reference": "BTP-WD-FAILED000001",
                "created_at": "2026-09-25T09:00:00Z", "metadata": {},
            },
            {
                "id": "other-user-failure", "user_id": "owner-2",
                "type": "deposit", "direction": "in", "status": "failed",
                "amount": 1500, "currency": "XOF",
                "reference": "BTP-PD-OTHER000000001",
                "created_at": "2026-09-25T08:00:00Z", "metadata": {},
            },
        ])
        self.momo_deposits = _Collection([
            {
                "id": "failed-momo-01234567", "user_id": "owner-1",
                "status": "failed", "amount": 2000,
                "wallet_credit_amount": 2000, "currency": "XOF",
                "provider": "afribapay", "afribapay_transaction_id": "provider-ref-42",
                "phone_number": "+22891112222", "email": "payer@example.test",
                "full_name": "Test Payer", "operator": "moov",
                "operator_name": "Moov Money", "country": "TG",
                "created_at": "2026-09-25T13:00:00Z",
            },
            {
                "id": "other-user-momo-failure", "user_id": "owner-2",
                "status": "failed", "amount": 3000, "currency": "XOF",
                "phone_number": "+22891112222",
                "created_at": "2026-09-25T14:00:00Z",
            },
        ])
        self.users = _Collection([{
            "id": "owner-1", "email": "owner@example.test",
            "phone": "+22890000000",
        }])


def _install_crypto_transactions(monkeypatch):
    database = _Database()
    database.transactions.documents.extend([
        {
            "id": "crypto-deposit-1", "user_id": "owner-1",
            "type": "deposit", "direction": "in", "status": "completed",
            "amount": 12.5, "currency": "USDT",
            "reference": "BTP-CRYPTO-DEP-1",
            "created_at": "2026-09-26T12:00:00Z",
            "metadata": {
                "provider_reference": "easychange-intent-101",
                "izipay_intent_id": "easychange-intent-101",
                "deposit_address": "TDepositCryptoAddress987654321",
                "tx_hash": "0xCryptoDepositHash123",
                "coin": "USDT", "network": "TRC20",
                "customer_email": "crypto-payer@example.test",
            },
        },
        {
            "id": "crypto-withdrawal-1", "user_id": "owner-1",
            "type": "transfer", "direction": "out", "status": "completed",
            "amount": 7.5, "currency": "USDT",
            "reference": "BTP-CRYPTO-WD-1",
            "created_at": "2026-09-26T13:00:00Z",
            "metadata": {
                "transfer_type": "biz_to_crypto",
                "izipay_payout_id": "easychange-payout-202",
                "wallet_address": "0xRecipientCryptoWallet7654321",
                "tx_hash": "0xCryptoWithdrawalHash456",
                "crypto": "USDT", "network": "ERC20",
            },
        },
    ])
    monkeypatch.setattr(server, "db", database)
    return database


def _list(monkeypatch, **params):
    monkeypatch.setattr(server, "db", _Database())
    defaults = {"uid": "owner-1", "type": None, "status": None, "q": None, "limit": 50}
    defaults.update(params)
    return asyncio.run(server.list_transactions(**defaults))


def test_default_history_hides_incoming_deposits_without_completion(monkeypatch):
    rows = _list(monkeypatch)
    ids = {row["id"] for row in rows}
    assert ids == {"valid-incoming", "failed-withdrawal"}


def test_failed_incoming_deposits_are_searchable_by_phone_email_id_and_provider_ref(monkeypatch):
    by_phone = _list(monkeypatch, q="+22891112222")
    by_email = _list(monkeypatch, q="payer@example.test")
    by_id = _list(monkeypatch, q="failed-momo-01234567")
    by_provider_ref = _list(monkeypatch, q="provider-ref-42")
    assert any(row["id"] == "failed-momo-01234567" for row in by_phone)
    assert any(row["id"] == "failed-momo-01234567" for row in by_email)
    assert any(row["id"] == "failed-momo-01234567" for row in by_id)
    assert any(row["id"] == "failed-momo-01234567" for row in by_provider_ref)
    assert all(row["user_id"] == "owner-1" for row in by_phone)


def test_failed_deposit_biztranspay_reference_and_owner_email_search(monkeypatch):
    by_reference = _list(monkeypatch, q="BTP-PD-failed-momo-012345")
    by_owner_email = _list(monkeypatch, q="owner@example.test")
    assert any(row["id"] == "failed-momo-01234567" for row in by_reference)
    assert any(row["id"] == "failed-momo-01234567" for row in by_owner_email)
    assert any(row["id"] == "failed-incoming-ledger" for row in by_owner_email)


def test_admin_history_searches_by_provider_reference(monkeypatch):
    monkeypatch.setattr(server, "db", _Database())
    rows = asyncio.run(server.admin_transactions(
        admin={"id": "admin-1"}, q="provider-admin-ref",
        type=None, status=None, limit=50,
    ))
    assert any(row["id"] == "valid-incoming" for row in rows)


def test_crypto_history_search_matches_easychange_ids_addresses_and_txids(monkeypatch):
    _install_crypto_transactions(monkeypatch)

    def search(query):
        return asyncio.run(server.list_transactions(
            uid="owner-1", type=None, status=None, q=query, limit=50,
        ))

    for query, expected_id in (
        ("easychange-intent-101", "crypto-deposit-1"),
        ("TDepositCryptoAddress987654321", "crypto-deposit-1"),
        ("0xCryptoDepositHash123", "crypto-deposit-1"),
        ("easychange-payout-202", "crypto-withdrawal-1"),
        ("0xRecipientCryptoWallet7654321", "crypto-withdrawal-1"),
    ):
        assert any(row["id"] == expected_id for row in search(query))


def test_admin_crypto_search_matches_provider_id_address_and_customer_email(monkeypatch):
    _install_crypto_transactions(monkeypatch)

    def search(query):
        return asyncio.run(server.admin_transactions(
            admin={"id": "admin-1"}, q=query, type=None, status=None, limit=50,
        ))

    for query, expected_id in (
        ("easychange-intent-101", "crypto-deposit-1"),
        ("TDepositCryptoAddress987654321", "crypto-deposit-1"),
        ("crypto-payer@example.test", "crypto-deposit-1"),
        ("easychange-payout-202", "crypto-withdrawal-1"),
        ("0xRecipientCryptoWallet7654321", "crypto-withdrawal-1"),
    ):
        assert any(row["id"] == expected_id for row in search(query))


def test_searchable_failed_deposit_is_safe_transaction_shaped_row():
    row = server._failed_momo_deposit_history_row({
        "id": "1234567890abcdef-extra", "user_id": "owner-1",
        "status": "failed", "amount": 2500, "currency": "XOF",
        "provider": "afribapay", "afribapay_transaction_id": "external-123",
        "phone_number": "+22890001111", "email": "payer@example.test",
        "full_name": "Test Payer", "created_at": "2026-09-25T12:00:00Z",
        "api_key": "must-not-be-exposed",
    })
    assert row["type"] == "deposit"
    assert row["direction"] == "in"
    assert row["status"] == "failed"
    assert row["reference"] == "BTP-PD-1234567890abcdef"
    assert row["metadata"]["provider_reference"] == "external-123"
    assert row["metadata"]["customer_phone"] == "+22890001111"
    assert "api_key" not in row and "api_key" not in row["metadata"]