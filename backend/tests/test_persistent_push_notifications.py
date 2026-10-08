import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402
from postgres_document_store import Collection  # noqa: E402


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, branch) for branch in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict) and "$ne" in expected:
            if actual == expected["$ne"]:
                return False
        elif actual != expected:
            return False
    return True


class FakeCursor:
    def __init__(self, documents):
        self.documents = list(documents)

    def sort(self, *_args):
        return self

    def limit(self, count):
        self.documents = self.documents[:count]
        return self

    async def to_list(self, count):
        return self.documents[:count]


class FakeNotifications:
    def __init__(self, documents=None):
        self.documents = list(documents or [])

    def find(self, query, _projection=None):
        return FakeCursor(
            document for document in self.documents if _matches(document, query)
        )

    async def insert_many(self, documents, ordered=True):
        inserted_ids = []
        known_ids = {document["_id"] for document in self.documents}
        for document in documents:
            if document["_id"] in known_ids:
                continue
            self.documents.append(dict(document))
            known_ids.add(document["_id"])
            inserted_ids.append(document["_id"])
        return SimpleNamespace(inserted_ids=inserted_ids)

    async def update_many(self, query, update):
        modified = 0
        for document in self.documents:
            if _matches(document, query):
                document.update(update["$set"])
                modified += 1
        return SimpleNamespace(modified_count=modified)

    async def delete_many(self, query):
        old_count = len(self.documents)
        self.documents = [
            document for document in self.documents if not _matches(document, query)
        ]
        return SimpleNamespace(deleted_count=old_count - len(self.documents))

    async def count_documents(self, query):
        return sum(_matches(document, query) for document in self.documents)


def test_admin_campaign_notifications_are_per_user_idempotent_and_include_offline_users(monkeypatch):
    notifications = FakeNotifications()
    queue = asyncio.Queue()
    monkeypatch.setattr(server, "db", SimpleNamespace(notifications=notifications))
    monkeypatch.setattr(server, "_sse_subscribers", {"online-user": [queue]})
    campaign = {
        "id": "campaign-42",
        "title": "Mise à jour importante",
        "body": "Le service sera temporairement indisponible.",
        "url": "/dashboard/transactions",
        "created_at": "2026-10-08T09:00:00+00:00",
    }

    asyncio.run(server._persist_push_campaign_notifications(
        campaign, ["online-user", "offline-user"]
    ))
    first_online = asyncio.run(queue.get())
    asyncio.run(server._persist_push_campaign_notifications(
        campaign, ["online-user", "offline-user"]
    ))

    by_user = {doc["user_id"]: doc for doc in notifications.documents}
    assert set(by_user) == {"online-user", "offline-user"}
    assert len(notifications.documents) == 2
    assert by_user["online-user"]["id"] != by_user["offline-user"]["id"]
    assert by_user["offline-user"]["requires_confirmation"] is True
    assert by_user["offline-user"]["read"] is False
    assert by_user["offline-user"]["body"] == campaign["body"]
    assert first_online["user_id"] == "online-user"
    assert queue.empty()


def test_pending_confirmation_and_bulk_actions_preserve_unconfirmed_admin_messages(monkeypatch):
    collection = FakeNotifications([
        {"id": "important-unread", "user_id": "user-1", "read": False,
         "requires_confirmation": True, "title": "Important"},
        {"id": "important-read", "user_id": "user-1", "read": True,
         "requires_confirmation": True, "title": "Déjà confirmé"},
        {"id": "ordinary-unread", "user_id": "user-1", "read": False},
        {"id": "other-user", "user_id": "user-2", "read": False,
         "requires_confirmation": True},
    ])
    monkeypatch.setattr(server, "db", SimpleNamespace(notifications=collection))

    pending = asyncio.run(server.pending_confirmation_notifications("user-1", 50))
    marked = asyncio.run(server.notification_mark_all_read("user-1"))
    remaining_unread = [
        doc["id"] for doc in collection.documents
        if doc.get("user_id") == "user-1" and not doc.get("read")
    ]
    deleted = asyncio.run(server.notification_delete_all("user-1"))

    assert [doc["id"] for doc in pending] == ["important-unread"]
    assert marked["unread_count"] == 1
    assert remaining_unread == ["important-unread"]
    assert deleted["deleted"] == 2
    assert [doc["id"] for doc in collection.documents] == [
        "important-unread", "other-user"
    ]


def test_push_recipient_query_includes_users_without_registered_devices(monkeypatch):
    class Users:
        async def count_documents(self, _query):
            return 2

        def find(self, _query, _projection=None):
            return FakeCursor([{"id": "online-user"}, {"id": "offline-user"}])

    class Devices:
        def find(self, query, _projection=None):
            assert query["user_id"]["$in"] == ["online-user", "offline-user"]
            return FakeCursor([{"id": "device-1", "token": "token-1"}])

    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(users=Users(), push_devices=Devices()),
    )
    monkeypatch.setattr(server, "_push_audience_query", lambda _selection: {"active": True})

    user_count, devices, user_ids = asyncio.run(
        server._push_campaign_device_records(SimpleNamespace())
    )

    assert user_count == 2
    assert [device["id"] for device in devices] == ["device-1"]
    assert user_ids == ["online-user", "offline-user"]


def test_postgres_document_store_supports_bounded_idempotent_batch_inserts():
    class FakePool:
        def __init__(self):
            self.calls = []

        async def fetch(self, query, *args):
            self.calls.append((query, args))
            return [
                {"doc_id": args[index]}
                for index in range(1, len(args), 2)
            ]

    class FakeStore:
        def __init__(self):
            self.pool = FakePool()

        @staticmethod
        def encode(document):
            return json.dumps(document)

    store = FakeStore()
    collection = Collection(store, "notifications")
    documents = [{"id": f"notice-{index}", "user_id": "user-1"} for index in range(251)]
    result = asyncio.run(collection.insert_many(documents, ordered=False))

    assert len(result.inserted_ids) == 251
    assert [len(call[1]) for call in store.pool.calls] == [501, 3]
    assert all("ON CONFLICT DO NOTHING" in call[0] for call in store.pool.calls)
    assert json.loads(store.pool.calls[0][1][2])["id"] == "notice-0"
