---
name: User PIN boundary
description: Required personal PIN scope for ordinary user sessions and outgoing in-app operations.
---

Ordinary users must activate a six-digit PIN before receiving an authenticated app session, use it at each login, and confirm it for in-app withdrawals and transfers. Keep existing server-to-server/developer API behavior, deposits, exchanges, payment links, and admin MFA/PIN behavior unchanged.

**Why:** the user selected withdrawals and transfers as the PIN-gated operations, chose current-password plus verified-email-link recovery, and explicitly asked to preserve existing APIs and business flows.

**How to apply:** keep user PIN credentials separate from admin PIN credentials, verify them on the server for the selected browser flows, never persist or include the raw PIN in transaction fingerprints, and leave unrelated flows and external API authentication untouched.
