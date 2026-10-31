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

Biz-transPay’s merchant API must use that same payout status reconciler for
detail reads and idempotent replays. A replay or status read may poll and settle
an existing payout, but must never submit it again; API responses must omit the
PayDunya invoice token and internal provider metadata.

**Why:** A stale API snapshot can leave a confirmed withdrawal marked pending,
while exposing the internal token or resubmitting from a read can compromise
provider security or duplicate money movement.

**How to apply:** Wire API reads to the shared reconciler, keep idempotency
records synchronized with the transaction, and return only the documented
provider-neutral payout fields.
