---
name: WAF boundary
description: Replit's built-in WAF and the application controls that complement it.
---

Replit Auto-Protect enables platform WAF protections by default for published apps, including common SQL injection, XSS, bot, scanner, and anomalous-request defenses. Replit does not currently expose custom WAF rule configuration.

**Why:** A local regex-based WAF would be weaker, easier to bypass, and unable to stop traffic before it reaches the app process.

**How to apply:** Treat the published Replit edge as the WAF layer. Keep FastAPI validation, authentication, rate limiting, body-size caps, security headers, IP block configuration, signed webhooks, and audit logging as defense in depth. Do not claim WAF protection is active on an unpublished Preview.