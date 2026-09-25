---
name: Legacy merchant-data retirement
description: Ownership and production-access constraints when retiring the former merchant API without touching shared financial records.
---

Do not assume a shared `merchant_api` label proves that a financial ledger row belongs to the retired API. Some ordinary and replacement-integration paths reuse merchant-facing flags or shared payment tables. Identify old operations through exclusive collections or corroborated ownership links, and preserve ambiguous rows and wallet balances.

**Why:** A shared label can occur in different financial flows, while a settled deposit's ledger may omit the label entirely. Deleting by label alone can remove unrelated history or leave attributable history behind.

**How to apply:** Preview exact counts separately in development and production. Use a fingerprint-bound, transactional selection from the application's own database connection for deletion. Replit's agent production SQL access is read-only; do not substitute development database access, attempt credentials extraction, or make a startup-triggered destructive purge. Production execution requires the published application's runtime environment and a fresh preview there.