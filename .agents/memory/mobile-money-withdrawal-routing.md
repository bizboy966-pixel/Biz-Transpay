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