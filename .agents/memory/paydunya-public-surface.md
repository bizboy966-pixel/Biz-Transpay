---
name: Customer payment routing
description: Durable boundary between PayDunya administration and customer-facing payment flows
---

The customer-facing deposit surface must not receive or display provider mode names, provider configuration, test/live mode, or gateway/platform fee splits. The server selects the enabled route and returns only the generic action needed by the browser: phone confirmation, popup, or redirect.

**Why:** Administrators need to change the payment route without exposing implementation details or creating a separate customer-facing choice that can drift from the active configuration.

**How to apply:** Keep provider modes, credentials, and fee components in admin/server responses only. Sanitize public catalog responses to customer payment data and preserve a single server-selected start endpoint for future payment integrations.

Payment links follow the same boundary: their public page exposes the link's own logo, title, description, amount and payment choices, never the owner's name or username. The fee bearer is read from the stored link configuration; public requests cannot override it.

When multiple Mobile Money providers are enabled, provider selection must be capability-aware for the requested country, operator, currency, and payment flow. An enabled but unusable route must not shadow another ready provider.

**Why:** A fixed provider priority can hide Mobile Money or fail a transaction even though another enabled provider can serve the selected operator.

**How to apply:** Use the same readiness and flow checks for public catalog visibility and runtime dispatch. Keep arbitration and failure messages provider-neutral, and preserve existing idempotency barriers when adding fallback behavior.

Public payment links use the server-selected direct Mobile Money route and stay on the Biz-transPay page. A `UNIVERSAL` link must resolve the operator's actual catalog currency rather than filtering by the literal link currency. Provider checkout URLs remain internal reconciliation data and are never returned as browser redirect instructions on the public link surface.

**Why:** Public links need to behave like the authenticated direct deposit while keeping the final pending/success state inside the platform.

**How to apply:** Filter fixed-currency links to matching operators, allow universal links to resolve by the selected operator, and keep redirect-only provider details out of public responses.

Authenticated PayDunya SoftPay direct wallet deposits also keep their waiting and confirmation state inside Biz-transPay. Provider checkout URLs or timeout fallback markers for this flow are internal reconciliation data, not customer navigation actions. The browser follows the server-selected `payment_kind`, not the presence of a URL.

**Why:** The owner expects direct deposits to remain in the app through confirmation; an automatic hosted-checkout fallback sends the customer away and obscures the in-app pending state.

**How to apply:** For `softpay_direct`, return the generic phone action and reconcile the existing invoice server-side, including after an ambiguous timeout. Preserve separate PSR popup and explicitly selected PAR redirect behavior.

The sanitized public payment status must retain the payment method discriminator (`mobile_money` or `crypto`) so the browser chooses the matching tracker after creation.

**Why:** Omitting the discriminator makes a successful Mobile Money start fall through to the crypto tracker even though the provider request returned `200`.

**How to apply:** Treat `method` as required public UI routing metadata while continuing to omit provider credentials, mode names, and checkout URLs.