---
name: User PIN boundary
description: Required personal PIN scope for ordinary user sessions and outgoing in-app operations.
---

Ordinary users must activate a six-digit PIN before receiving an authenticated app session, use it at each login, and confirm it for in-app withdrawals and transfers. Keep existing server-to-server/developer API behavior, deposits, exchanges, payment links, and admin MFA/PIN behavior unchanged.

**Why:** the user selected withdrawals and transfers as the PIN-gated operations, chose current-password plus verified-email-link recovery, and explicitly asked to preserve existing APIs and business flows.

**How to apply:** keep user PIN credentials separate from admin PIN credentials, verify them on the server for the selected browser flows, never persist or include the raw PIN in transaction fingerprints, and leave unrelated flows and external API authentication untouched.

PINs activated on the legacy Biz-transPay system before the Node/MySQL migration may not have a corresponding hash in the new store. Do not bypass the transfer PIN check or assume the old PIN can be verified; require fresh account authentication and enroll a PIN in the current system.

**Why:** the user confirmed their PIN was configured before migration, while the Node withdrawal route reports no PIN hash for the account.

**How to apply:** when a transfer returns `USER_PIN_SETUP_REQUIRED`, direct the user through password/MFA login and the existing PIN enrollment flow. They may choose the same six digits; only the new server-side hash is used for subsequent withdrawals and transfers.
