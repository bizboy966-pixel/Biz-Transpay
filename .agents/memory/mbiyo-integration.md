---
name: Mbiyo integration
description: Mbiyo is isolated from the legacy providers and uses provider-prefixed Mobile Money routes.
---

Mbiyo is configured independently from PayDunya, with encrypted public key, secret key and webhook secret, an editable country/operator catalogue, server-side status verification, HMAC-SHA256 webhook validation, and idempotent wallet settlement.

**Why:** The existing PayDunya flows have provider-specific callback and reconciliation rules; sharing their configuration or route identifiers would risk changing live payment behavior.

**How to apply:** Keep Mbiyo operator codes prefixed with `mbiyo_`, route Mbiyo through its own client, webhook, and reconciliation loop, and never let a PayDunya fallback handle a Mbiyo transaction.