"""Focused tests for the structured final-state Telegram alerts."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


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
        "amount_gross": "7500",
        "amount_net": "7125",
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
    assert "Montant brut : <b>7\u202f500 XOF</b>" in text
    assert "Montant crédité : <b>7\u202f125 XOF</b>" in text
    assert "Passerelle : <b>Mbiyo</b>" in text
    assert "Opérateur : <b>TMoney</b>" in text
    assert "Lien de paiement" in text


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