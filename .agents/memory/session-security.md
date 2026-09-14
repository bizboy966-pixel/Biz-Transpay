---
name: Session security boundary
description: Browser session rules for Biz-transPay authentication.
---

Browser authentication uses a server-tracked, revocable session cookie rather than a client-readable token.

**Why:** HttpOnly cookies reduce token theft, while server-side session records support idle expiry, rotation, remote logout, and immediate compromise response.

**How to apply:** Keep secrets out of URLs and browser storage, rotate on refresh or reauthentication, preserve active-device controls, and require step-up authentication before sensitive account or financial actions.