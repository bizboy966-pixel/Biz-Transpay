---
name: PayDunya fee catalog
description: Durable product rules for PayDunya countries, operators, fee allocation, and lifecycle controls.
---

PayDunya pay-in must use a configurable tariff grid per country and operator. Admins can add supported countries/operators, disable or reactivate them, remove them from user-facing availability, and edit gateway and platform fees.

At payment time, the user chooses whether the client or Biz-transPay bears the fees. If the client bears them, fees are added to the amount charged and the wallet receives the requested amount. If Biz-transPay bears them, the client pays the requested amount and the wallet receives that amount minus all fees.

For Orange incoming payments, the amount in the USSD instructions must be the payer's total, not the requested wallet credit. For 500 XOF plus 20 XOF in fees: client-borne fees mean a 520 XOF code and 500 XOF net; Biz-transPay-borne fees mean a 500 XOF code and 480 XOF net.

**Why:** The user explicitly approved these examples and required the existing confirmation instructions and payment process to remain unchanged.

**How to apply:** Keep the displayed and copied code, explanatory steps, and server-returned instructions consistent with the actual charged amount, including on public payment links.

The separate server-to-server integration API is an exception: deposits always include fees in the payer's requested total and credit only the net amount to the merchant; payouts always add fees to the merchant's debit while preserving the beneficiary's requested amount. Legacy fee-bearer values remain accepted in API requests for compatibility but cannot alter this rule.

**Why:** API callers treat the requested deposit amount as the exact payer total and the requested payout amount as the exact beneficiary receipt. A client-controlled fee-bearer would silently change those promises; the interactive payment choices should remain unchanged.

**How to apply:** Enforce the fee allocation at the integration boundary for both providers, snapshot fees normally, and keep idempotency claims based on the original request for safe retries. Do not change the shared fee calculator or browser payment-link flows.

“Delete” must preserve historical transaction references and therefore means a reversible soft deletion or archival state, not physical removal of records that past transactions depend on.

All PayDunya-eligible countries may exist in the admin catalog, but Togo and its operators are the first production scope and must be validated before other countries are activated.

**Why:** Payment history must remain auditable while administrators need full control over live availability and pricing. Togo is the required first rollout.

**How to apply:** Use these rules for the PayDunya provider configuration, pay-in amount calculation, public deposit catalog, and transaction records. Keep provider fees snapshotted on each payment.

Wallet credit must be exactly-once and repairable without relying on MongoDB replica-set transactions. A provider invoice must be stored locally before SoftPay is triggered, and a confirmed deposit identifier must atomically guard the balance increment.

**Why:** A fast provider callback or process failure must never produce a charged customer without a recoverable local payment, a missing ledger entry, or a duplicate wallet credit.

**How to apply:** Require verified completed server confirmation, use a durable per-deposit credit marker with deterministic ledger identity, and make retries repair status/ledger side effects without incrementing the balance again.

PayDunya checkout confirmation can omit the currency even for a completed invoice. New invoices must carry the expected currency, amount, and local deposit identity in returned custom data; historical currency-less compatibility is limited to XOF with an exact local identity match.

**Why:** Rejecting every currency-less response leaves legitimately paid XOF deposits uncredited, while accepting one without a bound local identity weakens reconciliation safety.

**How to apply:** Validate completed status, provider token, amount, static hash, local deposit identity, and the returned custom-data currency. Keep the narrow XOF compatibility rule only for invoices created before the currency field was added.

PayDunya withdrawals use a separate Mobile Money catalog under Admin → Fees → Withdrawals. Provider credentials remain only in the payment-provider configuration; customer responses never expose `withdraw_mode` or fee splits. Automatic PUSH withdrawals stay XOF-only until PayDunya documents a currency-safe XAF contract.

**Why:** Deposit and withdrawal availability and pricing must evolve independently, while one server-side credential source prevents duplicated secrets. PayDunya PUSH v2 documents its amount as XOF even though an operator list mentions Cameroon.

**How to apply:** Snapshot gateway/platform fees at withdrawal creation, select the provider route only on the server, require request idempotency, debit conditionally, and use repairable exactly-once markers for refunds and terminal reconciliation.

The customer-facing deposit fee grid must read the active PayDunya and Mbiyo
provider catalogues, while deposit-side crypto fees read the admin deposit
configuration. It must not display a separate default Mobile Money catalogue.

**Why:** Mobile Money deposits validate and charge against provider catalogues;
showing a legacy deposit settings list makes the user-facing fee page disagree
with the admin configuration and the actual payment route.

**How to apply:** Build the public deposit Mobile Money fee list from the same
filtered active/visible provider entries used by the deposit flow, preserving
the configured percentage, fixed fee, currency, and limits.

Public Mobile Money operator codes can differ from their provider catalogue IDs. Every stage of a deposit—route selection and provider-specific initiation—must use the same country-scoped equivalence check against active, visible, non-archived rows.

**Why:** A canonical T-Money code can pass the public catalogue and initial routing yet be rejected by a later raw-string comparison against the configured PayDunya code.

**How to apply:** Reuse the existing active-operator resolver at execution boundaries; do not globally rewrite stored provider codes or loosen country and activation filters.

PayDunya account eligibility for pay-in can be restricted by country even when operators are listed as locally active. A provider response that the pay-in channel is not allowed is an upstream account permission decision, not evidence that an operator code or phone format needs rewriting.

**Why:** PayDunya's SoftPay documentation describes country-specific account restrictions, and a live account returned a channel-not-allowed response for locally enabled operators.

**How to apply:** Confirm provider authorization for a country before promising production availability. Do not retry a rejected payment through a second provider after an invoice has been created; change routing only after verifying the alternate provider is configured and approved.