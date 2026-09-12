# Biz-transPay on Replit

## Run the app

Use the configured **Start application** workflow. It starts a local MongoDB
instance, the FastAPI backend on port 8000, and the React development server
on port 5000. Replit Preview serves the React app on port 5000.

The frontend uses relative `/api` requests. `frontend/craco.config.js` proxies
those requests to the backend, so browser requests continue to work through
the Replit preview proxy without hardcoded localhost URLs.

The local development database is configured with:

- `MONGO_URL=mongodb://127.0.0.1:27017`
- `DB_NAME=biz_transpay`

For a shared or production database, replace those values with an external
MongoDB connection string and database name in Replit environment variables.
No MongoDB Replit integration is currently available for this workspace.

## Run configuration

The `Start application` workflow starts the existing stack without restructuring
the project:

- MongoDB uses the local `.data/mongodb` directory on port `27017`.
- FastAPI serves the backend on port `8000`.
- React/CRACO serves the frontend preview on port `5000`.
- The frontend proxy forwards `/api` requests to the backend.

The local development database is intended for Replit Preview and development.
For a shared or persistent environment, configure an external MongoDB connection
and set `MONGO_URL` and `DB_NAME` in Replit environment settings.

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