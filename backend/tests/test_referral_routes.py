"""Offline route-level tests for referral registration and qualification hooks."""

import asyncio
import copy
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException, Response
from pymongo.errors import DuplicateKeyError
from pydantic import ValidationError
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402
from models import RegisterRequest  # noqa: E402


SPONSOR_ID = str(uuid.UUID("c2cf17ec-7725-4c20-b8c5-8946aa5091f1"))


def run_async(fn):
    return asyncio.run(fn())


class MemoryCollection:
    def __init__(self, rows=None, count=None):
        self.docs = [dict(row) for row in (rows or [])]
        self.count = count
        self.queries = []

    @staticmethod
    def _matches(doc, query):
        for key, expected in query.items():
            actual = doc.get(key)
            if isinstance(expected, dict):
                if "$ne" in expected and actual == expected["$ne"]:
                    return False
                if "$exists" in expected and (key in doc) != expected["$exists"]:
                    return False
            elif actual != expected:
                return False
        return True

    async def count_documents(self, _query):
        return self.count if self.count is not None else len(self.docs)

    async def find_one(self, query, projection=None):
        self.queries.append((dict(query), projection))
        doc = next((row for row in self.docs if self._matches(row, query)), None)
        if doc is None:
            return None
        if projection and projection.get("_id") == 0:
            includes = [key for key, value in projection.items()
                        if key != "_id" and value]
            if includes:
                return {key: doc[key] for key in includes if key in doc}
        return dict(doc)

    async def insert_one(self, doc):
        self.docs.append(dict(doc))


class MemoryDB:
    def __init__(self, users=None):
        self.users = MemoryCollection(users)


class OperationLedger:
    def __init__(self, *, race_on_insert=False):
        self.rows = []
        self.race_on_insert = race_on_insert

    @staticmethod
    def _value(document, path):
        value = document
        for part in path.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    async def find_one(self, query, projection=None):
        row = next(
            (item for item in self.rows
             if all(self._value(item, key) == expected
                    for key, expected in query.items())),
            None,
        )
        return copy.deepcopy(row)

    async def insert_one(self, document):
        if self.race_on_insert:
            self.race_on_insert = False
            winner = copy.deepcopy(document)
            self.rows.append(winner)
            raise DuplicateKeyError("operation id concurrently inserted")
        self.rows.append(copy.deepcopy(document))


class LedgerDB:
    def __init__(self, ledger):
        self.transactions = ledger


class ApprovalTransactions:
    def __init__(self, documents):
        self.docs = [copy.deepcopy(document) for document in documents]

    async def find_one(self, query, projection=None):
        doc = next((row for row in self.docs
                    if all(row.get(key) == value for key, value in query.items())),
                   None)
        return copy.deepcopy(doc)

    async def update_one(self, query, update):
        doc = next((row for row in self.docs
                    if all(row.get(key) == value for key, value in query.items())),
                   None)
        if doc is None:
            return SimpleNamespace(matched_count=0, modified_count=0)
        doc.update(copy.deepcopy(update.get("$set", {})))
        return SimpleNamespace(matched_count=1, modified_count=1)


class ApprovalDB:
    def __init__(self, transaction):
        self.transactions = ApprovalTransactions([transaction])


class ResetCursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, length):
        return copy.deepcopy(self.rows if length is None else self.rows[:length])


class ResetCollection:
    def __init__(self, docs=None):
        self.docs = [copy.deepcopy(doc) for doc in (docs or [])]

    @staticmethod
    def _matches(document, query):
        for key, expected in query.items():
            if key == "$or":
                if not any(ResetCollection._matches(document, part)
                           for part in expected):
                    return False
                continue
            actual = document.get(key)
            if isinstance(expected, dict):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$nin" in expected and actual in expected["$nin"]:
                    return False
            elif actual != expected:
                return False
        return True

    def find(self, query=None, projection=None):
        rows = [doc for doc in self.docs
                if self._matches(doc, query or {})]
        if projection:
            included = [key for key, value in projection.items()
                        if key != "_id" and value]
            if included:
                rows = [{key: doc[key] for key in included if key in doc}
                        for doc in rows]
        return ResetCursor(rows)

    async def delete_many(self, query):
        kept = [doc for doc in self.docs if not self._matches(doc, query)]
        deleted = len(self.docs) - len(kept)
        self.docs = kept
        return SimpleNamespace(deleted_count=deleted)

    async def update_many(self, query, update):
        modified = 0
        for doc in self.docs:
            if not self._matches(doc, query):
                continue
            before = copy.deepcopy(doc)
            doc.update(copy.deepcopy(update.get("$set", {})))
            for key in update.get("$unset", {}):
                doc.pop(key, None)
            for key, condition in update.get("$pull", {}).items():
                values = doc.get(key, [])
                pattern = condition.get("$regex")
                if pattern:
                    doc[key] = [value for value in values
                                if not re.search(pattern, str(value))]
                else:
                    doc[key] = [value for value in values if value != condition]
            modified += int(doc != before)
        return SimpleNamespace(matched_count=modified, modified_count=modified)


class ResetDB:
    def __init__(self, users=None, **collections):
        self.collections = {
            "users": ResetCollection(users),
            **{name: ResetCollection(rows) for name, rows in collections.items()},
        }

    def __getitem__(self, name):
        return self.collections.setdefault(name, ResetCollection())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


class FakeRequest:
    headers = {}
    client = None
    url = SimpleNamespace(path="/api/auth/register")


def sponsor(**overrides):
    result = {
        "id": SPONSOR_ID,
        "username": "sponsor-user",
        "email": "sponsor@example.com",
        "phone": "+22890001111",
        "is_blocked": False,
        "is_banned": False,
    }
    result.update(overrides)
    return result


def registration_request(**overrides):
    fields = {
        "full_name": "Referral Invitee",
        "username": "invitee123",
        "account_type": "merchant",
        "country": "TG",
        "phone": "+22890002222",
        "email": "invitee@example.com",
        "password": "Password123!",
        "turnstile_token": "offline-token",
    }
    fields.update(overrides)
    return RegisterRequest(**fields)


def prepare_registration(monkeypatch, database, events=None):
    monkeypatch.setattr(server, "db", database)
    async def turnstile(*_args):
        if events is not None:
            events.append("turnstile")

    monkeypatch.setattr(server, "_require_turnstile", turnstile)
    monkeypatch.setattr(server.auth_security, "admin_password_policy_errors", lambda _: [])
    monkeypatch.setattr(server.auth_security, "password_policy_errors", lambda _: [])
    monkeypatch.setattr(server, "hash_password", lambda _: "test-hash")
    monkeypatch.setattr(server, "_issue_session", lambda *_args: asyncio.sleep(0))


def test_public_invite_preview_returns_only_username_and_invalid_code_is_404(monkeypatch):
    async def check():
        database = MemoryDB([sponsor(full_name="Must stay private")])
        monkeypatch.setattr(server, "db", database)

        assert await server.referral_invite(SPONSOR_ID) == {"username": "sponsor-user"}
        with pytest.raises(HTTPException) as error:
            await server.referral_invite("not-a-uuid")
        assert error.value.status_code == 404

    run_async(check)


def test_registration_resolves_and_persists_sponsor_id_after_turnstile(monkeypatch):
    async def check():
        events = []
        database = MemoryDB([sponsor()])
        prepare_registration(monkeypatch, database, events)
        noncanonical_code = SPONSOR_ID.upper()
        original_find_one = database.users.find_one

        async def observe_lookup(query, projection=None):
            events.append("lookup")
            return await original_find_one(query, projection)

        monkeypatch.setattr(database.users, "find_one", observe_lookup)
        await server.register(
            registration_request(referral_code=noncanonical_code),
            FakeRequest(),
            Response(),
        )

        created = next(row for row in database.users.docs
                       if row.get("username") == "invitee123")
        assert created["referred_by_user_id"] == SPONSOR_ID
        assert created["referred_by_user_id"] != noncanonical_code
        assert events[0] == "turnstile"
        assert "lookup" in events[1:]

    run_async(check)


@pytest.mark.parametrize(
    ("request_overrides", "existing_sponsor", "message"),
    [
        ({"referral_code": "not-a-valid-referral-code"}, sponsor(), "Lien de parrainage invalide"),
        ({"referral_code": SPONSOR_ID, "phone": "+(228) 900-01111"},
         sponsor(), "Auto-parrainage interdit"),
    ],
)
def test_registration_rejects_invalid_or_self_referral_after_turnstile(
    monkeypatch, request_overrides, existing_sponsor, message
):
    async def check():
        events = []
        database = MemoryDB([existing_sponsor])
        prepare_registration(monkeypatch, database, events)

        with pytest.raises(HTTPException) as error:
            await server.register(
                registration_request(**request_overrides),
                FakeRequest(),
                Response(),
            )
        assert error.value.status_code == 400
        assert error.value.detail == message
        assert events == ["turnstile"]
        assert len(database.users.docs) == 1

    run_async(check)


def test_registration_without_referral_code_keeps_user_unreferred(monkeypatch):
    async def check():
        database = MemoryDB([sponsor()])
        prepare_registration(monkeypatch, database)
        await server.register(registration_request(), FakeRequest(), Response())

        created = next(row for row in database.users.docs
                       if row.get("username") == "invitee123")
        assert "referred_by_user_id" not in created
        assert "referral_registered_at" not in created

    run_async(check)


def test_my_referrals_passes_authenticated_user_id_to_service(monkeypatch):
    async def check():
        received = []

        async def summary(_database, user_id):
            received.append(user_id)
            return {"code": user_id}

        monkeypatch.setattr(server.referrals, "get_summary", summary)
        result = await server.my_referrals(uid="authenticated-user-id")
        assert result == {"code": "authenticated-user-id"}
        assert received == ["authenticated-user-id"]

    run_async(check)


def test_admin_referral_patch_requires_settings_write_and_rate_is_bounded():
    request = Request({
        "type": "http",
        "method": "PATCH",
        "path": "/api/admin/referrals/config",
        "headers": [],
        "query_string": b"",
        "server": ("testserver", 80),
        "scheme": "http",
        "client": ("testclient", 1234),
    })
    assert server._admin_permission_for_request(request) == "settings:write"
    with pytest.raises(ValidationError):
        server.AdminReferralConfigReq(rate_percent=1.99)
    with pytest.raises(ValidationError):
        server.AdminReferralConfigReq(rate_percent=2.51)
    assert server.AdminReferralConfigReq(rate_percent=2.5).rate_percent == 2.5


def test_referral_ledger_hook_qualifies_only_completed_net_deposits(monkeypatch):
    async def check():
        calls = []

        async def process(_database, transaction, *_callbacks):
            calls.append(dict(transaction))

        monkeypatch.setattr(server.referrals, "process_transaction", process)
        pending = {
            "id": "ledger-pending",
            "user_id": "invitee-id",
            "type": "deposit",
            "direction": "in",
            "currency": "XOF",
            "status": "pending",
            "amount": 2500,
            "metadata": {"amount_net": 2400},
        }
        completed = {**pending, "id": "ledger-completed", "status": "completed"}

        await server._process_referral_transaction(pending)
        assert calls == []
        await server._process_referral_transaction(completed)
        assert len(calls) == 1
        assert calls[0]["id"] == "ledger-completed"
        assert calls[0]["metadata"]["amount_net"] == 2400

    run_async(check)


def test_referral_commission_record_tx_reuses_row_for_operation_id(monkeypatch):
    async def check():
        ledger = OperationLedger()
        monkeypatch.setattr(server, "db", LedgerDB(ledger))
        monkeypatch.setattr(server, "_process_referral_transaction",
                            lambda _tx: asyncio.sleep(0))
        operation_id = f"referral-commission:{SPONSOR_ID}"

        first = await server.record_tx(
            SPONSOR_ID,
            "referral_commission",
            "in",
            25,
            "XOF",
            operation_id=operation_id,
        )
        replay = await server.record_tx(
            SPONSOR_ID,
            "referral_commission",
            "in",
            25,
            "XOF",
            operation_id=operation_id,
        )

        expected_id = str(uuid.uuid5(uuid.NAMESPACE_URL, operation_id))
        assert first.id == replay.id
        assert first.id == expected_id
        assert len(ledger.rows) == 1
        assert ledger.rows[0]["metadata"]["operation_id"] == operation_id

    run_async(check)


def test_referral_commission_record_tx_recovers_concurrent_duplicate_insert(monkeypatch):
    async def check():
        ledger = OperationLedger(race_on_insert=True)
        monkeypatch.setattr(server, "db", LedgerDB(ledger))
        monkeypatch.setattr(server, "_process_referral_transaction",
                            lambda _tx: asyncio.sleep(0))
        operation_id = f"referral-commission:{SPONSOR_ID}"

        result = await server.record_tx(
            SPONSOR_ID,
            "referral_commission",
            "in",
            25,
            "XOF",
            operation_id=operation_id,
        )

        assert result.id == str(uuid.uuid5(uuid.NAMESPACE_URL, operation_id))
        assert len(ledger.rows) == 1
        assert ledger.rows[0]["metadata"]["operation_id"] == operation_id

    run_async(check)


def test_manual_deposit_approval_sets_completion_time_before_referral_hook(monkeypatch):
    async def check():
        pending = {
            "id": "pending-deposit",
            "user_id": "invitee-id",
            "type": "deposit",
            "direction": "in",
            "amount": 2500,
            "currency": "XOF",
            "status": "pending",
            "metadata": {"amount_net": 2400},
        }
        database = ApprovalDB(pending)
        monkeypatch.setattr(server, "db", database)
        monkeypatch.setattr(server, "_record_mbiyo_submission_evidence",
                            lambda *_args: asyncio.sleep(0))
        monkeypatch.setattr(server, "_record_afribapay_submission_evidence",
                            lambda *_args: asyncio.sleep(0))
        monkeypatch.setattr(server, "_credit_wallet_once",
                            lambda *_args: asyncio.sleep(0, result=True))
        monkeypatch.setattr(server, "audit", lambda *_args, **_kwargs:
                            asyncio.sleep(0))
        monkeypatch.setattr(server, "_notify_user",
                            lambda *_args, **_kwargs: asyncio.sleep(0))

        referral_calls = []

        async def process_referral(database_arg, transaction, *_callbacks):
            stored = await database_arg.transactions.find_one(
                {"id": transaction["id"]}
            )
            referral_calls.append((transaction, stored))

        monkeypatch.setattr(server.referrals, "process_transaction",
                            process_referral)

        result = await server.admin_approve_transaction(
            "pending-deposit",
            server.AdminConfirmationRequest(confirmation="CONFIRMER"),
            admin={"id": "admin-id", "username": "admin-user"},
        )

        assert result["ok"] is True
        assert len(referral_calls) == 1
        hook_transaction, stored_transaction = referral_calls[0]
        assert stored_transaction["status"] == "completed"
        assert stored_transaction["completed_at"]
        assert hook_transaction["status"] == "completed"
        assert hook_transaction["completed_at"] == stored_transaction["completed_at"]
        assert hook_transaction["metadata"]["amount_net"] == 2400

    run_async(check)


def test_platform_reset_wipes_referral_commissions_in_both_modes_and_settings_on_full_wipe(
    monkeypatch,
):
    async def check():
        monkeypatch.setattr(server, "audit", lambda *_args, **_kwargs:
                            asyncio.sleep(0))

        full_database = ResetDB(
            users=[{"id": "account-1"}],
            referral_commissions=[{"id": "claim-1"}],
            referral_settings=[{"id": "settings-1"}],
        )
        monkeypatch.setattr(server, "db", full_database)
        full_result = await server.admin_platform_reset(
            server.AdminPlatformResetReq(
                confirmation="SUPPRIMER_TOUT",
                delete_all=True,
            ),
            admin={"id": "owner-id", "username": "owner", "role": "super_admin"},
            _recent_uid="owner-id",
        )

        assert "referral_commissions" in full_result["wiped"]
        assert "referral_settings" in full_result["wiped"]
        assert full_database["referral_commissions"].docs == []
        assert full_database["referral_settings"].docs == []

        partial_database = ResetDB(
            users=[{
                "id": "preserved-owner",
                "email": "owner@example.com",
                "role": "super_admin",
                "balance_xof": 100,
                "referred_by_user_id": "former-sponsor",
                "referral_registered_at": "2025-01-01T00:00:00+00:00",
                "referral_first_tx_id": "first-deposit",
                "referral_first_amount": 1000,
                "referral_first_currency": "XOF",
                "referral_qualified_at": "2025-01-02T00:00:00+00:00",
                "wallet_credit_operation_ids": [
                    "referral-commission:preserved-owner",
                    "manual-credit:preserved-owner",
                ],
            }],
            referral_commissions=[{"id": "claim-2"}],
            referral_settings=[{"id": "settings-2"}],
        )
        monkeypatch.setattr(server, "db", partial_database)
        partial_result = await server.admin_platform_reset(
            server.AdminPlatformResetReq(confirmation="RÉINITIALISER"),
            admin={"id": "owner-id", "username": "owner", "role": "super_admin"},
            _recent_uid="owner-id",
        )

        assert "referral_commissions" in partial_result["wiped"]
        assert partial_database["referral_commissions"].docs == []
        preserved = partial_database.users.docs[0]
        for field in (
            "referred_by_user_id",
            "referral_registered_at",
            "referral_first_tx_id",
            "referral_first_amount",
            "referral_first_currency",
            "referral_qualified_at",
        ):
            assert field not in preserved
        assert preserved["wallet_credit_operation_ids"] == [
            "manual-credit:preserved-owner"
        ]
        assert preserved["balance_xof"] == 0

    run_async(check)