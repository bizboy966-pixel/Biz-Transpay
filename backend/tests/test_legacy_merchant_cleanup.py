"""Guard rails for the owner-initiated legacy merchant-data purge."""

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class FakeConnection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.statements = []

    def transaction(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def fetch(self, query, *_):
        self.statements.append(query)
        if query.startswith("DELETE"):
            return list(self.rows)
        return list(self.rows)

    async def execute(self, query, *_):
        self.statements.append(query)


class FakePool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return self.connection


OWNER = {"id": "owner", "role": "super_admin", "platform_owner": True}
ROWS = [
    {"collection": "api_keys", "doc_id": "key-a"},
    {"collection": "merchant_keys", "doc_id": "key-b"},
]


def test_cleanup_rejects_non_owner_without_database_access(monkeypatch):
    monkeypatch.setattr(server.postgres_store, "pool", None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.preview_legacy_merchant_cleanup(
            admin={"role": "super_admin", "platform_owner": False}))
    assert exc.value.status_code == 403


def test_cleanup_preview_never_deletes(monkeypatch):
    connection = FakeConnection(ROWS)
    monkeypatch.setattr(server.postgres_store, "pool", FakePool(connection))
    result = asyncio.run(server.preview_legacy_merchant_cleanup(admin=OWNER))
    assert result["counts"] == {"api_keys": 1, "merchant_keys": 1}
    assert result["total"] == 2
    assert result["fingerprint"] == server.legacy_merchant_digest(ROWS)
    assert not any(query.startswith("DELETE") for query in connection.statements)


def test_cleanup_requires_current_fingerprint_and_exact_phrase(monkeypatch):
    connection = FakeConnection(ROWS)
    monkeypatch.setattr(server.postgres_store, "pool", FakePool(connection))
    for confirmation, fingerprint, expected_status in [
        ("wrong", server.legacy_merchant_digest(ROWS), 428),
        ("RETIRER_ANCIENNE_API", "stale", 409),
    ]:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(server.execute_legacy_merchant_cleanup(
                server.LegacyMerchantCleanupRequest(
                    confirmation=confirmation, fingerprint=fingerprint), admin=OWNER))
        assert exc.value.status_code == expected_status
    assert not any(query.startswith("DELETE") for query in connection.statements)


def test_cleanup_deletes_exact_preview_and_audits(monkeypatch):
    connection = FakeConnection(ROWS)
    monkeypatch.setattr(server.postgres_store, "pool", FakePool(connection))
    result = asyncio.run(server.execute_legacy_merchant_cleanup(
        server.LegacyMerchantCleanupRequest(
            confirmation="RETIRER_ANCIENNE_API",
            fingerprint=server.legacy_merchant_digest(ROWS)), admin=OWNER))
    assert result == {"counts": {"api_keys": 1, "merchant_keys": 1},
                      "total": 2, "deleted": 2}
    assert sum(query.startswith("DELETE") for query in connection.statements) == 1
    assert any("INSERT INTO document_store" in query for query in connection.statements)