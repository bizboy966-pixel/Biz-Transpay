"""
Biz-transPay — Production Data Reset Script
============================================
Purpose: Wipe all test/residual data from the database in preparation for the
production launch, while preserving ONLY the super_admin account
(bizboy966@gmail.com) and resetting all admin dashboard counters to 0.

Safety:
- Refuses to run unless env var CONFIRM_RESET=YES is set.
- Requires a Mongo dump backup first (mongodump) — writes to
  /app/backups/pre-reset-{timestamp}/ before touching any collection.
- Idempotent: safe to run multiple times.
- Logs a summary at the end.

Usage:
    CONFIRM_RESET=YES python3 /app/backend/scripts/reset_production_data.py

Preserved users (whitelist, by email — case-insensitive):
    - bizboy966@gmail.com

Everything else is wiped from:
    users (non-whitelisted), api_keys (of non-whitelisted users AND stale docs),
    transactions, payment_links, link_payments, crypto_deposits,
    webhook_events, webhook_deliveries, api_logs, notifications, tickets,
    support_messages, payment_transactions, merchant_payments, kyc,
    audit_logs.

The whitelisted user's balances (XOF/XAF/USDT) are forced to 0 to guarantee
the admin dashboard shows 0 everywhere. KYC status is preserved (verified).
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")

PRESERVED_EMAILS = {"bizboy966@gmail.com"}

# All collections that must be fully wiped (no preservation needed).
WIPE_ALL_COLLECTIONS = [
    "transactions",
    "payment_links",
    "link_payments",
    "crypto_deposits",
    "webhook_events",
    "webhook_deliveries",
    "api_logs",
    "notifications",
    "tickets",
    "support_messages",
    "payment_transactions",
    "merchant_payments",
    "audit_logs",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _run_mongodump(mongo_url: str, db_name: str, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "mongodump",
        f"--uri={mongo_url}",
        f"--db={db_name}",
        f"--out={out_dir}",
        "--gzip",
    ]
    print(f"[backup] Running: {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        print("[backup] STDOUT:", res.stdout)
        print("[backup] STDERR:", res.stderr)
        raise RuntimeError(f"mongodump failed with code {res.returncode}")
    print(f"[backup] OK — dump written to {out_dir}")


async def _reset(db) -> dict:
    stats: dict = {"before": {}, "after": {}, "deleted": {}}

    # 1) Snapshot counts before
    all_colls = set(WIPE_ALL_COLLECTIONS) | {"users", "api_keys", "kyc"}
    for coll in sorted(all_colls):
        stats["before"][coll] = await db[coll].count_documents({})

    # 2) Delete non-whitelisted users
    preserved_lower = [e.lower() for e in PRESERVED_EMAILS]
    preserved_users_docs = await db.users.find(
        {"email": {"$in": preserved_lower}}
    ).to_list(None)
    preserved_ids = [str(u["_id"]) for u in preserved_users_docs]
    preserved_emails_found = [u["email"] for u in preserved_users_docs]
    print(f"[users] Preserving: {preserved_emails_found} (ids={preserved_ids})")

    del_users = await db.users.delete_many(
        {"email": {"$nin": preserved_lower}}
    )
    stats["deleted"]["users"] = del_users.deleted_count
    print(f"[users] Deleted {del_users.deleted_count} non-whitelisted users")

    # 3) Delete api_keys not owned by preserved users (safer than dropping
    #    everything because we want to keep the admin's own API keys).
    del_keys = await db.api_keys.delete_many(
        {"user_id": {"$nin": preserved_ids}}
    )
    stats["deleted"]["api_keys"] = del_keys.deleted_count
    print(f"[api_keys] Deleted {del_keys.deleted_count} orphan/test keys")

    # 4) Delete KYC records of non-preserved users (preserved KYC stays)
    del_kyc = await db.kyc.delete_many({"user_id": {"$nin": preserved_ids}})
    stats["deleted"]["kyc"] = del_kyc.deleted_count
    print(f"[kyc] Deleted {del_kyc.deleted_count} KYC docs of removed users")

    # 5) Wipe all transactional collections completely
    for coll in WIPE_ALL_COLLECTIONS:
        r = await db[coll].delete_many({})
        stats["deleted"][coll] = r.deleted_count
        print(f"[{coll}] Deleted {r.deleted_count} docs")

    # 6) Reset balances of preserved users to 0 (guarantees admin dashboard
    #    counters read 0)
    if preserved_ids:
        res = await db.users.update_many(
            {"email": {"$in": preserved_lower}},
            {
                "$set": {
                    "balance_xof": 0.0,
                    "balance_xaf": 0.0,
                    "balance_usdt": 0.0,
                }
            },
        )
        print(f"[balances] Reset to 0 for {res.modified_count} preserved user(s)")
        stats["deleted"]["balance_reset"] = res.modified_count

    # 7) Snapshot counts after
    for coll in sorted(all_colls):
        stats["after"][coll] = await db[coll].count_documents({})

    return stats


async def main() -> int:
    if os.environ.get("CONFIRM_RESET") != "YES":
        print(
            "ABORT: destructive script. Re-run with CONFIRM_RESET=YES to proceed.",
            file=sys.stderr,
        )
        return 2

    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ["DB_NAME"]

    ts = _now_iso()
    backup_dir = Path(f"/app/backups/pre-reset-{ts}")
    _run_mongodump(mongo_url, db_name, backup_dir)

    client = AsyncIOMotorClient(mongo_url)
    try:
        db = client[db_name]
        stats = await _reset(db)
    finally:
        client.close()

    print("\n=== RESET SUMMARY ===")
    print(f"Backup: {backup_dir}")
    print("Before counts:")
    for k, v in stats["before"].items():
        print(f"  {k}: {v}")
    print("Deleted:")
    for k, v in stats["deleted"].items():
        print(f"  {k}: {v}")
    print("After counts:")
    for k, v in stats["after"].items():
        print(f"  {k}: {v}")

    # Assertions — the after state must show only the preserved users
    # and all other collections empty. If not, exit non-zero.
    preserved_expected = len(PRESERVED_EMAILS)
    if stats["after"]["users"] != preserved_expected:
        print(
            f"WARN: expected {preserved_expected} users after reset, "
            f"got {stats['after']['users']}",
            file=sys.stderr,
        )
        return 1
    for coll in WIPE_ALL_COLLECTIONS:
        if stats["after"][coll] != 0:
            print(f"WARN: {coll} not empty after reset: {stats['after'][coll]}", file=sys.stderr)
            return 1
    print("\nOK — production data reset complete.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
