---
name: PayDunya operator logos
description: How operator identifiers and visual assets should be handled in transaction surfaces.
---

PayDunya's catalogue is the source of truth for operator codes, names, countries, and payment routes, but the catalogue used by the application does not provide logo URLs. Transaction surfaces should resolve the matching public operator brand asset from those PayDunya identifiers and keep a neutral fallback.

**Why:** Treating a missing provider logo field as if it existed produces broken images or fabricated provider assets, while transaction history still needs a recognizable operator identity.

**How to apply:** Preserve the PayDunya operator code/name in transaction metadata, map those values to official public brand assets in the shared frontend component, and support an explicit provider-supplied logo URL if PayDunya adds one later.