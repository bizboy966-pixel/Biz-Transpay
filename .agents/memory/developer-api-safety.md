---
name: Developer API safety
description: Financial safety rules for Biz-transPay test/live developer API operations and retries.
---

New developer API Sandbox operations may use only an officially provided, demonstrably isolated test environment. Until that isolation is available, reject financial writes explicitly; do not simulate a successful payment or touch real wallets. Keep test and live credentials, records, lookups, and idempotency ownership separated.

**Why:** The user chose official provider tests only, with unsupported operations blocked. A test key reaching a configured live connector can move real money; a local simulated success would misrepresent what was tested. Releasing idempotency after an ambiguous provider timeout can create a second invoice, prompt, debit, or payout.

**How to apply:** Prove provider test credentials and wallet isolation before enabling a Sandbox financial write. Persist a durable operation before or immediately around submission. Once an upstream operation may exist, retain the idempotency claim and return or reconcile the same pending operation rather than creating another one. Terminal webhooks require durable one-time claims.

For debited payouts with no stored provider transaction ID, a missing ID is not proof that the payout was never sent. Only a durably proven pre-dispatch state may be refunded automatically; an uncertain dispatch keeps the debit reserved for documented manual review.

**Why:** A process can stop after a provider accepts a payout but before its response is saved. Refunding or resubmitting based solely on the missing response can pay the recipient twice.

**How to apply:** Require independently obtained, action-specific provider evidence before an administrator approves or refunds an uncertain payout, and record that evidence with the decision. Do not infer the provider outcome from a timeout.

Merchant status webhooks use a durable outbox and a stable event ID. Treat delivery as at-least-once and require consumers to deduplicate before applying side effects.

**Why:** A callback or process can repeat after a timeout or restart; marking an operation final before its notification is durably recorded can lose the merchant update.

**How to apply:** Persist the event before advancing the API operation snapshot, reuse the existing HMAC delivery/URL-security path, and retry delivery without repeating the financial operation. Document event types, signature verification, and idempotency together.

If a future official provider Sandbox is enabled, use the existing fee calculation and response contract, but keep its test ledger and settlement isolated from real balances. Do not restore local completion controls from the former merchant API.

**Why:** Fee-free simulations hide accounting mistakes, and local completion does not verify a real provider test integration.

**How to apply:** A Sandbox response must describe the provider's actual test result; otherwise return an unavailable error without claiming success.

API keys are opt-in: account registration, merchant promotion, API-page reads,
and webhook-container initialization must never create a test or live key.

**Why:** A generated sandbox key is still an unexpected credential and used to
reappear after the customer deleted it.

**How to apply:** Show an empty developer-key state until an explicit create or
regenerate action; when the last multi-key record is deleted, remove its
legacy compatibility copy so migration cannot resurrect it.

Deleting an integration environment must revoke its keys and remove its webhook configuration without deleting financial operations, idempotency claims, or payment history.

**Why:** Credential deletion is an access-control action, not a cancellation or rollback of already submitted financial work. Removing idempotency history can let an earlier uncertain payment be submitted again.

**How to apply:** Require fresh merchant authentication and explicit confirmation for deletion. State clearly that in-flight operations may continue and historical records remain. A re-created integration receives new credentials rather than reviving old secrets.

The developer API product scope includes both automatic deposits (pay-in) and automatic withdrawals (pay-out), not deposits alone.

**Why:** The user explicitly clarified: “Ça gère le dépôt automatique, retrait automatique. Il faut que les deux soient bons.”

**How to apply:** Verify both flows when changing shared financial integration behavior, including provider-confirmed outcomes and merchant notifications. Preserve payout opt-in, KYC, ownership checks, and financial idempotency; never enable live withdrawals on an API key without authorization.