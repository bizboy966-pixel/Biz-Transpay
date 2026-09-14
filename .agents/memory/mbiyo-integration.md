---
name: Mbiyo integration
description: Mbiyo is isolated from the legacy providers and uses provider-prefixed Mobile Money routes.
---

Mbiyo is configured independently from PayDunya, with encrypted public key, secret key and webhook secret, an editable country/operator catalogue, server-side status verification, HMAC-SHA256 webhook validation, and idempotent wallet settlement.

**Why:** The existing PayDunya flows have provider-specific callback and reconciliation rules; sharing their configuration or route identifiers would risk changing live payment behavior.

**How to apply:** Keep Mbiyo operator codes prefixed with `mbiyo_`, route Mbiyo through its own client, webhook, and reconciliation loop, and never let a PayDunya fallback handle a Mbiyo transaction.

Mbiyo exposes separate live endpoints for wallets, currency balances, and
network balances. Treat each response as a strict `data` list and keep wallet
totals separate from operator balances.

**Why:** The network endpoint is the authoritative source for operator funds,
while adding it to wallet totals would double-count the same provider money.
Permissive response guessing can also turn malformed fields into false balances.

**How to apply:** Validate required identity and monetary fields, reject unknown
shapes, use finite decimal arithmetic for totals, and never derive provider
funds from the local transaction ledger when the live Mbiyo API is available.