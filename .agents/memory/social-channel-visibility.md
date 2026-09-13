---
name: Social channel visibility
description: The rule for exposing administrator-configured social links in the authenticated user interface.
---

Administrator-configured social channels should be validated as HTTP(S) URLs and exposed to users only when both the channel is active and its URL is non-empty.

**Why:** The header is a public-facing surface, so inactive or incomplete admin settings must not leak into the interface, and client-side filtering alone would not provide a reliable boundary.

**How to apply:** Keep the canonical filtering and URL validation in the backend support configuration endpoint; let the frontend focus on rendering the already-filtered channels.