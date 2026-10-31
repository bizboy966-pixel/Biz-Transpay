---
name: Customer payment routing
description: Provider-neutral payment surfaces may expose only documented, validated provider checkout redirects
---

The customer-facing deposit surface must not receive or display provider mode names, provider configuration, test/live mode, or gateway/platform fee splits. The server selects the enabled route and returns only the generic action needed by the browser: phone confirmation, popup, or redirect.

**Why:** Administrators need to change the payment route without exposing implementation details or creating a separate customer-facing choice that can drift from the active configuration.

**How to apply:** Keep provider modes, credentials, and fee components in admin/server responses only. Sanitize public catalog responses to customer payment data and preserve a single server-selected start endpoint for future payment integrations.

Payment links follow the same boundary: their public page exposes the link's own logo, title, description, amount and payment choices, never the owner's name or username. The fee bearer is read from the stored link configuration; public requests cannot override it.

Admins may enable all supported Mobile Money providers at once. Provider selection must be capability-aware for the requested country, operator, currency, and payment flow. An enabled but unusable route must not shadow another ready provider. PayDunya SoftPay direct is available only in Live mode; otherwise PSR or PAR redirect is usable only when exactly one is enabled.

**Why:** A fixed provider priority can hide Mobile Money or fail a transaction even though another enabled provider can serve the selected operator. PayDunya’s Sandbox SoftPay endpoint is a separate test-wallet flow that requires a password the app must not collect; it does not send an operator-specific T-Money request. Choosing arbitrarily between PSR and PAR would also make the payment flow unpredictable.

**How to apply:** Use the same mode-aware readiness checks for public catalog visibility and runtime dispatch. For supported Live SoftPay operators, create an invoice, call the documented operator-specific endpoint with its token, and mark the prompt sent only after provider success. Verify pending invoices server-side from status reads, callbacks, and returns; never retry an ambiguous submission with the same idempotency key. Return a popup for PSR and a redirect only for PAR.

Public payment pages stay provider-neutral, but may send a customer to a checkout URL when the provider's official documentation defines that route as a redirect. Expose only a provider-issued HTTPS URL validated against the documented host for that provider; never accept an arbitrary client URL. A redirect or browser return is not proof of payment; signed callback verification, server-side status lookup, and the idempotent finalizer remain the settlement gate. A `UNIVERSAL` link must resolve the operator's actual catalog currency rather than filtering by the literal link currency.

**Why:** Official PayDunya and AfriBaPay flows include operator-specific redirects (for example Wave and Djamo). Restricting redirects to one provider would break documented checkout steps; allowing arbitrary URLs would create an unsafe redirect boundary.

**How to apply:** Use provider-specific documented flow metadata to choose phone confirmation, OTP, USSD, or redirect. Validate HTTPS redirect hosts against the official provider contract, keep credentials and provider selection private, and settle only after server-side status or callback verification. Filter fixed-currency links to matching operators and allow universal links to resolve by the selected operator.

Authenticated PayDunya SoftPay direct wallet deposits keep their waiting and confirmation state inside Biz-transPay. The invoice-creation response alone is not proof that an operator prompt was sent. Provider checkout URLs or timeout fallback markers remain internal; the browser follows server-selected `payment_kind`, not the presence of a URL.

**Why:** The provider requires a second, operator-specific SoftPay call after invoice creation. Claiming a prompt was sent after only creating an invoice leaves customers waiting for a payment request that never reached their phone.

**How to apply:** For `softpay_direct`, store the invoice token before dispatch, invoke only a documented operator endpoint, and return the generic phone action only after its positive response. On ambiguous timeouts, keep the invoice pending, verify it server-side, and block duplicate submissions. Preserve separate PSR popup and explicitly selected PAR redirect behavior.

The sanitized public payment status must retain the payment method discriminator (`mobile_money` or `crypto`) so the browser chooses the matching tracker after creation.

**Why:** Omitting the discriminator makes a successful Mobile Money start fall through to the crypto tracker even though the provider request returned `200`.

**How to apply:** Treat `method` as required public UI routing metadata while continuing to omit provider credentials, mode names, and checkout URLs.