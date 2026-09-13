---
name: Customer payment routing
description: Durable boundary between PayDunya administration and customer-facing payment flows
---

The customer-facing deposit surface must not receive or display provider mode names, provider configuration, test/live mode, or gateway/platform fee splits. The server selects the enabled route and returns only the generic action needed by the browser: phone confirmation, popup, or redirect.

**Why:** Administrators need to change the payment route without exposing implementation details or creating a separate customer-facing choice that can drift from the active configuration.

**How to apply:** Keep provider modes, credentials, and fee components in admin/server responses only. Sanitize public catalog responses to customer payment data and preserve a single server-selected start endpoint for future payment integrations.