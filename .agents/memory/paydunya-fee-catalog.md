---
name: PayDunya fee catalog
description: Durable product rules for PayDunya countries, operators, fee allocation, and lifecycle controls.
---

PayDunya pay-in must use a configurable tariff grid per country and operator. Admins can add supported countries/operators, disable or reactivate them, remove them from user-facing availability, and edit gateway and platform fees.

At payment time, the user chooses whether the client or the merchant bears the fees. If the client bears them, fees are added to the amount charged. If the merchant bears them, fees are deducted from the amount credited to Biz-transPay.

“Delete” must preserve historical transaction references and therefore means a reversible soft deletion or archival state, not physical removal of records that past transactions depend on.

All PayDunya-eligible countries may exist in the admin catalog, but Togo and its operators are the first production scope and must be validated before other countries are activated.

**Why:** Payment history must remain auditable while administrators need full control over live availability and pricing. Togo is the required first rollout.

**How to apply:** Use these rules for the PayDunya provider configuration, pay-in amount calculation, public deposit catalog, and transaction records. Keep provider fees snapshotted on each payment.