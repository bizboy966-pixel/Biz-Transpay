---
name: AfribaPAY verification gates
description: Non-obvious safety constraints for testing and enabling AfribaPAY.
---

AfribaPAY's official documentation states that its sandbox can process real payments. Do not make automated payment requests to sandbox or live endpoints; verify behavior with mocked clients only. Keep live API and payout URLs unset until AfribaPAY confirms the production hosts.

The generic country-code list includes more destinations than the confirmed Mobile Money operator catalogue. Do not add a country based on the generic list alone; require documented operator and currency availability.

The published API schema identifies API User (Basic Auth username), API Key (Basic Auth password), and `merchant_key`, but does not define an Agent ID request field. The user confirmed Agent ID is admin-only metadata: keep it encrypted and never decrypt it into or send it through the API client.

AfribaPAY's pay-in response uses `amount` for the net amount after provider fees; reconcile the requested gross amount against `original_amount` or `amount_total`. Webhook POSTs use an `AFRIBAPAY_SIGN` HMAC-SHA256 hex signature over the exact raw body, keyed with the API Key. Treat the callback as a signal and confirm final status with the provider status API before settlement.

An accepted pay-in response is usually only `PENDING`; it is not payment confirmation. Use the verified HTTPS webhook as the primary signal and a rate-limited, backoff status check for delayed or missing callbacks. The status API accepts exactly one identifier (`order_id` or `transaction_id`); prefer the saved provider transaction ID when available, and reuse the bearer token until its documented expiry. Keep every path on the same idempotent wallet settlement operation.

**Why:** Sandbox testing can move real funds, generic country acceptance does not prove that a country has a supported Mobile Money route, and net-vs-gross amount confusion can quarantine legitimate confirmed deposits.

**How to apply:** Keep live activation gated on provider-confirmed hosts and route availability. Use mocked HTTP for integration tests; verify callback signatures and reconcile order ID, gross amount, currency, and final provider status before crediting. Assert that Agent ID is absent from outbound requests.