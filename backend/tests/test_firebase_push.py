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


def test_automatic_pushes_are_limited_to_requested_validation_events():
    assert set(server._AUTOMATIC_PUSH_MESSAGES) == {
        "deposit_success",
        "withdrawal_success",
        "kyc_verified",
        "exchange_success",
    }
    assert server._AUTOMATIC_PUSH_MESSAGES["deposit_success"] == (
        "Dépôt validé",
        "Votre dépôt a été validé.",
        "/dashboard/transactions",
    )


def test_notify_schedules_only_the_four_automatic_push_events(monkeypatch):
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
        for event_type in (
            "deposit_success",
            "withdrawal_success",
            "kyc_verified",
            "exchange_success",
            "transfer_success",
        ):
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
    ]


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

    assert asyncio.run(send()) == "failed"