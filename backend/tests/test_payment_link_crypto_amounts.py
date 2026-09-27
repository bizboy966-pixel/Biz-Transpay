import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class MemoryLinks:
    def __init__(self):
        self.docs = []

    async def insert_one(self, document):
        self.docs.append(dict(document))

    async def find_one(self, query, projection=None):
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                return dict(document)
        return None

    async def update_one(self, query, update):
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                document.update(update.get("$set", {}))
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)


def test_fixed_link_persists_separate_cfa_and_usdt_amounts(monkeypatch):
    links = MemoryLinks()
    monkeypatch.setattr(server, "db", SimpleNamespace(payment_links=links))
    request = server.PaymentLinkCreate(
        title="Cours en ligne", amount=5000, crypto_amount=8.25,
        amount_type="fixed",
    )

    result = asyncio.run(server._create_payment_link(request, "merchant-1"))

    assert result.amount == 5000
    assert result.crypto_amount == 8.25
    assert links.docs[0]["amount"] == 5000
    assert links.docs[0]["crypto_amount"] == 8.25
    assert asyncio.run(server._ensure_link_can_be_paid(
        links.docs[0])) == 5000
    assert asyncio.run(server._ensure_link_can_be_paid(
        links.docs[0], crypto=True)) == 8.25


def test_free_link_validates_and_returns_currency_specific_ranges(monkeypatch):
    links = MemoryLinks()
    monkeypatch.setattr(server, "db", SimpleNamespace(payment_links=links))
    request = server.PaymentLinkCreate(
        title="Don libre", amount_type="free",
        min_amount=1000, max_amount=50000,
        crypto_min_amount=1.5, crypto_max_amount=75,
    )
    link = asyncio.run(server._create_payment_link(request, "merchant-1"))
    stored = link.model_dump()

    assert asyncio.run(server._ensure_link_can_be_paid(
        stored, 2500)) == 2500
    assert asyncio.run(server._ensure_link_can_be_paid(
        stored, 7, crypto=True)) == 7
    with pytest.raises(HTTPException) as exc:
        server._payment_link_crypto_amount(stored, 1)
    assert exc.value.status_code == 400


def test_legacy_links_keep_their_original_crypto_amount_behavior():
    fixed = {"amount_type": "fixed", "amount": 12}
    flexible = {
        "amount_type": "free", "min_amount": 5, "max_amount": 20,
    }

    assert server._payment_link_crypto_amount(fixed) == 12
    assert server._payment_link_crypto_amount(flexible, 10) == 10


def test_public_link_exposes_only_the_two_configured_prices(monkeypatch):
    links = MemoryLinks()
    links.docs.append({
        "slug": "price-link", "title": "Service",
        "amount": 6000, "crypto_amount": 9.5,
        "amount_type": "fixed", "currency": "UNIVERSAL",
        "user_id": "private-owner",
    })
    monkeypatch.setattr(server, "db", SimpleNamespace(payment_links=links))

    public = asyncio.run(server.get_public_link("price-link"))

    assert public["amount"] == 6000
    assert public["crypto_amount"] == 9.5
    assert "user_id" not in public


def test_updating_a_link_keeps_cfa_and_usdt_free_ranges_separate(monkeypatch):
    links = MemoryLinks()
    links.docs.append({
        "id": "link-1", "user_id": "merchant-1", "title": "Old",
        "amount": 1000, "crypto_amount": 2, "currency": "UNIVERSAL",
        "amount_type": "fixed", "min_amount": None, "max_amount": None,
        "crypto_min_amount": None, "crypto_max_amount": None,
    })
    monkeypatch.setattr(server, "db", SimpleNamespace(payment_links=links))
    request = server.PaymentLinkUpdate(
        amount_type="free", amount=0,
        min_amount=2000, max_amount=8000,
        crypto_min_amount=3, crypto_max_amount=12,
    )

    result = asyncio.run(server.update_link(
        "link-1", request, "merchant-1"))

    assert result["min_amount"] == 2000
    assert result["max_amount"] == 8000
    assert result["crypto_min_amount"] == 3
    assert result["crypto_max_amount"] == 12
    assert server._payment_link_amount(result, 5000) == 5000
    assert server._payment_link_crypto_amount(result, 7) == 7