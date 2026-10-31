---
name: Plesk Resend configuration
description: Requirements for transactional email when Biz-transPay runs on Plesk rather than Replit.
---

Plesk runs outside Replit, so a Replit-managed Resend connector is not automatically available to the deployed Node process. Configure `RESEND_API_KEY` in the Plesk Node.js environment and use a sender address on a domain verified in Resend. Keep the API key out of the admin UI and frontend.

**Why:** Transactional email activation checks runtime Resend availability and sender formatting; the connector may work in Replit while Plesk has no provider credential.

**How to apply:** Add the variable in Plesk, restart the Node app, then verify the sender domain and send a real test message before enabling production notifications or withdrawal OTP.
