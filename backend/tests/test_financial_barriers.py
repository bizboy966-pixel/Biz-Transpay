"""Concurrency tests for wallet-side financial idempotency barriers."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _Result:
    def __init__(self, modified_count):
        self.modified_count = modified_count


class _AtomicUsers:
    """Small in-memory model of Mongo's atomic update filter/update behavior."""

    def __init__(self, balance=0.0):
        self.doc = {
            "id": "user-1",
            "balance_usdt": balance,
            "wallet_credit_operation_ids": [],
            "wallet_debit_operation_ids": [],
        }
        self.lock = asyncio.Lock()

    async def update_one(self, query, update):
        async with self.lock:
            for key, expected in query.items():
                if key == "id" and self.doc.get("id") != expected:
                    return _Result(0)
                if key == "balance_usdt" and self.doc.get(key, 0) < expected["$gte"]:
                    return _Result(0)
                if key.endswith("operation_ids"):
                    if expected["$ne"] in self.doc.get(key, []):
                        return _Result(0)
            for field, amount in update.get("$inc", {}).items():
                self.doc[field] = self.doc.get(field, 0) + amount
            for field, value in update.get("$addToSet", {}).items():
                self.doc.setdefault(field, [])
                if value not in self.doc[field]:
                    self.doc[field].append(value)
            return _Result(1)

    async def find_one(self, query, projection=None):
        if self.doc.get("id") != query.get("id"):
            return None
        return dict(self.doc)


class _AtomicLinkPayments:
    async def find_one(self, query, projection=None):
        return None


class _AtomicPaymentLinks:
    def __init__(self):
        self.doc = {"id": "link-1", "active": True, "single_use": True}
        self.lock = asyncio.Lock()

    async def update_one(self, query, update):
        async with self.lock:
            if self.doc.get("id") != query.get("id"):
                return _Result(0)
            if query.get("active") is True and not self.doc.get("active"):
                return _Result(0)
            if "single_use_claim_id" in query:
                exists = "single_use_claim_id" in self.doc
                if query["single_use_claim_id"].get("$exists") is False and exists:
                    return _Result(0)
            for field, value in update.get("$set", {}).items():
                self.doc[field] = value
            for field in update.get("$unset", {}):
                self.doc.pop(field, None)
            return _Result(1)


def test_concurrent_credit_is_applied_once(monkeypatch):
    import server

    users = _AtomicUsers()
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
    async def run():
        return await asyncio.gather(*[
            server._credit_wallet_once("user-1", "balance_usdt", 10, "deposit:event-1")
            for _ in range(20)
        ])
    results = asyncio.run(run())

    assert sum(results) == 1
    assert users.doc["balance_usdt"] == 10


def test_concurrent_refund_is_applied_once(monkeypatch):
    import server

    users = _AtomicUsers()
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
    async def run():
        return await asyncio.gather(*[
            server._refund_wallet_once("user-1", "balance_usdt", 7, "payout:1")
            for _ in range(20)
        ])
    results = asyncio.run(run())

    assert sum(results) == 1
    assert users.doc["balance_usdt"] == 7


def test_concurrent_debits_cannot_overdraw(monkeypatch):
    import server

    users = _AtomicUsers(balance=10)
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
    async def run():
        return await asyncio.gather(*[
            server._debit_wallet_once("user-1", "balance_usdt", 7, f"payout:{i}")
            for i in range(2)
        ])
    results = asyncio.run(run())

    assert sum(results) == 1
    assert users.doc["balance_usdt"] == 3


def test_same_debit_operation_is_idempotent(monkeypatch):
    import server

    users = _AtomicUsers(balance=20)
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
    async def run():
        return await asyncio.gather(*[
            server._debit_wallet_once("user-1", "balance_usdt", 7, "payout:same")
            for _ in range(2)
        ])
    results = asyncio.run(run())

    assert sum(results) == 1
    assert users.doc["balance_usdt"] == 13


def test_single_use_link_has_one_concurrent_claim(monkeypatch):
    import server

    links = _AtomicPaymentLinks()
    monkeypatch.setattr(
        server, "db",
        SimpleNamespace(payment_links=links, link_payments=_AtomicLinkPayments()),
    )

    async def run():
        return await asyncio.gather(*[
            server._claim_single_use_link(
                {"id": "link-1", "active": True, "single_use": True})
            for _ in range(20)
        ], return_exceptions=True)

    results = asyncio.run(run())
    assert sum(isinstance(value, str) for value in results) == 1
    assert "single_use_claim_id" in links.doc