---
name: PayDunya callback reconciliation
description: Official IPN encoding, browser-independent verification, and responsiveness requirements for browser and integration API deposits.
---

PayDunya's official IPN is an application/x-www-form-urlencoded `data` envelope. Framework form readers retain PHP bracketed field names; the hash is inside data and the invoice identifier is inside invoice, not necessarily at the root. JSON callbacks must also be read explicitly, since a form reader can return an empty mapping without raising.

**Why:** Production callbacks were returning 400 and valid payments depended on delayed fallback verification. The official HTTP/JSON documentation specifies the nested IPN structure.

**How to apply:** Decode the envelope and identify the exact invoice before validating the static hash. Still confirm status, token, amount, currency, and identity server-to-server before any wallet credit; an incoming callback is never sufficient settlement evidence.

Browser polling, callbacks, background checks, and integration API reads must share verification for the same deposit. Disconnecting or timing out a status read must not cancel settlement. Status reads may return the actual pending state while verification continues; do not convert an incomplete lookup into successful payment.

**Why:** Duplicate slow confirmations blocked status reads, and confirmation must finish even if the user closes the browser or changes sessions.

**How to apply:** Bound concurrency and status-read wait time, preserve durable records and existing exactly-once credit gates, and keep the integration API on the same owner-scoped deposit service rather than adding a separate verifier.
