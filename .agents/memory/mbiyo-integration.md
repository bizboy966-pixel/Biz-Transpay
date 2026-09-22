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

Mbiyo reconciliation must normalize transaction statuses and response
containers while keeping provider transaction binding strict and unique.

**Why:** Mbiyo may return terminal success and transaction fields under nested
payment/transaction objects or alternate status keys; treating only one shape
leaves paid deposits pending. Generic nested IDs are unsafe because they may
identify a customer or another resource.

**How to apply:** Extract only known transaction-ID aliases from known response
containers, enforce uniqueness, verify the merchant order binding
server-to-server, and route every success through the exactly-once wallet
credit barrier.

The provider selected when a payment is created is authoritative for every
later status read, callback, retry, finalization, and reconciliation attempt.
Never send a transaction created by one provider to another provider's verifier.

**Why:** Multiple Mobile Money providers may be active at the same time, and a
shared verifier could confirm the wrong transaction or leave a valid payment
permanently pending.

**How to apply:** Persist the provider on the payment record, dispatch through
provider-specific adapters using that stored value, and reject/ignore any
callback or status response that does not match the recorded provider and
transaction identity.

The visible Mobile Money countdown is also the definitive Mbiyo verification
window. An unresolved deposit becomes failed when this window reaches zero and
must not remain eligible for delayed reconciliation.

**Why:** The product owner explicitly requires a bounded payment attempt rather
than continued verification after the initial display expires.

**How to apply:** Poll and process signed callbacks during the initial window.
Credit a verified success exactly once; otherwise mark the dashboard and
merchant-API payment failed at expiry and stop reconciling it.