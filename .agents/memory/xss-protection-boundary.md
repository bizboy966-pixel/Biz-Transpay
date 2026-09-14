---
name: XSS protection boundary
description: Safe rendering, file validation, and CSP rules for user-controlled Biz-transPay content.
---

React renders user strings as text; arbitrary HTML is not used. User-controlled image/file values are validated server-side before persistence and again before legacy support attachments are returned. Only JPEG, PNG, WebP, and bounded PDF data URLs are accepted; SVG data URLs and scriptable URLs are rejected.

**Why:** Escaping prevents markup injection, but browser-active URLs, SVGs, uploads, and legacy stored records can still create scriptable content if they reach an unsafe context.

**How to apply:** Keep `dangerouslySetInnerHTML` absent, validate every new URL/file context server-side, keep CSP on both static HTML and API/edge responses, and use a hash/nonce for any unavoidable inline script instead of enabling broad inline script execution.