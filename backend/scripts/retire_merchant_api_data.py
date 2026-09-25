"""Preview and remove records attributable to the retired merchant API.

Run in the application's own environment, where DATABASE_URL points to that
environment's document_store. No wallet balance or shared unmarked record is
updated. The execution fingerprint must match a prior dry run exactly.

    python backend/scripts/retire_merchant_api_data.py
    python backend/scripts/retire_merchant_api_data.py --execute --confirm-fingerprint <sha256>
"""

import argparse
import asyncio
import hashlib
import os
from collections import Counter

import asyncpg


# These collections belong exclusively to the former merchant API. The
# integration API's similarly named collections are intentionally excluded.
OLD_COLLECTIONS = (
    "api_keys", "merchant_keys", "merchant_webhooks",
    "merchant_payments", "merchant_payouts", "webhook_deliveries",
)

# The other collections are shared with customer payments and the replacement
# integration. Remove only rows carrying an unambiguous old-API marker.
SELECTOR = """
    collection = ANY($1::text[])
    OR (collection = 'api_logs'
        AND (document->>'path' LIKE '/api/v1/%'
             OR document->>'path' = '/api/v1'))
    OR (collection = 'idempotency_keys'
        AND (document->>'path' LIKE '/api/v1/%'
             OR document->>'path' = '/api/v1'))
    OR (collection IN ('momo_deposits', 'payment_transactions')
        AND (document->>'source' = 'merchant_api'
             OR document->'metadata'->>'source' = 'merchant_api')
        AND coalesce(document->>'idempotency_key', '') NOT LIKE 'btpi_%'
        AND NOT EXISTS (
            SELECT 1 FROM document_store integration
            WHERE integration.collection = 'integration_operations'
              AND integration.document->>'business_id'
                  = document_store.document->>'id'
              AND integration.document->>'user_id'
                  = document_store.document->>'user_id'
        ))
    OR (collection = 'transactions'
        AND NOT EXISTS (
            SELECT 1 FROM document_store integration
            WHERE integration.collection = 'integration_operations'
              AND integration.document->>'business_id'
                  = document_store.document->>'id'
              AND integration.document->>'user_id'
                  = document_store.document->>'user_id'
        )
        AND (
            EXISTS (
                SELECT 1 FROM document_store payment
                WHERE payment.collection = 'merchant_payments'
                  AND payment.document->>'id'
                      = document_store.document->'metadata'->>'merchant_payment_id'
                  AND payment.document->>'merchant_id'
                      = document_store.document->>'user_id'
            )
            OR EXISTS (
                SELECT 1 FROM document_store payout
                WHERE payout.collection = 'merchant_payouts'
                  AND payout.document->>'id'
                      = document_store.document->'metadata'->>'merchant_payout_id'
                  AND payout.document->>'merchant_id'
                      = document_store.document->>'user_id'
            )
            OR EXISTS (
                SELECT 1 FROM document_store deposit
                WHERE deposit.collection = 'momo_deposits'
                  AND deposit.document->>'source' = 'merchant_api'
                  AND deposit.document->>'user_id'
                      = document_store.document->>'user_id'
                  AND coalesce(deposit.document->>'idempotency_key', '')
                      NOT LIKE 'btpi_%'
                  AND document_store.document->>'id'
                      = (deposit.document->>'provider') || '-deposit-'
                        || (deposit.document->>'id')
            )
            OR (document->'metadata'->>'source' = 'merchant_api'
                AND document->'metadata'->>'product' = 'bizpush'
                AND document->'metadata'->>'environment' IN ('test', 'live')
                AND document->>'description' LIKE 'BizPUSH%')
        ))
"""


def digest(rows):
    identity = "\n".join(f"{row['collection']}/{row['doc_id']}" for row in rows)
    return hashlib.sha256(identity.encode()).hexdigest()


async def run(execute: bool, confirmation: str | None) -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is required in the application's environment")
    conn = await asyncpg.connect(url)
    try:
        async with conn.transaction():
            if execute:
                # No concurrent document_store write can change the selection
                # between the fingerprint check and the deletion.
                await conn.execute("LOCK TABLE document_store IN SHARE ROW EXCLUSIVE MODE")
            rows = await conn.fetch(
                f"SELECT collection, doc_id FROM document_store WHERE {SELECTOR}"
                " ORDER BY collection, doc_id", OLD_COLLECTIONS)
            fingerprint = digest(rows)
            counts = Counter(row["collection"] for row in rows)
            print("Target: the database connected to this application's DATABASE_URL")
            for name in sorted(counts):
                print(f"  {name}: {counts[name]}")
            print(f"Total: {len(rows)}")
            print(f"Fingerprint: {fingerprint}")
            if not execute:
                print("DRY RUN — no changes made")
                return
            if confirmation != fingerprint:
                raise SystemExit("Fingerprint mismatch: no records deleted; preview again")
            removed = await conn.fetch(
                f"DELETE FROM document_store WHERE {SELECTOR}"
                " RETURNING collection, doc_id", OLD_COLLECTIONS)
            removed = sorted(removed, key=lambda row: (row["collection"], row["doc_id"]))
            if digest(removed) != fingerprint:
                raise RuntimeError("Deletion differed from preview; transaction rolled back")
            print(f"Deleted {len(removed)} attributable records; balances unchanged")
    finally:
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-fingerprint")
    args = parser.parse_args()
    if args.execute and not args.confirm_fingerprint:
        parser.error("--execute requires --confirm-fingerprint from a dry run")
    asyncio.run(run(args.execute, args.confirm_fingerprint))