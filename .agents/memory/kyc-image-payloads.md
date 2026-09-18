---
name: KYC image payloads
description: Constraint for submitting multiple identity photos through the browser
---

KYC identity photos must be resized and compressed in the browser before being sent as base64 data in one JSON request.

**Why:** The allowed file size per photo does not account for base64 expansion or the combined request size. Several phone photos can be rejected by the proxy or API before the backend returns a useful validation message.

**How to apply:** Keep raster validation strict on the backend, but optimize accepted JPG/PNG/WebP uploads client-side and show a specific message when the combined payload is still too large.