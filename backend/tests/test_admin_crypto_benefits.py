"""Admin benefit summaries include crypto fees at their recorded USDT rate."""

import asyncio
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402
from postgres_document_store import AggregateCursor, Cursor, _matches  # noqa: E402


class _RowsCollection:
    def __init__(self, docs):
        self.docs = copy.deepcopy(docs)

    async def _rows(self):
        return copy.deepcopy(self.docs)

    def aggregate(self, pipeline):
        return AggregateCursor(self, pipeline)

    def find(self, query=None, projection=None):
        return Cursor(self, query or {}, projection)

    async def count_documents(self, query):
        return sum(1 for doc in await self._rows() if _matches(doc, query))


def test_admin_benefits_include_crypto_fees_in_usdt(monkeypatch):
    transactions = _RowsCollection([
        {
            "id": "xof-1",
            "currency": "XOF",
            "status": "completed",
            "metadata": {"platform_fee": 25},
        },
        {
            "id": "btc-legacy",
            "currency": "BTC.BEP20",
            "status": "completed",
            "metadata": {
                "platform_fee": 0.0001,
                "usdt_rate": 60000,
                "coin": "BTC",
                "network": "BEP20",
            },
        },
        {
            "id": "usdt-new",
            "currency": "USDT.TRC20",
            "status": "paid",
            "metadata": {
                "platform_fee": 0.5,
                "platform_fee_usdt": 0.5,
                "coin": "USDT",
                "asset_code": "USDT.TRC20",
            },
        },
        {
            "id": "crypto-pending",
            "currency": "BTC.BEP20",
            "status": "pending",
            "metadata": {
                "platform_fee": 1,
                "platform_fee_usdt": 60000,
                "coin": "BTC",
            },
        },
        {
            "id": "unclassified-fiat",
            "currency": "GHS",
            "status": "completed",
            "metadata": {"platform_fee": 8, "platform_fee_usdt": 8},
        },
    ])
    monkeypatch.setattr(
        server, "db", type("Database", (), {"transactions": transactions})()
    )

    result = asyncio.run(server.admin_benefits(period="all", admin={}))

    assert result["xof"] == {"total": 25.0, "count": 1}
    assert result["usdt"] == {"total": 6.5, "count": 2}


def test_admin_benefit_details_show_crypto_profit_as_usdt(monkeypatch):
    transactions = _RowsCollection([
        {
            "id": "btc-legacy",
            "currency": "BTC.BEP20",
            "type": "withdrawal",
            "status": "completed",
            "amount": 0.001,
            "metadata": {
                "platform_fee": 0.0001,
                "usdt_rate": 60000,
                "coin": "BTC",
                "network": "BEP20",
            },
        },
        {
            "id": "usdt-new",
            "currency": "USDT.TRC20",
            "type": "transfer",
            "status": "paid",
            "amount": 5,
            "metadata": {
                "platform_fee": 0.5,
                "platform_fee_usdt": 0.5,
                "coin": "USDT",
                "asset_code": "USDT.TRC20",
            },
        },
        {
            "id": "xof-1",
            "currency": "XOF",
            "type": "withdrawal",
            "status": "completed",
            "amount": 1000,
            "metadata": {"platform_fee": 25},
        },
    ])
    monkeypatch.setattr(
        server,
        "db",
        type("Database", (), {
            "transactions": transactions,
            "users": _RowsCollection([]),
        })(),
    )

    result = asyncio.run(
        server.admin_benefits_details(currency="USDT", admin={})
    )

    assert result["total"] == 2
    items = {item["tx_id"]: item for item in result["items"]}
    assert items["btc-legacy"]["platform_fee"] == 6
    assert items["btc-legacy"]["benefit_currency"] == "USDT"
    assert items["usdt-new"]["platform_fee"] == 0.5
    assert items["usdt-new"]["benefit_currency"] == "USDT"