---
name: Financial idempotency barriers
description: Durable rule for preventing duplicate wallet mutations across webhooks, polling, retries, and concurrent requests.
---

Every financial wallet mutation must carry a stable operation identifier and use a MongoDB conditional update as its idempotency barrier. Credits and refunds use an atomic increment plus an operation marker; debits also require an atomic balance floor check. Multi-currency exchanges should update both legs in one MongoDB update whenever both balances belong to the same user.

**Why:** Webhooks, reconciliation jobs, browser polling, and provider retries can execute concurrently. A status check followed by a balance increment is not safe and can duplicate value or overdraw a wallet.

**How to apply:** Derive the operation id from the provider event, local transaction/payout id, or client idempotency key. Keep the ledger write deterministic and retryable after a process crash; never treat a generic database error as a duplicate delivery.

Withdrawals queued for manual fulfilment must reserve funds from the exact source wallet immediately, including the selected crypto/network wallet. Store that wallet identity and the reserved native amount on the transaction; rejection refunds that same wallet exactly once.

**Why:** A pending payout must not leave the amount spendable while the platform still owes the requested transfer. Converting it to a generic USDT balance also breaks asset/network separation.

**How to apply:** Follow the same debit and refund idempotency barriers for automated and manually queued withdrawals. Do not move or infer balances from the legacy unassigned USDT field.