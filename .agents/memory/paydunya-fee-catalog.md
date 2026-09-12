---
name: PayDunya fee catalog
description: Durable product rules for PayDunya countries, operators, fee allocation, and lifecycle controls.
---

PayDunya pay-in must use a configurable tariff grid per country and operator. Admins can add supported countries/operators, disable or reactivate them, remove them from user-facing availability, and edit gateway and platform fees.

At payment time, the user chooses whether the client or Biz-transPay bears the fees. If the client bears them, fees are added to the amount charged. If Biz-transPay bears them, the client pays only the requested amount and the wallet still receives the requested amount.

“Delete” must preserve historical transaction references and therefore means a reversible soft deletion or archival state, not physical removal of records that past transactions depend on.

All PayDunya-eligible countries may exist in the admin catalog, but Togo and its operators are the first production scope and must be validated before other countries are activated.

**Why:** Payment history must remain auditable while administrators need full control over live availability and pricing. Togo is the required first rollout.

**How to apply:** Use these rules for the PayDunya provider configuration, pay-in amount calculation, public deposit catalog, and transaction records. Keep provider fees snapshotted on each payment.

Wallet credit must be exactly-once and repairable without relying on MongoDB replica-set transactions. A provider invoice must be stored locally before SoftPay is triggered, and a confirmed deposit identifier must atomically guard the balance increment.

**Why:** A fast provider callback or process failure must never produce a charged customer without a recoverable local payment, a missing ledger entry, or a duplicate wallet credit.

**How to apply:** Require verified completed server confirmation, use a durable per-deposit credit marker with deterministic ledger identity, and make retries repair status/ledger side effects without incrementing the balance again.