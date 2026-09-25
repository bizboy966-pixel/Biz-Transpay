import asyncio
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import pytest
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import referrals


def _matches(doc, query):
    for key, expected in query.items():
        value = doc
        for part in key.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if isinstance(expected, dict):
            if "$exists" in expected:
                exists = key in doc
                if exists != expected["$exists"]:
                    return False
            if "$ne" in expected and value == expected["$ne"]:
                return False
            if "$in" in expected and value not in expected["$in"]:
                return False
        elif value != expected:
            return False
    return True


class Cursor:
    def __init__(self, items):
        self.items = items

    def limit(self, n):
        self.items = self.items[:n]
        return self

    def sort(self, key, direction=1):
        keys = [(key, direction)] if isinstance(key, str) else key
        for name, order in reversed(keys):
            self.items.sort(key=lambda d: d.get(name) or "", reverse=order < 0)
        return self

    async def to_list(self, n):
        return copy.deepcopy(self.items if n is None else self.items[:n])


class Collection:
    def __init__(self):
        self.docs = []
        self.lock = asyncio.Lock()
        self.find_queries = []

    async def insert_one(self, doc):
        async with self.lock:
            if any(row.get("id") == doc.get("id") for row in self.docs):
                raise DuplicateKeyError("duplicate id")
            self.docs.append(copy.deepcopy(doc))

    async def find_one(self, query=None, projection=None):
        for row in self.docs:
            if _matches(row, query or {}):
                return copy.deepcopy(row)
        return None

    def find(self, query=None, projection=None):
        self.find_queries.append(copy.deepcopy(query or {}))
        return Cursor([copy.deepcopy(row) for row in self.docs if _matches(row, query or {})])

    async def update_one(self, query, update, upsert=False):
        async with self.lock:
            for row in self.docs:
                if _matches(row, query):
                    before = copy.deepcopy(row)
                    for key, value in update.get("$set", {}).items():
                        row[key] = copy.deepcopy(value)
                    for key, value in update.get("$setOnInsert", {}).items():
                        row.setdefault(key, copy.deepcopy(value))
                    for key, value in update.get("$inc", {}).items():
                        row[key] = row.get(key, 0) + value
                    for key, value in update.get("$addToSet", {}).items():
                        row.setdefault(key, [])
                        if value not in row[key]:
                            row[key].append(value)
                    return type("Result", (), {
                        "matched_count": 1,
                        "modified_count": int(before != row),
                    })()
            if upsert:
                row = {key: value for key, value in query.items() if not isinstance(value, dict)}
                row.update(copy.deepcopy(update.get("$setOnInsert", {})))
                row.update(copy.deepcopy(update.get("$set", {})))
                self.docs.append(row)
                return type("Result", (), {"matched_count": 0, "modified_count": 0})()
            return type("Result", (), {"matched_count": 0, "modified_count": 0})()


class ProjectionCollection(Collection):
    """Memory collection that applies Mongo-style inclusion projections."""

    def __init__(self):
        super().__init__()
        self.find_projections = []

    @staticmethod
    def _project(document, projection):
        if projection is None:
            return copy.deepcopy(document)
        included = [key for key, value in projection.items()
                    if key != "_id" and value]
        if included:
            return {key: copy.deepcopy(document[key])
                    for key in included if key in document}
        return copy.deepcopy(document)

    async def find_one(self, query=None, projection=None):
        document = await super().find_one(query, projection)
        return None if document is None else self._project(document, projection)

    def find(self, query=None, projection=None):
        self.find_projections.append(projection)
        matches = [self._project(document, projection)
                   for document in self.docs
                   if _matches(document, query or {})]
        return Cursor(matches)


class DB:
    def __init__(self):
        self.users = Collection()
        self.kyc = Collection()
        self.transactions = Collection()
        self.referral_commissions = Collection()
        self.referral_settings = Collection()


class Harness:
    def __init__(self):
        self.db = DB()
        self.credits = []
        self.ledger = []

    async def credit(self, user_id, field, amount, operation_id):
        user = await self.db.users.find_one({"id": user_id})
        if operation_id in (user or {}).get("wallet_credit_operation_ids", []):
            return False
        await self.db.users.update_one(
            {"id": user_id, "wallet_credit_operation_ids": {"$ne": operation_id}},
            {"$inc": {field: amount}, "$addToSet": {"wallet_credit_operation_ids": operation_id}},
        )
        self.credits.append((user_id, field, amount, operation_id))
        return True

    async def record(self, user_id, tx_type, direction, amount, currency,
                     operation_id=None, metadata=None):
        if any((row.get("metadata") or {}).get("operation_id") == operation_id
               for row in self.db.transactions.docs):
            return
        self.ledger.append((user_id, tx_type, direction, amount, currency, operation_id))
        await self.db.transactions.insert_one({
            "id": f"ledger-{operation_id}", "user_id": user_id, "type": tx_type,
            "direction": direction, "amount": amount, "currency": currency,
            "status": "completed",
            "metadata": {**(metadata or {}), "operation_id": operation_id},
        })

    async def add_user(self, user_id, *, sponsor="sponsor", verified=True,
                       verified_at=None, phone=None, document_number=None,
                       status=None, referred=True):
        suffix = user_id[-1] if user_id[-1].isdigit() else "9"
        user = {
            "id": user_id, "username": user_id, "phone": phone or f"+2289000000{suffix}",
            "country": "TG", "referred_by_user_id": sponsor if referred else None,
            "kyc_status": "verified" if verified else "pending",
        }
        if status:
            user["status"] = status
        await self.db.users.insert_one(user)
        await self.db.kyc.insert_one({
            "id": f"kyc-{user_id}", "user_id": user_id,
            "status": "verified" if verified else "pending",
            "verified_at": verified_at or (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            "country": "TG", "document_type": "cni",
            "document_number": document_number or user_id,
            "phone": user["phone"],
        })

    async def add_transaction(self, user_id, tx_id, amount, currency="XOF",
                              *, tx_type="deposit", status="completed",
                              direction="in", created_at=None, metadata=None):
        tx = {
            "id": tx_id, "user_id": user_id, "amount": amount, "currency": currency,
            "type": tx_type, "status": status, "direction": direction,
            "created_at": created_at or datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {},
        }
        await self.db.transactions.insert_one(tx)
        return tx


def run(coro):
    return asyncio.run(coro)


def _callbacks(harness):
    return harness.credit, harness.record


def test_concurrent_duplicate_deliveries_pay_one_lifetime_commission():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "invite-code"})
        transactions = []
        for i in range(5):
            await h.add_user(f"referee{i}")
            transactions.append(await h.add_transaction(f"referee{i}", f"tx{i}", 10000 + i * 100))
        credit, record = _callbacks(h)
        await asyncio.gather(*[
            referrals.process_transaction(h.db, tx, credit, record)
            for tx in transactions + transactions
        ])
        assert len(h.credits) == len(h.ledger) == 1
        assert h.credits[0][2] == 200
        assert (await h.db.referral_commissions.find_one({"id": "referral:sponsor"}))["status"] == "completed"

    run(scenario())


@pytest.mark.parametrize("invalid", [
    {"verified": False},
    {"kyc_record_status": "rejected"},
    {"status": "banned"},
])
def test_unverified_rejected_or_blocked_kyc_never_qualifies(invalid):
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "abc"})
        await h.add_user("referee1", verified=invalid.get("verified", True),
                         status=invalid.get("status"))
        if invalid.get("kyc_record_status"):
            await h.db.kyc.update_one({"user_id": "referee1"},
                                      {"$set": {"status": invalid["kyc_record_status"]}})
        tx = await h.add_transaction("referee1", "tx1", 1000)
        credit, record = _callbacks(h)
        await referrals.process_transaction(h.db, tx, credit, record)
        user = await h.db.users.find_one({"id": "referee1"})
        assert "referral_first_tx_id" not in user
        assert not h.credits
    run(scenario())


def test_transaction_must_follow_both_verified_statuses_and_verified_at():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "abc"})
        verified_at = datetime.now(timezone.utc)
        await h.add_user("referee1", verified_at=verified_at.isoformat())
        credit, record = _callbacks(h)
        tx = await h.add_transaction("referee1", "old", 300,
                                      created_at=(verified_at - timedelta(seconds=1)).isoformat())
        await referrals.process_transaction(h.db, tx, credit, record)
        await h.db.kyc.update_one({"user_id": "referee1"}, {"$set": {"status": "rejected"}})
        tx2 = await h.add_transaction("referee1", "mismatch", 300,
                                       created_at=(verified_at + timedelta(seconds=1)).isoformat())
        await referrals.process_transaction(h.db, tx2, credit, record)
        assert "referral_first_tx_id" not in await h.db.users.find_one({"id": "referee1"})
    run(scenario())


def test_first_five_distinct_candidates_net_currency_tie_and_frozen_rate():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "mycode"})
        await referrals.set_rate(h.db, 2.5)
        for i, (amount, currency) in enumerate([
            (101, "XOF"), (99, "XAF"), (200, "XOF"),
            (500, "XAF"), (300, "XOF"), (1, "XOF"),
        ]):
            await h.add_user(f"referee{i}")
            tx = await h.add_transaction(
                f"referee{i}", f"first{i}", amount, currency,
                metadata={"amount_net": amount},
                created_at=(datetime.now(timezone.utc) + timedelta(seconds=i)).isoformat(),
            )
            await referrals.process_transaction(h.db, tx, h.credit, h.record)
        claim = await h.db.referral_commissions.find_one({"id": "referral:sponsor"})
        assert claim["candidate_net_amount"] == 99
        assert claim["candidate_currency"] == "XAF"
        assert claim["amount"] == 2.48
        assert claim["rate_percent"] == 2.5
        assert len(claim["qualified_user_ids"]) == 5
        # The sixth referee is not part of the frozen first-five candidate pool.
        assert "referee5" not in claim["qualified_user_ids"]
        assert await referrals.get_rate(h.db) == {"rate_percent": 2.5}
        summary = await referrals.get_summary(h.db, "sponsor")
        assert summary == {
            "code": "sponsor", "invited_count": 6, "qualified_count": 6,
            "required_count": 5,
            "commission": {"status": "completed", "amount": 2.48,
                           "currency": "XAF", "rate_percent": 2.5},
        }
        assert "phone" not in str(summary)
        assert "document_number" not in str(summary)
    run(scenario())


def test_duplicate_identity_and_phone_are_not_counted_twice():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "abc"})
        for i in range(5):
            phones = {0: "+228 (900) 000-00", 1: "+22890000000"}
            documents = {2: "DUP-LIC 2", 3: "dup-lic-2"}
            await h.add_user(
                f"referee{i}", phone=phones.get(i, f"+2289000000{i}"),
                document_number=documents.get(i, f"DOC{i}"),
            )
        for i in range(5):
            tx = await h.add_transaction(f"referee{i}", f"tx{i}", 10000)
            await referrals.process_transaction(h.db, tx, h.credit, h.record)
        users = await h.db.users.find({"referred_by_user_id": "sponsor"}).to_list(10)
        assert sum(bool(u.get("referral_first_tx_id")) for u in users) == 1
        assert not h.credits
    run(scenario())


@pytest.mark.parametrize("duplicate_field", ["phone", "document_number"])
def test_projected_verified_kyc_duplicates_do_not_qualify(duplicate_field):
    async def scenario():
        h = Harness()
        h.db.users = ProjectionCollection()
        h.db.kyc = ProjectionCollection()
        await h.db.users.insert_one({"id": "sponsor", "username": "abc"})

        shared = "+22890000001" if duplicate_field == "phone" else None
        document = "SHARED-DOCUMENT" if duplicate_field == "document_number" else None
        await h.add_user(
            "referee-target", phone=shared, document_number=document
        )
        await h.add_user(
            "referee-duplicate", phone=shared, document_number=document
        )
        duplicate_tx = await h.add_transaction(
            "referee-target", "duplicate-identity-tx", 1000
        )
        unique_tx = await h.add_transaction(
            "referee-unique", "unique-identity-tx", 1000
        )
        await h.add_user("referee-unique", phone="+22890009999")

        await referrals.process_transaction(
            h.db, duplicate_tx, h.credit, h.record
        )
        await referrals.process_transaction(
            h.db, unique_tx, h.credit, h.record
        )

        assert "referral_first_tx_id" not in await h.db.users.find_one(
            {"id": "referee-target"}
        )
        assert (await h.db.users.find_one(
            {"id": "referee-unique"}
        ))["referral_first_tx_id"] == "unique-identity-tx"
        assert h.db.kyc.find_projections
        assert all(projection and projection.get("verified_at") == 1
                   for projection in h.db.kyc.find_projections)

    run(scenario())


def test_pending_claim_recovery_uses_frozen_values_and_idempotent_credit():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "abc"})
        for i in range(5):
            await h.add_user(f"referee{i}")
            tx = await h.add_transaction(f"referee{i}", f"tx{i}", 10000)
            await referrals.process_transaction(h.db, tx, h.credit, h.record)
        claim = await h.db.referral_commissions.find_one({"id": "referral:sponsor"})
        # Simulate crash after wallet credit but before the ledger and status update.
        await h.db.referral_commissions.update_one(
            {"id": claim["id"]}, {"$set": {"status": "pending"}}
        )
        await referrals.set_rate(h.db, 2.5)
        await referrals.reconcile(h.db, h.credit, h.record)
        await referrals.reconcile(h.db, h.credit, h.record)
        repaired = await h.db.referral_commissions.find_one({"id": claim["id"]})
        assert repaired["status"] == "completed"
        assert repaired["rate_percent"] == 2
        assert len(h.credits) == 1
        assert len(h.ledger) == 1
    run(scenario())


def test_reconcile_does_not_starve_users_after_old_transaction_page():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "unused-code"})
        for i in range(520):
            await h.db.transactions.insert_one({
                "id": f"old-{i}", "user_id": f"unrelated-{i}",
                "type": "deposit", "direction": "in", "amount": 100,
                "currency": "XOF", "status": "completed",
                "created_at": "2020-01-01T00:00:00+00:00", "metadata": {},
            })
        for i in range(5):
            await h.add_user(f"referee{i}")
            await h.add_transaction(
                f"referee{i}", f"eligible-{i}", 10000,
                created_at=(datetime.now(timezone.utc) + timedelta(seconds=i)).isoformat(),
            )
        result = await referrals.reconcile(h.db, h.credit, h.record)
        assert result["users_checked"] == 5
        assert h.db.transactions.find_queries == [{"status": "completed"}]
        assert len(h.db.users.find_queries) == 1
        assert len(h.db.kyc.find_queries) == 1
        assert (await h.db.referral_commissions.find_one(
            {"id": "referral:sponsor"}
        ))["status"] == "completed"
        assert len(h.credits) == 1
    run(scenario())


def test_earlier_recorded_eligible_transaction_wins_out_of_order_delivery():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "not-the-code"})
        await h.add_user("referee1")
        base = datetime.now(timezone.utc)
        earlier = await h.add_transaction(
            "referee1", "earlier-tx", 1000,
            created_at=(base - timedelta(minutes=5)).isoformat(),
        )
        later = await h.add_transaction(
            "referee1", "later-tx", 9999,
            created_at=base.isoformat(),
        )
        await referrals.process_transaction(h.db, later, h.credit, h.record)
        persisted = await h.db.users.find_one({"id": "referee1"})
        assert persisted["referral_first_tx_id"] == earlier["id"]
        assert persisted["referral_first_amount"] == 1000
    run(scenario())


def test_duplicate_identity_beyond_5000_users_fails_closed():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({"id": "sponsor", "username": "ignored"})
        await h.add_user("referee1", document_number="DUPLICATE-ID")
        for i in range(5001):
            uid = f"other-{i}"
            h.db.users.docs.append({
                "id": uid, "kyc_status": "verified", "phone": f"+44100{i}",
                "country": "GB", "document_type": "passport",
            })
            h.db.kyc.docs.append({
                "id": f"kyc-{uid}", "user_id": uid, "status": "verified",
                "verified_at": datetime.now(timezone.utc).isoformat(),
                "country": "TG" if i == 5000 else "GB",
                "document_type": "cni" if i == 5000 else "passport",
                "document_number": "DUPLICATE ID" if i == 5000 else f"OTHER-{i}",
            })
        tx = await h.add_transaction("referee1", "dup-tx", 1000)
        await referrals.process_transaction(h.db, tx, h.credit, h.record)
        assert "referral_first_tx_id" not in await h.db.users.find_one({"id": "referee1"})
    run(scenario())


def test_fractional_commission_and_blocked_sponsor_pending_recovery():
    async def scenario():
        h = Harness()
        await h.db.users.insert_one({
            "id": "sponsor", "username": "not-used", "status": "banned",
        })
        for i in range(5):
            await h.add_user(f"referee{i}")
            tx = await h.add_transaction(f"referee{i}", f"small-{i}", 1)
            await referrals.process_transaction(h.db, tx, h.credit, h.record)
        claim = await h.db.referral_commissions.find_one({"id": "referral:sponsor"})
        assert claim["amount"] == 0.02
        assert claim["status"] == "pending"
        assert h.credits == []
        await referrals.reconcile(h.db, h.credit, h.record)
        assert h.credits == []
        await h.db.users.update_one({"id": "sponsor"}, {"$set": {"status": "active"}})
        await referrals.reconcile(h.db, h.credit, h.record)
        await referrals.reconcile(h.db, h.credit, h.record)
        completed = await h.db.referral_commissions.find_one({"id": claim["id"]})
        assert completed["status"] == "completed"
        assert len(h.credits) == len(h.ledger) == 1
        assert h.credits[0][2] == 0.02
    run(scenario())


def test_invalid_rate_is_rejected():
    with pytest.raises(ValueError):
        run(referrals.set_rate(DB(), 3))


def test_live_payment_skips_platform_scans_for_non_referrals():
    async def scenario():
        h = Harness()
        await h.add_user("ordinary", referred=False)
        tx = await h.add_transaction("ordinary", "ordinary-deposit", 1000)
        await referrals.process_transaction(h.db, tx, h.credit, h.record)
        assert h.db.transactions.find_queries == []
        assert h.db.kyc.find_queries == []
        assert h.db.users.find_queries == []
        assert not h.credits

        await h.db.users.insert_one({"id": "sponsor", "username": "sponsor"})
        await h.add_user("referee1")
        referred_tx = await h.add_transaction("referee1", "referee-deposit", 1000)
        await referrals.process_transaction(h.db, referred_tx, h.credit, h.record)
        assert {"user_id": "referee1", "status": "completed"} in h.db.transactions.find_queries
        assert {"status": "completed"} not in h.db.transactions.find_queries

    run(scenario())