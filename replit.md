# Biz-transPay on Replit

## Run the app

Use the configured **Start application** workflow. It starts the React
development server on port 5000 and the Node API on port 8000. The Node
migration is Preview-only and not feature-complete.

The frontend uses relative `/api` requests. `frontend/craco.config.js` proxies
those requests to the backend, so browser requests continue to work through
the Replit preview proxy without hardcoded localhost URLs.

Without an isolated Preview `MYSQL_DATABASE_URL`, the Node API runs diagnostics
only and keeps business routes disabled. Never use a production database URL
for this workflow.

## Run configuration

- Node serves the API on port `8000` in Preview mode.
- React/CRACO serves the frontend preview on port `5000`.
- The frontend proxy forwards `/api` requests to the backend.
- `backend-node/route-inventory.json` tracks routes that still need migration
  or end-to-end verification.
- Do not deploy or connect live provider callbacks until the full route
  inventory, MySQL behavior, and financial regression checks pass.

## Optional payment configuration

The app starts and its non-payment screens work without live provider
credentials. Set these environment variables before exercising the matching
payment flows, and keep their values in Replit Secrets rather than source files
or frontend environment variables:

- `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET` for Stripe deposits
- `IZIPAY_API_KEY`, `IZIPAY_WEBHOOK_SECRET`, and optionally `IZIPAY_BASE_URL`
  for crypto transfers and deposits
- `FEDAPAY_SECRET_KEY`, `FEDAPAY_PUBLIC_KEY`, and
  `FEDAPAY_WEBHOOK_SECRET` for FedaPay mobile-money flows

`JWT_SECRET` should also be set to a durable secret outside local development.
The Replit workflow uses the existing `SESSION_SECRET` automatically when it
is available and never exposes it to the frontend.

## Official visual rules

- The official local interface font is **Kripa Regular**, stored in the
  frontend assets. Do not reintroduce Google Fonts, Fontshare, or another
  external font service.
- The existing Biz-transPay color palette and brand identity must be preserved.
- The SoleasPay login page is only a visual and UX reference for hierarchy,
  composition, spacing, form structure, card treatment, and responsive behavior.
  Do not copy its colors, gradients, branding, or content.
- Future screens and features must reuse the existing visual system and shared
  components instead of introducing a new card, button, radius, spacing scale,
  or typography system.
- The Diokoma Action registration page
  (https://action.diokoma.sn/r/QIVVPPEZ) is the primary structural reference
  for card positioning, proportions, whitespace, field sizing, rounded forms,
  and page composition. Its branding, colors, imagery, and content must not be
  copied.