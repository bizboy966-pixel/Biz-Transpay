"""Concurrency regression tests for the PostgreSQL-backed document store."""

import asyncio
import json
import os
from pathlib import Path
import sys
import uuid

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from postgres_document_store import PostgresDocumentStore  # noqa: E402


class FakePostgres:
    """A small transactional fake that honors PostgreSQL advisory locks."""

    def __init__(self, documents):
        self.documents = {
            (collection, str(doc.get("id") or doc["_id"])): json.dumps(doc)
            for collection, docs in documents.items()
            for doc in docs
        }
        self.locks = {}
        self.fetch_calls = []

    def acquire(self):
        return _Acquire(self)

    async def release(self, _connection):
        return None


class _Acquire:
    def __init__(self, pool):
        self.pool = pool

    def __await__(self):
        async def acquire_connection():
            return _Connection(self.pool)
        return acquire_connection().__await__()

    async def __aenter__(self):
        return _Connection(self.pool)

    async def __aexit__(self, *_):
        return None


class _Transaction:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, *_):
        for lock in self.connection.held_locks:
            lock.release()
        self.connection.held_locks.clear()


class _Connection:
    def __init__(self, pool):
        self.pool = pool
        self.held_locks = []

    def transaction(self):
        return _Transaction(self)

    async def fetch(self, query, collection, *args):
        await asyncio.sleep(0)
        self.pool.fetch_calls.append((query, (collection, *args)))
        candidate_filter = json.loads(args[0]) if "jsonb_each" in query else {}
        rows = []
        for (name, _), value in list(self.pool.documents.items()):
            if name != collection:
                continue
            document = json.loads(value)
            if any(
                document.get(field) != expected
                and not (
                    isinstance(document.get(field), list)
                    and expected in document[field]
                )
                for field, expected in candidate_filter.items()
            ):
                continue
            rows.append({"document": value})
        return rows

    async def execute(self, query, *args):
        if "pg_advisory_xact_lock" in query:
            namespace, collection = args
            lock = self.pool.locks.setdefault((namespace, collection), asyncio.Lock())
            await lock.acquire()
            self.held_locks.append(lock)
            return "SELECT 1"

        if query.lstrip().startswith("INSERT"):
            collection, doc_id, document = args
            self.pool.documents[(collection, str(doc_id))] = document
        elif query.lstrip().startswith("UPDATE"):
            if "SET doc_id=$3" in query:
                collection, old_id, new_id, document = args
                self.pool.documents.pop((collection, str(old_id)), None)
                self.pool.documents[(collection, str(new_id))] = document
            else:
                collection, doc_id, document = args
                self.pool.documents[(collection, str(doc_id))] = document
        elif query.lstrip().startswith("DELETE"):
            collection, doc_id = args
            self.pool.documents.pop((collection, str(doc_id)), None)
        else:
            raise AssertionError(f"Unexpected SQL: {query}")
        await asyncio.sleep(0)
        return "OK"


def test_concurrent_conditional_wallet_debits_and_idempotency_upserts():
    async def scenario():
        pool = FakePostgres({
            "wallets": [{"id": "wallet-1", "balance": 100}],
            "markers": [],
        })
        # Distinct store objects mimic separate application instances using a
        # common PostgreSQL database and therefore a common advisory-lock space.
        first = PostgresDocumentStore("unused")
        second = PostgresDocumentStore("unused")
        first.pool = second.pool = pool

        debit_query = {"id": "wallet-1", "balance": {"$gte": 80}}
        debit_update = {"$inc": {"balance": -80}}
        debit_results = await asyncio.gather(
            first.wallets.update_one(debit_query, debit_update),
            second.wallets.update_one(debit_query, debit_update),
        )
        assert sum(result.matched_count for result in debit_results) == 1
        wallet = await first.wallets.find_one({"id": "wallet-1"})
        assert wallet["balance"] == 20

        marker_results = await asyncio.gather(
            first.markers.update_one(
                {"marker": "payment-attempt-1"},
                {"$setOnInsert": {"status": "claimed"}},
                upsert=True,
            ),
            second.markers.update_one(
                {"marker": "payment-attempt-1"},
                {"$setOnInsert": {"status": "claimed"}},
                upsert=True,
            ),
        )
        markers = await first.markers.find({"marker": "payment-attempt-1"}).to_list()
        assert len(markers) == 1
        assert markers[0]["status"] == "claimed"
        assert sum(result.upserted_id is not None for result in marker_results) == 1

    asyncio.run(scenario())


def test_string_filter_pushdown_preserves_array_matching_and_complex_filters():
    async def scenario():
        pool = FakePostgres({
            "transactions": [
                {"id": "tx-1", "user_id": "user-1", "status": "completed"},
                {"id": "tx-2", "user_id": "user-1", "status": "pending"},
                {"id": "tx-3", "user_id": "user-2", "status": "completed"},
                {"id": "tx-4", "user_id": ["user-1"], "status": "completed"},
            ],
        })
        store = PostgresDocumentStore("unused")
        store.pool = pool

        rows = await store.transactions.find({
            "user_id": "user-1",
            "status": {"$in": ["completed"]},
        }).to_list()

        assert {row["id"] for row in rows} == {"tx-1", "tx-4"}
        sql, args = pool.fetch_calls[-1]
        assert "jsonb_each" in sql
        assert args[0] == "transactions"
        assert json.loads(args[1]) == {"user_id": "user-1"}

        limited = await store.transactions.find({"user_id": "user-1"}).limit(1).to_list()
        assert len(limited) == 1
        sql, args = pool.fetch_calls[-1]
        assert "LIMIT $3" in sql
        assert args[2] == 1

    asyncio.run(scenario())


def test_optional_real_postgres_concurrent_wallet_debit():
    """Opt-in integration check against an explicitly supplied development DB.

    It intentionally never falls back to DATABASE_URL. The unique collection
    and document ID isolate the only row this test inserts and removes.
    """
    if os.getenv("RUN_POSTGRES_DOCUMENT_STORE_DEV_CONCURRENCY") != "1":
        pytest.skip("Set explicit development-test flag to enable PostgreSQL test")
    database_url = os.getenv("POSTGRES_DOCUMENT_STORE_DEV_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Dedicated development-test PostgreSQL URL is not configured")

    async def scenario():
        first = PostgresDocumentStore(database_url)
        second = PostgresDocumentStore(database_url)
        collection_name = f"document_store_concurrency_test_{uuid.uuid4().hex}"
        document_id = f"wallet_{uuid.uuid4().hex}"
        try:
            await first.connect()
            await second.connect()
            first_collection = getattr(first, collection_name)
            second_collection = getattr(second, collection_name)
            await first_collection.insert_one({
                "id": document_id,
                "balance": 150,
                "markers": [],
            })

            results = await asyncio.gather(
                first_collection.update_one(
                    {"id": document_id, "balance": {"$gte": 100}},
                    {"$inc": {"balance": -100},
                     "$addToSet": {"markers": "debit-attempt"}},
                ),
                second_collection.update_one(
                    {"id": document_id, "balance": {"$gte": 100}},
                    {"$inc": {"balance": -100},
                     "$addToSet": {"markers": "debit-attempt"}},
                ),
            )
            final_document = await first_collection.find_one({"id": document_id})
            assert sum(result.matched_count for result in results) == 1
            assert final_document["balance"] == 50
            assert final_document["markers"] == ["debit-attempt"]
        finally:
            if first.pool is not None:
                # Collection name and document ID are unique to this invocation.
                await getattr(first, collection_name).delete_one({"id": document_id})
            await first.close()
            await second.close()

    asyncio.run(scenario())