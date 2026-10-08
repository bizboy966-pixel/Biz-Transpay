import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

import server
from models import PushAudienceSelection, PushCampaignSendRequest


def test_push_audience_filters_are_and_combined():
    selection = PushAudienceSelection(
        audience="group",
        account_type="merchant",
        country="tg",
        kyc_status="verified",
    )

    query = server._push_audience_query(selection)

    assert query["account_type"] == "merchant"
    assert query["country"] == "TG"
    assert query["kyc_status"] == "verified"
    assert query["role"] == {"$nin": ["admin", "super_admin"]}
    assert query["is_blocked"] == {"$ne": True}
    assert query["is_banned"] == {"$ne": True}


def test_push_audience_requires_valid_target():
    with pytest.raises(ValidationError):
        PushAudienceSelection(audience="group")
    with pytest.raises(ValidationError):
        PushAudienceSelection(audience="user")
    with pytest.raises(ValidationError):
        PushAudienceSelection(
            audience="all",
            account_type="personal",
        )

    selected_user = PushAudienceSelection(audience="user", user_id="user-1")
    assert server._push_audience_query(selected_user)["id"] == "user-1"


def test_all_user_notification_events_have_automatic_push_messages():
    assert set(server._AUTOMATIC_PUSH_MESSAGES) == {
        "deposit_success",
        "withdrawal_success",
        "withdrawal_pending",
        "withdrawal_failed",
        "withdrawal_manual_review",
        "transfer_success",
        "payment_success",
        "kyc_rejected",
        "kyc_resubmit_requested",
        "kyc_verified",
        "exchange_success",
    }
    assert server._AUTOMATIC_PUSH_MESSAGES["kyc_rejected"][2] == "/dashboard/kyc"
    assert server._AUTOMATIC_PUSH_MESSAGES["payment_success"][2] == "/dashboard/transactions"


def test_transaction_pushes_format_the_net_received_or_credited_amount():
    cases = [
        (
            "deposit_success",
            {"amount": 500, "currency": "XOF"},
            None,
            "Montant net crédité : 500 XOF",
        ),
        (
            "withdrawal_success",
            {"amount": 521, "currency": "XOF"},
            {
                "amount": 521,
                "currency": "XOF",
                "metadata": {"total_debit": 521, "recipient_gets": 500},
            },
            "Montant net reçu : 500 XOF",
        ),
        (
            "transfer_success",
            {"amount": 500, "currency": "XOF"},
            None,
            "Montant net transféré : 500 XOF",
        ),
        (
            "payment_success",
            {"amount": 500, "currency": "XOF"},
            None,
            "Montant net crédité : 500 XOF",
        ),
        (
            "exchange_success",
            {"amount": 500, "currency": "XOF", "received": 2.5, "to_currency": "USDT"},
            None,
            "Montant net reçu : 2,500000 USDT",
        ),
        (
            "deposit_success",
            {"amount": 0.0025, "currency": "BTC.BTC"},
            None,
            "Montant net crédité : 0,002500 BTC.BTC",
        ),
    ]

    for event_type, event_data, transaction, expected in cases:
        assert server._automatic_push_net_amount_text(
            event_type, event_data, transaction
        ) == expected


def test_deposit_push_body_includes_the_net_credit():
    body = server._automatic_push_body(
        "deposit_success",
        server._AUTOMATIC_PUSH_MESSAGES["deposit_success"][1],
        {"amount": 500, "currency": "XOF"},
    )

    assert body == (
        "Votre dépôt a été validé. Montant net crédité : 500 XOF."
    )


def test_automatic_withdrawal_push_uses_persisted_recipient_amount(monkeypatch):
    campaigns = []
    scheduled = []

    class Transactions:
        async def find_one(self, query, _projection=None):
            assert query == {"id": "tx-1"}
            return {
                "id": "tx-1",
                "amount": 521,
                "currency": "XOF",
                "metadata": {"total_debit": 521, "recipient_gets": 500},
            }

    class Campaigns:
        async def insert_one(self, campaign):
            campaigns.append(campaign)

    async def audience(_selection):
        return 1, 1

    monkeypatch.setattr(server, "_firebase_client_config", lambda: {"projectId": "test"})
    monkeypatch.setattr(server, "_firebase_service_account_info", lambda: {"project_id": "test"})
    monkeypatch.setattr(server, "_push_audience_counts", audience)
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(transactions=Transactions(), push_campaigns=Campaigns()),
    )
    monkeypatch.setattr(
        server, "_schedule_push_campaign_delivery", lambda campaign_id: scheduled.append(campaign_id)
    )

    asyncio.run(server._queue_automatic_push_notification(
        "user-1",
        "withdrawal_success",
        "auto-1",
        server._AUTOMATIC_PUSH_MESSAGES["withdrawal_success"],
        {"transaction_id": "tx-1", "amount": 521, "currency": "XOF"},
    ))

    assert campaigns[0]["body"] == (
        "Votre retrait a été validé. Montant net reçu : 500 XOF."
    )
    assert scheduled == ["auto-1"]


def test_non_final_transaction_pushes_do_not_claim_a_net_amount():
    assert server._automatic_push_net_amount_text(
        "withdrawal_pending",
        {"amount": 500, "currency": "XOF"},
    ) == ""


def test_security_policy_allows_firebase_messaging_requests():
    response = SimpleNamespace(headers={})
    request = SimpleNamespace(
        url=SimpleNamespace(path="/", scheme="http"),
        headers={},
    )

    server._apply_edge_security_headers(response, request)

    policy = response.headers["Content-Security-Policy"]
    assert "https://firebaseinstallations.googleapis.com" in policy
    assert "https://fcmregistrations.googleapis.com" in policy


def test_notify_schedules_pushes_for_all_user_notification_events(monkeypatch):
    class FakeNotifications:
        async def insert_one(self, _document):
            return None

    scheduled = []
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(notifications=FakeNotifications()),
    )
    monkeypatch.setattr(
        server,
        "_schedule_automatic_push_notification",
        lambda *args: scheduled.append(args),
    )
    monkeypatch.setattr(server, "_schedule_transaction_email", lambda *_args: None)

    async def send_notifications():
        event_types = (
            "deposit_success",
            "withdrawal_success",
            "kyc_verified",
            "exchange_success",
            "transfer_success",
            "withdrawal_pending",
            "withdrawal_failed",
            "withdrawal_manual_review",
            "payment_success",
            "kyc_rejected",
            "kyc_resubmit_requested",
        )
        for event_type in event_types:
            await server.notify(
                "user-1",
                event_type,
                "Titre",
                "Message",
                data={"transaction_id": f"{event_type}-1"},
                send_telegram=False,
            )

    asyncio.run(send_notifications())

    assert [call[1] for call in scheduled] == [
        "deposit_success",
        "withdrawal_success",
        "kyc_verified",
        "exchange_success",
        "transfer_success",
        "withdrawal_pending",
        "withdrawal_failed",
        "withdrawal_manual_review",
        "payment_success",
        "kyc_rejected",
        "kyc_resubmit_requested",
    ]
    assert scheduled[0][0] == "user-1"


def test_automatic_push_campaign_id_is_stable_per_business_event():
    first = server._automatic_push_campaign_id(
        "user-1",
        "exchange_success",
        {"transaction_id": "tx-123"},
        "notification-1",
    )
    duplicate = server._automatic_push_campaign_id(
        "user-1",
        "exchange_success",
        {"transaction_id": "tx-123"},
        "notification-2",
    )
    different = server._automatic_push_campaign_id(
        "user-1",
        "exchange_success",
        {"transaction_id": "tx-456"},
        "notification-3",
    )

    assert first == duplicate
    assert first != different


def test_push_campaign_request_constrains_request_id_and_message():
    campaign = PushCampaignSendRequest(
        audience="all",
        title="Test",
        body="Message",
        confirmation="CONFIRMER",
        request_id="req-123",
    )
    assert campaign.request_id == "req-123"

    with pytest.raises(ValidationError):
        PushCampaignSendRequest(
            audience="all",
            title="Test",
            body="Message",
            confirmation="CONFIRMER",
            request_id="../not-safe",
        )


def test_push_admin_send_has_its_own_permission_and_rate_profile():
    request = type(
        "AdminRequest",
        (),
        {
            "url": type("URL", (), {"path": "/api/admin/push/send"})(),
            "method": "POST",
        },
    )()
    assert server._admin_permission_for_request(request) == "notifications:send"
    assert "notifications:send" in server.ROLE_PERMISSIONS["ADMIN"]
    assert "notifications:send" not in server.ROLE_PERMISSIONS["SUPPORT"]
    assert server._global_rate_profile("/api/admin/push/send", "POST") == (
        "admin_push_send"
    )


def test_push_click_path_only_accepts_internal_paths():
    assert server._push_click_path(None) == "/dashboard"
    assert server._push_click_path("/dashboard/settings?tab=security") == (
        "/dashboard/settings?tab=security"
    )
    for unsafe in ("https://example.com", "//example.com", "javascript:alert(1)", "/\\evil"):
        with pytest.raises(Exception):
            server._push_click_path(unsafe)


def test_firebase_public_config_never_exposes_service_account(monkeypatch):
    monkeypatch.setenv(
        "FIREBASE_SERVICE_ACCOUNT_JSON",
        json.dumps({
            "project_id": "biz-transpay-test",
            "client_email": "push@example.iam.gserviceaccount.com",
            "private_key": "not-a-real-key",
        }),
    )
    monkeypatch.setenv("FIREBASE_WEB_API_KEY", "public-key")
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "biz-transpay-test")
    monkeypatch.setenv("FIREBASE_MESSAGING_SENDER_ID", "123")
    monkeypatch.setenv("FIREBASE_APP_ID", "app-id")
    monkeypatch.setenv("FIREBASE_VAPID_KEY", "public-vapid")
    monkeypatch.delenv("FIREBASE_AUTH_DOMAIN", raising=False)

    config = server._firebase_client_config()

    assert config == {
        "apiKey": "public-key",
        "authDomain": "biz-transpay-test.firebaseapp.com",
        "projectId": "biz-transpay-test",
        "messagingSenderId": "123",
        "appId": "app-id",
        "vapidKey": "public-vapid",
    }
    assert "private_key" not in config


def test_fcm_sender_uses_http_v1_payload_without_network():
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"name": "projects/test/messages/1"})

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await server._send_one_fcm_message(
                client,
                "test-project",
                "bearer",
                "registration-token",
                "Titre",
                "Message",
                "/dashboard",
                "campaign-1",
            )

    result = asyncio.run(send())

    assert result == "sent"
    request = requests[0]
    assert request.url.path == "/v1/projects/test-project/messages:send"
    assert request.headers["Authorization"] == "Bearer bearer"
    payload = json.loads(request.content)
    assert payload["message"]["token"] == "registration-token"
    assert payload["message"]["notification"] == {
        "title": "Titre",
        "body": "Message",
    }
    assert payload["message"]["data"] == {
        "url": "/dashboard",
        "campaign_id": "campaign-1",
    }


def test_fcm_sender_classifies_unregistered_tokens():
    async def handler(_request):
        return httpx.Response(
            404,
            json={"error": {"status": "UNREGISTERED"}},
        )

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await server._send_one_fcm_message(
                client,
                "test-project",
                "bearer",
                "expired-token",
                "Titre",
                "Message",
                "/dashboard",
                "campaign-1",
            )

    result = asyncio.run(send())

    assert result == "invalid"


@pytest.mark.parametrize(
    "status_code,error_status,error_code",
    [
        (403, "PERMISSION_DENIED", "SENDER_ID_MISMATCH"),
        (400, "INVALID_ARGUMENT", "INVALID_ARGUMENT"),
    ],
)
def test_fcm_sender_classifies_project_mismatch_and_invalid_tokens(
    status_code, error_status, error_code
):
    async def handler(_request):
        return httpx.Response(
            status_code,
            json={
                "error": {
                    "status": error_status,
                    "details": [{
                        "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                        "errorCode": error_code,
                    }],
                }
            },
        )

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await server._send_one_fcm_message(
                client,
                "test-project",
                "bearer",
                "stale-token",
                "Titre",
                "Message",
                "/dashboard",
                "campaign-1",
            )

    assert asyncio.run(send()) == "invalid"


def test_fcm_sender_preserves_platform_authentication_failure_code():
    async def handler(_request):
        return httpx.Response(
            401,
            json={
                "error": {
                    "status": "UNAUTHENTICATED",
                    "details": [{
                        "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                        "errorCode": "THIRD_PARTY_AUTH_ERROR",
                    }],
                }
            },
        )

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await server._send_one_fcm_message(
                client,
                "test-project",
                "bearer",
                "device-token",
                "Titre",
                "Message",
                "/dashboard",
                "campaign-1",
            )

    assert asyncio.run(send()) == "failed:THIRD_PARTY_AUTH_ERROR"


def test_fcm_sender_does_not_delete_token_for_generic_not_found():
    async def handler(_request):
        return httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            return await server._send_one_fcm_message(
                client,
                "test-project",
                "bearer",
                "possibly-valid-token",
                "Titre",
                "Message",
                "/dashboard",
                "campaign-1",
            )

    assert asyncio.run(send()) == "failed:NOT_FOUND"


def test_push_campaign_persists_permanent_failure_code_summary(monkeypatch):
    campaign = {
        "id": "campaign-1",
        "audience": {"audience": "user", "user_id": "user-1"},
        "title": "Titre",
        "body": "Message",
        "url": "/dashboard",
        "devices": 2,
    }
    updates = []

    class Campaigns:
        async def find_one(self, _query, _projection=None):
            return campaign

        async def update_one(self, _query, update):
            updates.append(update["$set"])
            return SimpleNamespace(modified_count=1)

    class Devices:
        async def delete_many(self, _query):
            return SimpleNamespace(deleted_count=0)

    async def device_records(_selection):
        return 1, [
            {"id": "device-1", "token": "token-1"},
            {"id": "device-2", "token": "token-2"},
        ], ["user-1"]

    results = iter(["sent", "failed:THIRD_PARTY_AUTH_ERROR"])

    async def send_one(*_args):
        return next(results)

    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(push_campaigns=Campaigns(), push_devices=Devices()),
    )
    monkeypatch.setattr(server, "_push_campaign_device_records", device_records)
    monkeypatch.setattr(
        server, "_firebase_access_token_sync", lambda: ("test-project", "bearer")
    )
    monkeypatch.setattr(
        server, "_firebase_client_config", lambda: {"projectId": "test-project"}
    )
    monkeypatch.setattr(server, "_send_one_fcm_message", send_one)

    asyncio.run(server._deliver_push_campaign("campaign-1"))

    final_update = updates[-1]
    assert final_update["status"] == "partial"
    assert final_update["sent"] == 1
    assert final_update["failed"] == 1
    assert final_update["failure_codes"] == {"THIRD_PARTY_AUTH_ERROR": 1}