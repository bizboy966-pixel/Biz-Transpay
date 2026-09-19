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

An accepted request can lose its HTTP response before the local system receives
the provider transaction ID. Keep that operation pending and idempotent; never
refund or resubmit it merely because of a timeout or provider 5xx.

**Why:** Retrying or refunding an ambiguous submission can create a duplicate
collection or payout. Conversely, leaving it unbound can strand real customer
funds indefinitely.

**How to apply:** Persist the local order before the network call. A signed
callback may bind a missing provider ID only after a server-side status read
confirms that its order ID equals the pending local ID. All terminal outcomes
must then pass through the same invariant-checking reconciler.

Multiple Mobile Money providers may be enabled at the same time, but route
eligibility is evaluated per country, neutral code, currency, and operation.

**Why:** Provider-level activation alone can expose disabled operators or make
overlapping routes fail unpredictably.

**How to apply:** Require the provider to be enabled and configured, and the
route to be active, visible, non-archived, currency-matched, and payout-capable
when applicable. Public-catalog de-duplication and execution must use the same
tuple and deterministic priority.