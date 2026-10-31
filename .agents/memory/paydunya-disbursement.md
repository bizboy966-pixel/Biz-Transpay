---
name: PayDunya disbursement
description: PayDunya payout token handling, submit reconciliation, and callback correlation.
---

PayDunya disbursement creation returns `disburse_token`. A non-success submit
response is not proof of rejection: query status using that same token, retry
submit only when verified status is `created`, keep `pending` or uncertain
outcomes reserved, and refund only a verified terminal `failed` result. The
callback reference must match the local transaction ID emitted in its URL and
the `withdrawal` transaction type. Validate the returned token, amount, mode,
and any supplied disbursement ID before settling.

**Why:** Treating an ambiguous submit response as a final refusal can return
funds while PayDunya is still processing a payout, and mismatched callback
correlation leaves confirmed payouts stuck.

**How to apply:** Keep submit/status reconciliation and callbacks idempotent;
use mocked provider responses in tests and never send real payout requests as
automated verification.
