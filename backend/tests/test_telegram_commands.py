"""Focused, offline tests for Telegram transaction lookup and live totals."""
import asyncio
import copy
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paydunya
import server


def _field(document, name):
    value = document
    for part in name.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, clause) for clause in expected):
                return False
            continue
        actual = _field(document, key)
        if isinstance(expected, dict) and "$regex" in expected:
            flags = re.IGNORECASE if expected.get("$options") == "i" else 0
            if actual is None or not re.search(expected["$regex"], str(actual), flags):
                return False
        elif isinstance(expected, dict) and "$in" in expected:
            if actual not in expected["$in"]:
                return False
        elif actual != expected:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self._limit = None

    def sort(self, field, direction):
        self.rows.sort(
            key=lambda row: str(_field(row, field) or ""),
            reverse=direction < 0,
        )
        return self

    def limit(self, count):
        self._limit = count
        return self

    async def to_list(self, length):
        count = self._limit if self._limit is not None else length
        return copy.deepcopy(self.rows[:count])


class _Collection:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)

    def find(self, query, projection=None):
        return _Cursor(row for row in self.rows if _matches(row, query))

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next(
            (row for row in self.rows if _matches(row, query)), None
        ))


class _Database:
    def __init__(self):
        self.users = _Collection([
            {
                "id": "user-1", "full_name": "Client Test",
                "username": "client-test", "email": "payer@example.test",
                "phone": "+22890001111", "country": "TG",
            },
            {
                "id": "user-2", "full_name": "Another Client",
                "email": "other@example.test", "phone": "+22890002222",
            },
        ])
        self.transactions = _Collection([
            {
                "id": "deposit-ledger-1", "user_id": "user-1",
                "type": "deposit", "direction": "in", "status": "completed",
                "amount": 5000, "currency": "XOF",
                "reference": "BTP-PD-0123456789abcdef",
                "provider": "paydunya",
                "created_at": "2026-09-25T12:00:00Z",
                "metadata": {
                    "provider_reference": "PD-INV-77",
                    "customer_email": "payer@example.test",
                    "customer_phone": "+22890001111",
                },
            },
            {
                "id": "withdrawal-2", "user_id": "user-1",
                "type": "withdrawal", "direction": "out", "status": "failed",
                "amount": 2100, "currency": "XOF",
                "reference": "BTP-WD-00002", "provider": "afribapay",
                "created_at": "2026-09-25T11:00:00Z",
                "metadata": {
                    "afribapay_transaction_id": "AF-PAYOUT-22",
                    "phone_number": "+22890002222",
                    "customer_email": "payer@example.test",
                },
            },
            {
                "id": "exchange-3", "user_id": "user-1",
                "type": "exchange", "status": "completed",
                "amount": 15, "currency": "USDT",
                "reference": "BTP-EX-00003", "provider": "izipay",
                "created_at": "2026-09-25T10:00:00Z",
                "metadata": {
                    "izipay_intent_id": "IZI-INTENT-33",
                    "from_currency": "USDT", "to_currency": "XOF",
                    "received": 9000,
                },
            },
        ])
        self.momo_deposits = _Collection([
            {
                "id": "failed-momo-01234567", "user_id": "user-1",
                "status": "failed", "amount": 3000, "currency": "XOF",
                "provider": "afribapay",
                "afribapay_transaction_id": "AF-PAYIN-99",
                "phone_number": "+22891112222",
                "email": "payer@example.test",
                "full_name": "Payer Test",
                "operator": "moov", "created_at": "2026-09-25T13:00:00Z",
                "private_provider_payload": {"api_key": "must-not-be-returned"},
            },
        ])
        self.payment_transactions = _Collection([
            {
                "id": "public-payment-4", "session_id": "SESSION-4",
                "user_id": "user-1", "status": "paid", "amount": 8000,
                "currency": "XOF", "reference": "BTP-PAY-00004",
                "created_at": "2026-09-25T09:00:00Z",
                "provider_reference": "CHECKOUT-44",
                "phone_number": "+22895556666",
                "email": "payer@example.test",
            },
        ])
        self.crypto_deposits = _Collection([])
        self.link_payments = _Collection([])
        self.merchant_payments = _Collection([])


def _install_db(monkeypatch):
    database = _Database()
    monkeypatch.setattr(server, "db", database)
    return database


def test_search_matches_email_phone_provider_reference_and_internal_id(monkeypatch):
    _install_db(monkeypatch)
    by_phone = asyncio.run(server._telegram_search_records("retrait", "+22890002222"))
    by_email = asyncio.run(server._telegram_search_records("depot", "payer@example.test"))
    by_provider = asyncio.run(server._telegram_search_records("depot", "AF-PAYIN-99"))
    by_transaction_id = asyncio.run(
        server._telegram_search_records("retrait", "withdrawal-2")
    )
    assert any(row["record"]["id"] == "withdrawal-2" for row in by_phone)
    assert any(row["record"]["id"] == "deposit-ledger-1" for row in by_email)
    assert any(row["record"]["id"] == "failed-momo-01234567" for row in by_provider)
    assert any(row["record"]["id"] == "withdrawal-2" for row in by_transaction_id)


@pytest.mark.parametrize("kind,expected_id,reference,provider_id,phone", [
    ("depot", "deposit-ledger-1", "BTP-PD-0123456789abcdef",
     "PD-INV-77", "+228 90-00 11 11"),
    ("retrait", "withdrawal-2", "BTP-WD-00002",
     "AF-PAYOUT-22", "+228 90-00 22 22"),
    ("echange", "exchange-3", "BTP-EX-00003",
     "IZI-INTENT-33", "+228 90-00 11 11"),
    ("total", "deposit-ledger-1", "BTP-PD-0123456789abcdef",
     "PD-INV-77", "+228 90-00 11 11"),
])
@pytest.mark.parametrize("lookup", [
    "internal_id", "reference", "provider_id", "phone",
    "email", "username", "handle", "full_name",
])
def test_all_commands_accept_references_and_user_identity(
        monkeypatch, kind, expected_id, reference, provider_id, phone, lookup):
    _install_db(monkeypatch)
    values = {
        "internal_id": expected_id, "reference": reference,
        "provider_id": provider_id, "phone": phone,
        "email": "PAYER@EXAMPLE.TEST", "username": "client-test",
        "handle": "@CLIENT-TEST", "full_name": "Client Test",
    }
    results = asyncio.run(server._telegram_search_records(kind, values[lookup]))
    assert expected_id in {row["record"]["id"] for row in results}


def test_total_identity_search_includes_all_types_and_raw_payment_sources(monkeypatch):
    database = _install_db(monkeypatch)
    database.merchant_payments.rows.append({
        "id": "api-payment-1", "merchant_id": "user-1",
        "status": "pending", "created_at": "2026-09-26T10:00:00Z",
    })
    results = asyncio.run(server._telegram_search_records("total", "Client Test"))
    assert {row["record"]["id"] for row in results} >= {
        "deposit-ledger-1", "withdrawal-2", "exchange-3",
        "failed-momo-01234567", "public-payment-4", "api-payment-1",
    }
    deposit = next(row for row in results if row["record"]["id"] == "deposit-ledger-1")
    rendered = asyncio.run(server._telegram_record_text("total", deposit))
    assert "<b>Dépôt —" in rendered


def test_search_matches_external_payer_name_and_username_without_user_account(monkeypatch):
    database = _install_db(monkeypatch)
    database.link_payments.rows.append({
        "id": "external-payer-1", "user_id": "user-2", "status": "paid",
        "metadata": {"payer_name": "External Payer", "payer_username": "external-handle"},
        "created_at": "2026-09-26T10:00:00Z",
    })
    for query in ("External Payer", "@external-handle"):
        for kind in ("depot", "total"):
            results = asyncio.run(server._telegram_search_records(kind, query))
            assert "external-payer-1" in {row["record"]["id"] for row in results}
    assert asyncio.run(server._telegram_search_records("total", ".*")) == []
    assert asyncio.run(server._telegram_search_records("total", "not-a-real-reference")) == []


def test_search_matches_biztranspay_reference_for_ledger_and_raw_deposit(monkeypatch):
    _install_db(monkeypatch)
    ledger = asyncio.run(server._telegram_search_records(
        "depot", "BTP-PD-0123456789abcdef",
    ))
    raw = asyncio.run(server._telegram_search_records(
        "depot", "BTP-PD-failed-momo-012345",
    ))
    assert any(row["record"]["id"] == "deposit-ledger-1" for row in ledger)
    assert any(row["record"]["id"] == "failed-momo-01234567" for row in raw)


def test_search_routes_exchange_and_checkout_transactions(monkeypatch):
    _install_db(monkeypatch)
    exchange = asyncio.run(server._telegram_search_records(
        "echange", "IZI-INTENT-33",
    ))
    checkout = asyncio.run(server._telegram_search_records(
        "depot", "CHECKOUT-44",
    ))
    assert any(row["record"]["id"] == "exchange-3" for row in exchange)
    assert any(row["record"]["id"] == "public-payment-4" for row in checkout)
    assert asyncio.run(server._telegram_search_records("depot", "x" * 101)) == []


def test_search_crypto_address_and_keeps_multiple_same_phone_matches(monkeypatch):
    database = _install_db(monkeypatch)
    database.crypto_deposits.rows.append({
        "id": "crypto-deposit-1", "user_id": "user-1",
        "status": "completed", "amount": 12, "currency": "USDT",
        "deposit_address": "0x1234567890abcdef1234567890abcdef12345678",
        "created_at": "2026-09-25T15:00:00Z",
    })
    database.transactions.rows.extend([
        {
            "id": "phone-deposit-1", "user_id": "user-2",
            "type": "deposit", "direction": "in", "status": "completed",
            "amount": 500, "currency": "XOF", "provider_reference": "SAME-REF",
            "created_at": "2026-09-25T16:00:00Z",
            "metadata": {"customer_phone": "+22890002222"},
        },
        {
            "id": "phone-deposit-2", "user_id": "user-2",
            "type": "deposit", "direction": "in", "status": "pending",
            "amount": 800, "currency": "XOF", "provider_reference": "SAME-REF",
            "created_at": "2026-09-25T17:00:00Z",
            "metadata": {"customer_phone": "+22890002222"},
        },
    ])

    address_results = asyncio.run(server._telegram_search_records(
        "depot", "0x1234567890abcdef1234567890abcdef12345678"))
    phone_results = asyncio.run(server._telegram_search_records(
        "depot", "+22890002222"))

    assert any(row["record"]["id"] == "crypto-deposit-1" for row in address_results)
    assert {row["record"]["id"] for row in phone_results
            if row["source"] == "transaction"} >= {
                "phone-deposit-1", "phone-deposit-2",
            }
    crypto_result = next(
        row for row in address_results
        if row["record"]["id"] == "crypto-deposit-1")
    rendered = asyncio.run(server._telegram_record_text("depot", crypto_result))
    assert "Dépôt crypto" in rendered
    assert "Adresse crypto" in rendered
    assert "0x1234567890abcdef1234567890abcdef12345678" not in rendered


def test_result_format_masks_contacts_and_omits_raw_provider_payload(monkeypatch):
    _install_db(monkeypatch)
    matches = asyncio.run(server._telegram_search_records("depot", "AF-PAYIN-99"))
    rendered = asyncio.run(server._telegram_record_text("depot", matches[0]))
    assert "Africa Pay (AfribaPAY)" in rendered
    assert "AF-PAYIN-99" in rendered
    assert "+22891112222" not in rendered
    assert "payer@example.test" not in rendered
    assert "must-not-be-returned" not in rendered
    assert "failed-momo-01234567" in rendered


def test_exchange_result_escapes_untrusted_status_and_currency_labels(monkeypatch):
    database = _install_db(monkeypatch)
    record = database.transactions.rows[2]
    record["status"] = "<script>bad</script>"
    record["metadata"]["from_currency"] = "<b>bad</b>"
    rendered = asyncio.run(server._telegram_record_text(
        "echange", {"source": "transaction", "record": record},
    ))
    assert "<script>" not in rendered
    assert "<b>bad</b>" not in rendered
    assert "&lt;script&gt;" in rendered
    assert "&lt;b&gt;bad&lt;/b&gt;" in rendered


def test_telegram_command_aliases_and_chat_allowlist(monkeypatch):
    sent = []
    searches = []

    async def send(chat_id, text):
        sent.append((chat_id, text))

    async def search(kind, query):
        searches.append((kind, query))
        return [{"source": "transaction", "record": {"id": "tx-1"}}]

    async def record_text(kind, match):
        return f"{kind}:{match['record']['id']}"

    async def totals():
        return "solde-report"

    monkeypatch.setattr(server, "_telegram_config", lambda: ("not-a-user-visible-token", "chat-1"))
    monkeypatch.setattr(server, "_send_telegram_message", send)
    monkeypatch.setattr(server, "_telegram_search_records", search)
    monkeypatch.setattr(server, "_telegram_record_text", record_text)
    monkeypatch.setattr(server, "_telegram_provider_totals_text", totals)

    asyncio.run(server._telegram_handle_command({
        "chat": {"id": "another-chat"}, "text": "/retrait value",
    }))
    assert sent == []
    assert searches == []
    for command in ("/dépôt Client Test", "/échange @client-test", "/total Client Test"):
        asyncio.run(server._telegram_handle_command({
            "chat": {"id": "another-chat"}, "text": command,
        }))
    assert sent == [] and searches == []

    for command, expected in (
        ("/dépôt payer@example.test", ("depot", "payer@example.test")),
        ("/retrait +22890002222", ("retrait", "+22890002222")),
        ("/échange IZI-INTENT-33", ("echange", "IZI-INTENT-33")),
        ("/total Client Test", ("total", "Client Test")),
        ("/dépôt@BizBot @client-test", ("depot", "@client-test")),
    ):
        asyncio.run(server._telegram_handle_command({
            "chat": {"id": "chat-1"}, "text": command,
        }))
        assert searches[-1] == expected
        assert sent[-1][1].endswith(f"{expected[0]}:tx-1")

    asyncio.run(server._telegram_handle_command({
        "chat": {"id": "chat-1"}, "text": "/total",
    }))
    assert sent[-1] == ("chat-1", "solde-report")

    asyncio.run(server._telegram_handle_command({
        "chat": {"id": "chat-1"}, "text": "/total " + "x" * 101,
    }))
    assert "100 caractères maximum" in sent[-1][1]


def test_total_command_no_match_is_clear_and_does_not_fetch_balances(monkeypatch):
    _install_db(monkeypatch)
    sent = []

    async def send(chat_id, text):
        sent.append((chat_id, text))

    async def unexpected_balances():
        raise AssertionError("/total with a search must not fetch provider balances")

    monkeypatch.setattr(server, "_telegram_config", lambda: ("fixture-token", "chat-1"))
    monkeypatch.setattr(server, "_send_telegram_message", send)
    monkeypatch.setattr(server, "_telegram_provider_totals_text", unexpected_balances)
    asyncio.run(server._telegram_handle_command({
        "chat": {"id": "chat-1"}, "text": "/total no-such-reference",
    }))
    assert sent == [("chat-1", "Aucune transaction trouvée pour cette recherche.")]


def test_paydunya_balance_parser_aggregates_currency_and_rejects_bad_payload():
    totals = server._paydunya_balance_totals({
        "success": True,
        "description": "approximate",
        "Balance TG": "1250.25 XOF",
        "Balance BJ": "749.75 XOF",
        "Balance SN": "2.00 XAF",
    })
    assert totals == [
        {"currency": "XAF", "balance": "2.00"},
        {"currency": "XOF", "balance": "2000.00"},
    ]
    try:
        server._paydunya_balance_totals({"success": False, "message": "failure"})
    except ValueError:
        pass
    else:
        raise AssertionError("failed PayDunya response must be rejected")


def test_paydunya_balance_client_uses_documented_read_only_endpoint(monkeypatch):
    called = []

    async def fake_request(method, path, config):
        called.append((method, path, config))
        return {"success": True, "Balance TG": "1.00 XOF"}

    monkeypatch.setattr(paydunya, "_request", fake_request)
    config = {"mode": "live"}
    result = asyncio.run(paydunya.get_balance(config))
    assert result["success"] is True
    assert called == [("GET", "/api/v2/disburse/check-balance", config)]


def test_live_totals_labels_unavailable_providers_honestly(monkeypatch):
    async def paydunya_result():
        return {
            "label": "Pay Junior (PayDunya)", "state": "available",
            "mode": "LIVE", "approximate": True,
            "totals": [{"currency": "XOF", "balance": "100.00"}],
        }

    async def mbiyo_result():
        return {
            "label": "Bio Pay (Mbiyo)", "state": "available",
            "mode": "LIVE",
            "totals": [{"currency": "XOF", "balance": "200.00"}],
        }

    monkeypatch.setattr(server, "_telegram_paydunya_balance_result", paydunya_result)
    monkeypatch.setattr(server, "_telegram_mbiyo_balance_result", mbiyo_result)
    report = asyncio.run(server._telegram_provider_totals_text())
    assert "Pay Junior (PayDunya)" in report and "estimation approximative" in report
    assert "Africa Pay (AfribaPAY)" in report
    assert "Easy Change Pay (IzichangePay)" in report
    assert "solde indisponible" in report
    assert "Bio Pay (Mbiyo)" in report
    assert "100.00" in report and "200.00" in report


def test_live_balance_readers_use_existing_credentials_and_sanitize_values(monkeypatch):
    paydunya_config = {
        "enabled": True, "mode": "live",
        "_credentials": {
            "master_key": "fixture-master", "private_key": "fixture-private",
            "token": "fixture-token",
        },
    }

    async def get_paydunya_config(decrypt=False):
        assert decrypt is True
        return paydunya_config

    async def get_paydunya_balance(config):
        assert config is paydunya_config
        return {"success": True, "Balance TG": "12.50 XOF"}

    monkeypatch.setattr(server, "get_paydunya_config", get_paydunya_config)
    monkeypatch.setattr(server.paydunya, "get_balance", get_paydunya_balance)
    paydunya_result = asyncio.run(server._telegram_paydunya_balance_result())
    assert paydunya_result["state"] == "available"
    assert paydunya_result["totals"] == [{"currency": "XOF", "balance": "12.50"}]
    assert paydunya_result["approximate"] is True

    async def get_mbiyo_config(decrypt=False):
        assert decrypt is True
        return {
            "enabled": True, "mode": "live", "_api_key": "fixture-mbiyo",
            "base_url": "https://provider.example",
        }

    class FakeMbiyoClient:
        def __init__(self, api_key, base_url):
            assert api_key == "fixture-mbiyo"
            assert base_url == "https://provider.example"

        async def balances(self):
            return {"data": [{"currency": "XOF", "amount": "7.25"}]}

    monkeypatch.setattr(server, "get_mbiyo_config", get_mbiyo_config)
    monkeypatch.setattr(server.mbiyo, "MbiyoClient", FakeMbiyoClient)
    mbiyo_result = asyncio.run(server._telegram_mbiyo_balance_result())
    assert mbiyo_result["state"] == "available"
    assert mbiyo_result["totals"] == [{"currency": "XOF", "balance": "7.25"}]


def test_provider_errors_are_not_echoed_to_the_telegram_report(monkeypatch):
    async def get_paydunya_config(decrypt=False):
        return {
            "enabled": True,
            "_credentials": {
                "master_key": "fixture-master", "private_key": "fixture-private",
                "token": "fixture-token",
            },
        }

    async def failing_balance(_config):
        raise RuntimeError("provider response contained fixture-token")

    monkeypatch.setattr(server, "get_paydunya_config", get_paydunya_config)
    monkeypatch.setattr(server.paydunya, "get_balance", failing_balance)
    result = asyncio.run(server._telegram_paydunya_balance_result())
    assert result["state"] == "unavailable"
    assert "fixture-token" not in str(result)