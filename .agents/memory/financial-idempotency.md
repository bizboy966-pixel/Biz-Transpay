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

Exchange crypto availability follows the active, locally enabled deposit asset/network catalog, not payout activation settings. Keep provider-active and configured crypto-to-USDT rate checks, and retain network-specific wallet fields.

**Why:** Exchange moves value between internal wallets; coupling its asset list to payout controls can hide assets that are enabled for deposits and conversion even when external withdrawals are configured separately.

**How to apply:** Use the deposit-enabled catalog for Exchange selector and mutation validation. Keep withdrawal eligibility and fees on the transfer configuration path, and continue excluding the legacy unassigned USDT balance from Exchange.

The historical unassigned `balance_usdt` is not an Exchange currency. Exchange selectors and mutations must use active catalog asset/network IDs only; keep the legacy balance unchanged and separate.

**Why:** Showing an unassigned ticker beside network-specific wallets implies a network provenance that the historical balance does not have.

**How to apply:** If the legacy balance must be displayed, keep it outside Exchange’s asset selector and never map it to a network wallet.

Internal Biz-to-Biz crypto transfers must use an exact active deposit-catalog asset/network ID and debit and credit the same network-specific wallet field. Never convert the asset or fall back to the legacy `balance_usdt`.

**Why:** A same-platform transfer should preserve the asset and network selected by the sender; silently changing either can misstate balances or send value into the wrong wallet.

**How to apply:** Validate the selected ID against the active deposit catalog on the server and use that catalog entry’s wallet field on both sides of the transfer.

When the dashboard defaults to a crypto wallet, compare active wallets by their USDT-equivalent value and keep manual selection available.

**Why:** Raw quantities of different coins cannot be compared meaningfully.

**How to apply:** Use the catalog’s normalized USDT value for default ranking; do not replace a still-valid user selection.