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

Provider payout catalogues may contain ISO local currencies beyond the customer wallets the app currently supports. These rows must remain editable and saveable in admin, while customer-facing payout catalogues include only currencies backed by the withdrawal flow (currently XOF and XAF).

**Why:** Rejecting a complete catalogue because one provider row uses a valid local currency prevents unrelated provider settings from being saved; exposing unsupported currencies would instead offer a withdrawal the wallet cannot execute.

**How to apply:** Validate currency-code shape for stored provider rows, preserve all provider entries, and filter unsupported payout currencies from every customer and integration catalogue until wallet and settlement support is implemented.