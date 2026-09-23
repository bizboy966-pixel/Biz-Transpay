---
name: Provider liquidity review
description: Boundary between customer wallet failures and provider-funding failures during Mobile Money withdrawals.
---

Provider-fund insufficiency is an operational pending state, not an automatic customer refund. Keep the customer debit reserved, record the provider and payout context, alert the administrator through the existing Telegram channel, and let the administrator approve after manual payout or reject to invoke the exactly-once refund path.

**Why:** A provider wallet can be empty even when the customer has enough funds. Refunding immediately would release the reservation while an operator may still complete the payout manually, creating a reconciliation and double-payment risk.

**How to apply:** Detect provider-context messages such as provider wallet, disbursement balance, or insufficient liquidity. Do not classify the local wallet message “Solde insuffisant (frais inclus)” as provider liquidity. Keep provider routing and raw credentials server-side.