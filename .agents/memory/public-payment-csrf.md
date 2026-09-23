---
name: Public payment CSRF boundary
description: CSRF handling for payment-link endpoints that intentionally accept anonymous browser payments.
---

Payment-link mutations are intentionally anonymous and must not require the payer's Biz-transPay session or CSRF token. They remain protected by Turnstile, route-aware rate limits, one-time link claims, amount validation, and provider-side payment checks.

**Why:** A payer can open a public link in a browser that already has a Biz-transPay session cookie. Requiring that session's CSRF header makes the public checkout fail and incorrectly generates a security alert even though no authenticated mutation was attempted.

**How to apply:** Keep the exemption limited to payment-link payment and finalization routes. Do not extend it to authenticated transfers, wallet changes, admin actions, or merchant-management endpoints.