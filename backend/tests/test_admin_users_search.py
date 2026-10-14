"""Offline tests for the admin users search endpoint."""
import asyncio
import re
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, clause) for clause in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict) and "$regex" in expected:
            flags = re.IGNORECASE if expected.get("$options") == "i" else 0
            if actual is None or not re.search(expected["$regex"], str(actual), flags):
                return False
        elif actual != expected:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def sort(self, field, direction):
        self.rows.sort(
            key=lambda row: str(row.get(field) or ""),
            reverse=direction < 0,
        )
        return self

    async def to_list(self, length):
        length = getattr(length, "default", length)
        return self.rows[:length]


class _Users:
    def __init__(self):
        self.rows = [
            {
                "id": "user-1",
                "full_name": "Mamadou Diallo",
                "username": "mamadou",
                "email": "mamadou@example.test",
                "phone": "+22890001122",
                "created_at": "2026-10-01T10:00:00Z",
            },
            {
                "id": "user-2",
                "full_name": "Afi Mensah",
                "username": "afi",
                "email": "afi@example.test",
                "phone": "+22891112233",
                "created_at": "2026-10-02T10:00:00Z",
            },
        ]

    def find(self, query, projection=None):
        return _Cursor(row for row in self.rows if _matches(row, query))


def _search(monkeypatch, query):
    class Database:
        users = _Users()

    monkeypatch.setattr(server, "db", Database())
    return asyncio.run(server.admin_list_users(admin={"id": "admin"}, q=query))


def test_admin_user_search_matches_username_with_at_prefix(monkeypatch):
    results = _search(monkeypatch, "@MAMADOU")
    assert [user["id"] for user in results] == ["user-1"]


def test_admin_user_search_matches_name_and_email_case_insensitively(monkeypatch):
    assert [user["id"] for user in _search(monkeypatch, "DIALLO")] == ["user-1"]
    assert [user["id"] for user in _search(monkeypatch, "MAMADOU@EXAMPLE.TEST")] == ["user-1"]


def test_admin_user_search_matches_pasted_formatted_phone(monkeypatch):
    results = _search(monkeypatch, "+228 90-00 11 22")
    assert [user["id"] for user in results] == ["user-1"]
