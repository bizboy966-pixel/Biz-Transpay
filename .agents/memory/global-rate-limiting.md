---
name: Global rate limiting
description: Route-aware request throttling for the Biz-transPay API.
---

Rate limiting is enforced at the application middleware boundary, before route handlers run. Profiles distinguish login, OTP, registration, recovery, payments, withdrawals, deposits, links, search, admin requests, webhooks, merchant API traffic, and a general API fallback. Authenticated requests use both IP and account/merchant buckets where available.

**Why:** Per-feature controls alone leave low-cost endpoints and newly added routes exposed to resource exhaustion or automated abuse.

**How to apply:** Add new sensitive routes to the route classifier before shipping them. Keep payment and payout creation stricter than reads, preserve the merchant API contract, return `429` with `Retry-After`, and use a shared store such as Redis if the app is ever deployed across multiple application processes.