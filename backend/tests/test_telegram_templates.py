"""Focused tests for the structured final-state Telegram alerts."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def test_rate_limit_blocks_without_telegram_message(monkeypatch):
    events = []
    async def alert(event_type, *args, **kwargs):
        events.append(event_type)
    async def identity(request):
        return {"ip": "203.0.113.10", "user_id": None}
    async def blocked(profile, identity):
        return {"limit": 12, "retry_after": 30, "reset": 12345}
    async def should_not_call_next(request):
        raise AssertionError("A blocked request must not reach the handler")

    monkeypatch.setattr(server, "_edge_ip_blocked", lambda request: False)
    monkeypatch.setattr(server, "_queue_security_telegram_alert", alert)
    monkeypatch.setattr(server, "_global_rate_identity", identity)
    monkeypatch.setattr(server, "_global_rate_consume", blocked)
    request = Request({
        "type": "http", "method": "GET",
        "path": "/api/deposits/mobile-money/deposit-id",
        "headers": [(b"host", b"example.test")], "query_string": b"",
    })
    response = asyncio.run(
        server.api_security_middleware(request, should_not_call_next))
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "30"
    assert not events

    oversized = Request({
        "type": "http", "method": "POST", "path": "/api/deposits/mobile-money",
        "headers": [(b"host", b"example.test"),
                    (b"content-length", str(server.MAX_REQUEST_BYTES + 1).encode())],
        "query_string": b"",
    })
    response = asyncio.run(
        server.api_security_middleware(oversized, should_not_call_next))
    assert response.status_code == 413
    assert events == ["request_too_large"]


def test_telegram_masks_contact_information():
    assert server._telegram_mask_email("hamedbouba49@gmail.com") == "h***@g***.com"
    assert server._telegram_mask_phone("002250501267353") == "002••••353"


def test_provider_liquidity_detector_does_not_match_local_wallet_error():
    assert server._is_provider_balance_insufficient(
        "PayDunya: insufficient balance in provider wallet"
    )
    assert server._is_provider_balance_insufficient(
        "Le solde du portefeuille de décaissement est insuffisant"
    )
    assert server._is_provider_balance_insufficient("insufficient liquidity")
    assert server._is_provider_balance_insufficient(
        "Insufficient orange network balance. Available: 0"
    )
    assert not server._is_provider_balance_insufficient(
        "Solde insuffisant (frais inclus)"
    )


def test_deposit_template_matches_operational_reference(monkeypatch):
    deposit = {
        "id": "DEP-1",
        "reference": "BTP-PAY-1",
        "provider": "mbiyo",
        "mbiyo_transaction_id": "MBIYO-1",
        "operator_name": "TMoney",
        "currency": "XOF",
        "amount": "500",
        "amount_gross": "500",
        "charged_amount": "521",
        "amount_net": "500",
        "source": "link_payment",
        "approved_at": "2026-09-14T20:07:16+00:00",
    }

    async def context(_data):
        return None, deposit

    async def parties(_transaction, _deposit):
        return [
            "━━━━ 👤 <b>EXPÉDITEUR (PAYEUR)</b> ━━━━",
            "📧 Email : <code>h***@g***.com</code>",
            "━━━━ 🏦 <b>BÉNÉFICIAIRE</b> ━━━━",
        ]

    monkeypatch.setattr(server, "_telegram_transaction_context", context)
    monkeypatch.setattr(server, "_telegram_party_lines", parties)
    text = asyncio.run(server._telegram_notification_text(
        "user-1", "deposit_success", "Dépôt confirmé", "body",
        {"deposit_id": "DEP-1"},
    ))

    assert "✅ PAIEMENT REÇU / DÉPÔT CONFIRMÉ" in text
    assert "Montant brut : <b>521 XOF</b>" in text
    assert "Montant crédité : <b>500 XOF</b>" in text
    assert "Passerelle : <b>Mbiyo</b>" in text
    assert "Opérateur : <b>TMoney</b>" in text
    assert "Lien de paiement" in text


def test_non_link_deposit_telegram_gross_keeps_the_requested_amount(monkeypatch):
    deposit = {
        "id": "DEP-2",
        "currency": "XOF",
        "amount": 500,
        "amount_gross": 500,
        "charged_amount": 521,
        "amount_net": 479,
        "source": "dashboard",
    }

    async def context(_data):
        return None, deposit

    async def parties(_transaction, _deposit):
        return []

    monkeypatch.setattr(server, "_telegram_transaction_context", context)
    monkeypatch.setattr(server, "_telegram_party_lines", parties)
    text = asyncio.run(server._telegram_notification_text(
        "user-1", "deposit_success", "Dépôt confirmé", "body",
        {"deposit_id": "DEP-2"},
    ))

    assert "Montant brut : <b>500 XOF</b>" in text
    assert "Montant crédité : <b>479 XOF</b>" in text


def test_withdrawal_template_shows_gross_net_and_provider(monkeypatch):
    transaction = {
        "id": "TX-1",
        "reference": "BTP-WIT-1",
        "amount": "6978.24",
        "currency": "XAF",
        "created_at": "2026-09-14T20:23:33+00:00",
        "metadata": {
            "total_debit": "7269",
            "recipient_gets": "6978.24",
            "provider": "fedapay",
            "operator_name": "MTN Mobile Money",
            "fedapay_payout_id": "FEDA-1",
        },
    }

    async def context(_data):
        return transaction, None

    async def parties(_transaction, _deposit):
        return ["━━━━ 👤 <b>EXPÉDITEUR</b> ━━━━", "━━━━ 📱 <b>DESTINATAIRE</b> ━━━━"]

    monkeypatch.setattr(server, "_telegram_transaction_context", context)
    monkeypatch.setattr(server, "_telegram_party_lines", parties)
    text = asyncio.run(server._telegram_notification_text(
        "user-1", "withdrawal_success", "Retrait confirmé", "body",
        {"transaction_id": "TX-1"},
    ))

    assert "✅ RETRAIT VALIDÉ AUTOMATIQUEMENT" in text
    assert "Montant brut : <b>7\u202f269 XAF</b>" in text
    assert "Montant net : <b>6\u202f978,24 XAF</b>" in text
    assert "Passerelle : <b>FedaPay</b>" in text
    assert "MTN Mobile Money" in text


def test_crypto_deposit_receipt_includes_safe_easychange_references(monkeypatch):
    transaction = {
        "id": "crypto-tx-1",
        "reference": "BTP-CRYPTO-1",
        "type": "deposit",
        "direction": "in",
        "amount": 12.5,
        "currency": "USDT",
        "metadata": {
            "provider": "izichangepay",
            "provider_reference": "ECP-INTENT-123",
            "izipay_intent_id": "ECP-INTENT-123",
            "coin": "USDT",
            "network": "TRC20",
            "deposit_address": "T123456789ABCDEFGHJKLMNPQRSTUVWXYZ",
            "tx_hash": "0xCryptoDepositTransactionHash",
            "amount_gross": 12.5,
            "amount_net": 12.25,
        },
    }

    async def context(_data):
        return transaction, None

    async def parties(_transaction, _deposit):
        return []

    monkeypatch.setattr(server, "_telegram_transaction_context", context)
    monkeypatch.setattr(server, "_telegram_party_lines", parties)
    text = asyncio.run(server._telegram_notification_text(
        "user-1", "deposit_success", "Dépôt crypto confirmé", "body",
        {"transaction_id": "crypto-tx-1"},
    ))

    assert "DÉPÔT CONFIRMÉ" in text
    assert "EasyChangePay" in text
    assert "BTP-CRYPTO-1" in text
    assert "ECP-INTENT-123" in text
    assert "Crypto / réseau" in text and "TRC20" in text
    assert "Wallet crédité" in text
    assert "0xCryptoDepositTransactionHash" in text
    assert "T123456789ABCDEFGHJKLMNPQRSTUVWXYZ" not in text
    assert "T1234567…UVWXYZ" in text


def test_withdrawal_manual_review_template_is_operational(monkeypatch):
    transaction = {
        "id": "TX-MANUAL-1",
        "reference": "BTP-WIT-MANUAL-1",
        "amount": "50000",
        "currency": "XOF",
        "created_at": "2026-09-23T10:00:00+00:00",
        "metadata": {
            "total_debit": "51000",
            "recipient_gets": "50000",
            "provider": "paydunya",
            "operator_name": "T-Money Togo",
            "manual_review_required": True,
            "provider_balance_insufficient": True,
            "recipient_phone": "+22890123456",
        },
    }

    async def context(_data):
        return transaction, None

    async def parties(_transaction, _deposit):
        return [
            "━━━━ 👤 <b>EXPÉDITEUR</b> ━━━━",
            "━━━━ 📱 <b>DESTINATAIRE</b> ━━━━",
            "☎️ Téléphone : <code>+228••••456</code>",
        ]

    monkeypatch.setattr(server, "_telegram_transaction_context", context)
    monkeypatch.setattr(server, "_telegram_party_lines", parties)
    text = asyncio.run(server._telegram_notification_text(
        "user-1",
        "withdrawal_manual_review",
        "Retrait en attente de validation",
        "body",
        {"transaction_id": "TX-MANUAL-1"},
    ))

    assert "⚠️ RETRAIT EN ATTENTE — FONDS PRESTATAIRE" in text
    assert "Montant brut : <b>51\u202f000 XOF</b>" in text
    assert "Montant net : <b>50\u202f000 XOF</b>" in text
    assert "PayDunya" in text
    assert "+22890123456" not in text


def test_crypto_deposit_settlement_queues_one_final_notification(monkeypatch):
    deposit = {
        "id": "crypto-deposit-1",
        "user_id": "user-1",
        "amount": 12.5,
        "coin": "USDT",
        "network": "TRC20",
        "asset_code": "USDT.TRC20",
        "catalog_asset_id": "USDT.TRC20",
        "usdt_rate": 1.0,
        "gateway_fee_pct": 1.0,
        "platform_fee_pct": 0.0,
        "gateway_fee_fixed": 0.0,
        "platform_fee_fixed": 0.0,
        "fee_pct": 1.0,
        "deposit_address": "T123456789ABCDEFGHJKLMNPQRSTUVWXYZ",
        "customer_email": "crypto-payer@example.test",
    }
    notification_calls = []
    settlement_updates = []

    class CryptoDeposits:
        async def find_one(self, _query, _projection=None):
            return dict(deposit)

        async def update_one(self, query, update):
            settlement_updates.append((query, update))
            return SimpleNamespace(modified_count=1)

    async def claim(_collection, _payment_id, _intent_id):
        return dict(deposit)

    async def credit_once(*_args, **_kwargs):
        return True

    async def record(*_args, **_kwargs):
        return SimpleNamespace(id="crypto-ledger-1", reference="BTP-CRYPTO-1")

    async def notify(*args, **kwargs):
        notification_calls.append((args, kwargs))

    monkeypatch.setattr(server, "db", SimpleNamespace(crypto_deposits=CryptoDeposits()))
    monkeypatch.setattr(server, "_claim_izipay_payment_settlement", claim)
    monkeypatch.setattr(server, "_crypto_usdt_rate", lambda _coin: 1.0)
    monkeypatch.setattr(
        server, "_crypto_wallet_spec",
        lambda **_kwargs: {"id": "USDT.TRC20"},
    )
    monkeypatch.setattr(server, "_crypto_wallet_field", lambda _spec: "balance_usdt")
    monkeypatch.setattr(server, "_credit_wallet_once", credit_once)
    monkeypatch.setattr(server, "record_tx", record)
    monkeypatch.setattr(server, "notify", notify)

    settled = asyncio.run(server._settle_izipay_payment(
        "crypto-deposit-1", "ECP-INTENT-123", "0xCryptoHash", "webhook",
    ))

    assert settled is True
    assert len(settlement_updates) == 1
    assert len(notification_calls) == 1
    args, kwargs = notification_calls[0]
    assert args[:2] == ("user-1", "deposit_success")
    assert kwargs["data"]["transaction_id"] == "crypto-ledger-1"


def test_crypto_payment_success_is_an_allowed_telegram_final_event():
    assert "payment_success" in server.TELEGRAM_FINAL_NOTIFICATION_TYPES


def test_security_alert_reports_blocked_outcome_and_solution():
    text = server._telegram_security_text({
        "security_event": "csrf_rejected",
        "outcome": "Tentative bloquée. Aucune mutation n’a été exécutée.",
        "solution": "Vérifier les sessions puis révoquer toute session inconnue.",
        "path": "/api/transfers",
        "method": "POST",
        "ip": "203.0.113.42",
        "detected_at": "2026-09-14T21:00:00+00:00",
    })

    assert "TENTATIVE INTER-SITE DÉTECTÉE" in text
    assert "Tentative bloquée" in text
    assert "Solution recommandée" in text
    assert "203.0.113.xxx" in text
    assert "203.0.113.42" not in text


def test_security_alert_reports_success_without_claiming_compromise():
    text = server._telegram_security_text({
        "security_event": "unusual_login",
        "outcome": (
            "Accès réussi avec des caractéristiques inhabituelles. "
            "Une attaque n’est pas confirmée."
        ),
        "solution": "Révoquer les sessions si cette connexion est inconnue.",
        "path": "/api/auth/login",
        "method": "POST",
        "ip": "2001:db8:1234:5678::1",
    })

    assert "CONNEXION INHABITUELLE RÉUSSIE" in text
    assert "Accès réussi" in text
    assert "attaque n’est pas confirmée" in text
    assert "2001:0db8:1234:5678:…" in text


def test_security_alert_escapes_untrusted_route_content():
    text = server._telegram_security_text({
        "security_event": "rate_limit_triggered",
        "outcome": "<b>blocked</b>",
        "solution": "<script>alert(1)</script>",
        "path": "/api/<script>",
        "method": "POST",
        "ip": "invalid",
    })

    assert "<script>" not in text
    assert "&lt;script&gt;" in text


def test_admin_login_template_is_masked_and_explicit(monkeypatch):
    async def user_summary(_user_id):
        return {
            "name": "Administrateur",
            "username": "owner",
            "email": "a***@e***.com",
        }

    monkeypatch.setattr(server, "_telegram_user_summary", user_summary)
    text = asyncio.run(server._telegram_notification_text(
        "admin-1",
        "admin_login",
        "Connexion administrateur",
        "body",
        {
            "ip": "203.0.113.42",
            "unusual": True,
            "detected_at": "2026-09-19T10:00:00+00:00",
        },
    ))

    assert "CONNEXION ADMINISTRATEUR" in text
    assert "caractéristiques inhabituelles" in text
    assert "203.0.113.xxx" in text
    assert "203.0.113.42" not in text


def test_kyc_template_includes_status_and_rejection_reason(monkeypatch):
    async def user_summary(_user_id):
        return {
            "name": "Client",
            "username": "client",
            "email": "c***@e***.com",
        }

    monkeypatch.setattr(server, "_telegram_user_summary", user_summary)
    text = asyncio.run(server._telegram_notification_text(
        "user-1",
        "kyc_rejected",
        "Décision KYC",
        "body",
        {
            "status": "rejected",
            "reason": "<document illisible>",
            "reviewed_at": "2026-09-19T10:00:00+00:00",
        },
    ))

    assert "KYC — REJETÉ" in text
    assert "&lt;document illisible&gt;" in text
    assert "<document illisible>" not in text


def test_provider_fee_catalog_uses_admin_values():
    result = server._public_fee_provider_mobile_money(
        [{
            "country": "TG",
            "country_label": "Togo",
            "code": "moov_tg",
            "name": "Moov Togo",
            "currency": "XOF",
            "fee_pct": 2.25,
            "fee_fixed": 50,
            "min": 100,
            "max": 500000,
        }],
        "paydunya",
    )

    assert result["enabled"] is True
    assert "provider" not in result["operators"][0]
    assert result["operators"][0]["fee_pct"] == 2.25
    assert result["operators"][0]["fee_fixed"] == 50