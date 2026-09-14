---
name: Authorization boundaries
description: Durable rules for preventing IDOR/BOLA while preserving intentionally public payment capabilities.
---

Authenticated access is not sufficient by itself: every user-owned lookup and mutation must include the authenticated owner or merchant identifier in the database filter. Merchant API keys must also verify that the backing account is actually a merchant account.

**Why:** Resource identifiers are easy to guess or reuse across accounts; an authorization check that happens only before a broad lookup can expose or mutate another user's data.

**How to apply:** Use owner-scoped filters for transactions, deposits, links, payment sessions, merchant payments, payouts, keys, and webhooks. For deliberately public checkout, PSR, webhook, and payment-status capabilities, treat the slug/session/capability as the explicit authorization mechanism, return an allowlist of public fields, and never serialize the internal document directly.