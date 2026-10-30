---
name: Mobile Money withdrawal routing
description: Provider isolation and route ownership rules for Mobile Money payouts.
---

Pay Junior, Biya Pay, and Afrika Pay withdrawal availability, fees, and activation are payout-only settings, separate from their pay-in catalogues. Only one provider may own an active country/operator route. The provider is selected server-side, while customer-facing catalogues remain provider-neutral.

**Why:** Sharing pay-in and payout catalogues lets unrelated admin changes alter withdrawal availability. Duplicate active routes also make provider selection ambiguous.

**How to apply:** Keep payout catalogues provider-scoped; migrate legacy Mbiyo withdrawal entries once rather than continually importing pay-in edits; use AfribaPAY's payout routes rather than its deposit catalogue; retain provider precedence only to resolve legacy duplicates.

The withdrawal catalog may be saved with every route inactive. Check min/max ordering only for executable routes; a maximum of zero means no upper limit, consistent with payout amount handling.

**Why:** Administrators must be able to disable a legacy route without first editing unrelated limits, and zero is already interpreted as unbounded during payouts.

**How to apply:** Keep numeric and structural validation, but require a valid range only when a route is active, visible, and not archived. Preserve the one-active-provider-per-route check.

Merchant integrations must discover operator codes independently for deposits and payouts; a display name or a deposit code is not a payout identifier.

**Why:** Official Burkina collection and disbursement contracts use different Moov route identifiers, and deployments may configure different public aliases. Assuming one universal code breaks otherwise valid integrations.

**How to apply:** Present direction-specific enabled catalogues and examples. Treat the serving environment's catalogue as the authority for new operations; keep provider routing and credentials private.

Customer Mobile Money payouts may use only the supported fiat wallet currencies: XOF, XAF, CDF, USD, GMD, GNF, UGX, TZS, KES, RWF, GHS, NGN, ZAR, ZMW, and EGP. The selected country determines the currency, and the payout must debit that exact `balance_<currency>` wallet. Provider catalogue rows with an unsupported currency or a country/currency mismatch remain editable in admin but are not exposed to customers.

**Why:** Users asked to withdraw from the wallet matching the selected country. A payout must never debit a different currency wallet, and provider catalogues can include currencies for which the app has no customer balance.

**How to apply:** Keep the supported fiat list and country-to-currency map consistent across dashboard display, public operator catalogues, and server payout validation. Have admin screens consume the server's payout capability map rather than a narrower duplicated currency list. Preserve unsupported provider entries for admin editing, but do not expose them or accept a payout unless the exact local wallet exists and the configured country route matches.