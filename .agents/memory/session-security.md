---
name: Session security boundary
description: Browser session rules for Biz-transPay authentication.
---

Browser authentication uses a server-tracked, revocable session cookie rather than a client-readable token. Cookie-authenticated mutations also require a same-site CSRF cookie/header pair and an allowed Origin or Referer.

**Why:** HttpOnly cookies reduce token theft, while server-side session records support idle expiry, rotation, remote logout, and immediate compromise response. SameSite alone is defense in depth, not a replacement for server-validated CSRF tokens and request-origin checks.

**How to apply:** Keep secrets out of URLs and browser storage, rotate the session and CSRF token on refresh or reauthentication, require CSRF on every cookie-authenticated mutation, keep CORS origins explicit, and require step-up authentication before sensitive account or financial actions.