---
name: Outgoing KYC policy
description: Scope of KYC gates for wallet debits, integrations, and manual completion.
---

Require approved KYC (`kyc_status=verified`) for customer-initiated outbound transfers, payouts, wallet conversions, and admin completion of pending outgoing transactions. Check before idempotency reservations or wallet/provider side effects. Incoming deposits, payment-link collection, and other pay-ins remain available before KYC.

**Why:** KYC is a disbursement control, not a general account lock. Conversions count as outgoing because they debit the source wallet.

**How to apply:** Keep the rule shared across web and developer APIs, and cover both outgoing refusals and incoming-flow regressions in tests.