---
name: PayDunya Moov Burkina confirmation
description: Moov Burkina pay-in requires a post-initiation USSD confirmation rather than an automatic push notification.
---

Moov Money Burkina via PayDunya SoftPay requires the payer to compose `*555*6#` after initiating the payment and confirm through the operator menu. Do not promise an automatic notification for this route.

**Why:** PayDunya's official SoftPay documentation explicitly returns “Veuillez compléter le paiement en composant le *555*6#.” The user reported waiting for a notification that never arrived when the app showed generic phone-notification instructions.

**How to apply:** Keep the direct deposit and payment-link instructions consistent with this action. Initiation is not settlement: retain verified provider status/callbacks before crediting funds. Test with mocked provider calls, never trigger a real payment to verify instructions.

Official reference: https://developers.paydunya.com/doc/EN/softpay#section-10

PayDunya can return HTTP 403 with “FAILED: Solde client insuffisant” for a payer-balance refusal. HTTP 403 alone is not proof of invalid platform credentials.

**Why:** Live initiation logs showed this business refusal while the customer saw an incorrect “service mal configuré” message.

**How to apply:** Recognize this precise payer-balance refusal before the generic credential-status mapping. Keep the deposit rejected and show a fixed, provider-neutral message; never bypass the refusal or confuse payer funds with provider liquidity.
