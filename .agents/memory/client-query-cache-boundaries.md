---
name: Client query cache boundaries
description: Keep cached authenticated data isolated between accounts and fresh after financial mutations.
---

Every TanStack Query key for account-owned data must include the authenticated account ID. Placeholder data must never carry across account IDs. After a successful deposit, transfer, or conversion, invalidate affected transaction and wallet queries; cached data is a display optimization, never the authority for money movement.

**Why:** A shared browser cache can outlive a page or session transition; account-scoped keys prevent stale financial data from appearing under another account, while mutation invalidation makes new activity visible promptly.

**How to apply:** When adding a query for private data, include a stable account identifier in its key and scope placeholder data to that same identifier. Invalidate affected account views after successful mutations, leaving transaction validation and balances authoritative on the server.
