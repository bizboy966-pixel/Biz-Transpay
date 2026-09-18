---
name: Developer API safety
description: Financial safety rules for Biz-transPay test/live developer API operations and retries.
---

Developer API sandbox keys must remain fully local: they do not call payment providers and never debit or credit a real wallet. Test and live records, lookups, and idempotency owners remain isolated by environment.

**Why:** A test key reaching a configured live connector can move real money. Releasing idempotency after an ambiguous provider timeout can also create a second invoice, prompt, debit, or payout when the caller retries.

**How to apply:** Persist a durable local operation before or immediately around provider submission. Once an upstream operation may exist, retain the idempotency claim and return or reconcile the same pending operation rather than creating another one. Terminal webhooks require atomic one-time claims.

Sandbox financial simulations should calculate and expose the same fee snapshot, gross/net amounts, and total debit as live operations, while never touching a real wallet or provider.

**Why:** A zero-fee sandbox response hides integration and accounting errors until production, while a real sandbox debit violates environment isolation.

**How to apply:** Use the relevant admin deposit or withdrawal catalog for test responses, persist the snapshot locally, and keep completion local without real settlement.