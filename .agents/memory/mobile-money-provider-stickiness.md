---
name: Mobile Money provider stickiness
description: The selected provider must own a Mobile Money operation from initiation through settlement in the dashboard and Biz-transPay API
---

Select the provider at initiation from the active admin catalogue for the requested country, operator, currency, and supported flow. Persist that provider and its provider reference on the operation. Every later status lookup, callback reconciliation, OTP/finalization, refund, and API status read must use that saved provider; never reselect or fail over an in-flight operation because the catalogue changed. Unknown or unavailable provider identity fails closed.

**Why:** Re-routing an existing operation can create duplicate charges or payouts, reconcile the wrong provider's status, or settle funds against a different transaction.

**How to apply:** Dispatch follow-up work from the stored operation provider and reference in both customer and integration API paths. Idempotent retries may retrieve or reconcile the existing operation through its original provider, but must not submit a second provider request.
