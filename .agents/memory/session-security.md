---
name: Session security boundary
description: Browser session rules for Biz-transPay authentication.
---

Browser authentication uses a server-tracked, revocable session cookie rather than a client-readable token. Cookie-authenticated mutations also require a same-site CSRF cookie/header pair and an allowed Origin or Referer.

**Why:** HttpOnly cookies reduce token theft, while server-side session records support idle expiry, rotation, remote logout, and immediate compromise response. SameSite alone is defense in depth, not a replacement for server-validated CSRF tokens and request-origin checks.

**How to apply:** Keep secrets out of URLs and browser storage, rotate the session and CSRF token on refresh or reauthentication, require CSRF on every cookie-authenticated mutation, keep CORS origins explicit, and require step-up authentication before sensitive account or financial actions.

A status read dispatched with the old cookie can receive 401 during a successful session rotation. That race must not be confused with genuine expiration or remote revocation.

**Why:** Live logs showed a successful session refresh immediately followed by an unauthorized payment-status request and an unwanted login redirect.

**How to apply:** Coordinate browser refreshes and permit at most one retry of a read only when a successful intervening rotation is known. Never replay financial mutations, bypass expiry or revocation, or suppress an unauthorized retry.