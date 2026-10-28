"""Parity vectors from the existing document adapter; uses only synthetic documents."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from postgres_document_store import _apply_update, _matches, _project

document = {
    "_id": "synthetic-doc", "id": "synthetic-user", "role": "admin",
    "balance_xof": 500, "active": True,
    "contact": {"phone": "22890123456", "email": "test@example.invalid"},
    "roles": ["admin", "support"],
    "events": [{"kind": "deposit", "amount": 500}, {"kind": "payout", "amount": 200}],
}
queries = [
    {"id": "synthetic-user"},
    {"contact.phone": {"$regex": "^228", "$options": "i"}},
    {"$or": [{"role": "user"}, {"role": "admin"}]},
    {"balance_xof": {"$gte": 500, "$lt": 501}},
    {"roles": {"$in": ["owner", "support"]}},
    {"active": {"$type": "bool"}},
    {"missing": {"$exists": False}},
    {"events": {"$elemMatch": {"kind": "deposit", "amount": {"$gte": 500}}}},
    {"balance_xof": {"$ne": 0, "$nin": [1, 2]}},
]
modified = _apply_update(document, {
    "$set": {"contact.name": "Synthetic"},
    "$unset": {"role": ""},
    "$inc": {"balance_xof": 25},
    "$addToSet": {"roles": {"$each": ["support", "finance"]}},
    "$push": {"events": {"kind": "refund", "amount": 25}},
    "$pull": {"events": {"kind": "payout"}},
})
print(json.dumps({
    "query_results": [_matches(document, query) for query in queries],
    "updated": modified,
    "projection": _project(document, {"id": 1, "contact.phone": 1, "_id": 0}),
}))
