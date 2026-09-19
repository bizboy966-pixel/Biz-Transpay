---
name: Mbiyo integration
description: Mbiyo stays isolated internally while customer-facing Mobile Money routes remain provider-neutral.
---

Mbiyo is configured independently from PayDunya, with encrypted public key, secret key and webhook secret, an editable country/operator catalogue, server-side status verification, HMAC-SHA256 webhook validation, and idempotent wallet settlement.

**Why:** The existing PayDunya flows have provider-specific callback and reconciliation rules; sharing their configuration or route identifiers would risk changing live payment behavior.

**How to apply:** Keep internal operator codes provider-prefixed, strip provider identity from public route codes, resolve them server-side, and never let another integration handle a Mbiyo transaction.

Only add pay-in countries, networks, currencies, and limits that appear in the official merchant pay-in table. Gabon is not currently listed there.

**Why:** Account-registration country lists are not evidence of Mobile Money pay-in support, and guessed routes can accept funds without a valid settlement path.

**How to apply:** Treat the official merchant pay-in network table as authoritative; multi-currency countries need distinct route identities, and undocumented limits remain enforced by the upstream API rather than guessed locally.

Mbiyo exposes separate live endpoints for wallets, currency balances, and
network balances. Treat each response as a strict `data` list and keep wallet
totals separate from operator balances.

**Why:** The network endpoint is the authoritative source for operator funds,
while adding it to wallet totals would double-count the same provider money.
Permissive response guessing can also turn malformed fields into false balances.

**How to apply:** Validate required identity and monetary fields, reject unknown
shapes, use finite decimal arithmetic for totals, and never derive provider
funds from the local transaction ledger when the live Mbiyo API is available.