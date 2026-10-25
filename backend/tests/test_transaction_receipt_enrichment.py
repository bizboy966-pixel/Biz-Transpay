"""References and balances in current/historical receipts, without financial writes."""
import asyncio
import copy

import pytest
import server


@pytest.mark.parametrize("key", [
    "paydunya_disbursement_id", "paydunya_invoice_token",
    "paydunya_disbursement_token", "fedapay_payout_id",
    "mbiyo_transaction_id", "afribapay_transaction_id", "izipay_payout_id",
])
def test_outgoing_telegram_receipt_has_provider_reference_and_recorded_balances(monkeypatch, key):
    tx = {
        "id": "tx-1", "user_id": "user-1", "reference": "BTP-LOCAL",
        "direction": "out", "type": "transfer", "currency": "XOF",
        "amount": 500, "status": "completed", "metadata": {
            key: "PROVIDER-123", "wallet_balance_before": 2000,
            "wallet_balance_after": 1482, "wallet_balance_currency": "XOF",
        },
    }

    async def context(data):
        return tx, None

    async def parties(*args):
        return []

    monkeypatch.setattr(server, "_telegram_transaction_context", context)
    monkeypatch.setattr(server, "_telegram_party_lines", parties)
    before = copy.deepcopy(tx)
    text = asyncio.run(server._telegram_notification_text(
        "user-1", "withdrawal_success", "Retrait réussi", "", {"transaction_id": "tx-1"}))
    assert "PROVIDER-123" in text and "BTP-LOCAL" in text
    assert "SOLDE AVANT" in text and "SOLDE APRÈS" in text
    assert "<b>2\u202f000 XOF</b>" in text and "<b>1\u202f482 XOF</b>" in text
    assert tx == before


def test_historical_detail_enriches_saved_reference_but_does_not_invent_balances(monkeypatch):
    original = {"id": "old-1", "reference": "BTP-OLD", "metadata": {
        "paydunya_invoice_token": "PAYOUT-OLD"}}
    enriched = asyncio.run(server._enrich_transaction_wallet_snapshot(original))
    assert enriched["metadata"]["provider_reference"] == "PAYOUT-OLD"
    assert "provider_reference" not in original["metadata"]
    assert "wallet_balance_before" not in enriched["metadata"]
    assert "non enregistrés" in "\n".join(server._telegram_wallet_balance_lines(enriched))


def test_historical_snapshot_is_read_from_recorded_operation(monkeypatch):
    calls = []

    async def snapshot(user_id, currency, operation_id):
        calls.append((user_id, currency, operation_id))
        return {"wallet_balance_before": 2500, "wallet_balance_after": 2000,
                "wallet_balance_currency": "XOF"}

    monkeypatch.setattr(server, "_wallet_snapshot_metadata", snapshot)
    enriched = asyncio.run(server._enrich_transaction_wallet_snapshot({
        "id": "tx-old", "user_id": "user-1", "currency": "XOF",
        "metadata": {"wallet_operation_id": "withdraw:old"},
    }))
    assert calls == [("user-1", "XOF", "withdraw:old")]
    assert enriched["metadata"]["wallet_balance_after"] == 2000


def test_telegram_exchange_and_refund_keep_each_wallet_snapshot():
    text = "\n".join(server._telegram_wallet_balance_lines({
        "metadata": {
            "wallet_balances_before": {"balance_xof": 10000, "balance_xaf": 50},
            "wallet_balances_after": {"balance_xof": 9000, "balance_xaf": 1040},
            "refund_wallet_snapshot": {
                "wallet_balance_before": 9000, "wallet_balance_after": 10000,
                "wallet_balance_currency": "XOF",
            },
        },
    }))
    assert "SOLDE AVANT · XOF" in text and "SOLDE APRÈS · XAF" in text
    assert "REMBOURSEMENT" in text
    assert "9\u202f000 XOF" in text and "10\u202f000 XOF" in text


def test_crypto_snapshot_keeps_small_native_units():
    text = "\n".join(server._telegram_wallet_balance_lines({
        "currency": "BTC.BTC", "metadata": {
            "wallet_balance_before": .00000002,
            "wallet_balance_after": .00000001,
        },
    }))
    assert "0,00000002 BTC.BTC" in text and "0,00000001 BTC.BTC" in text
