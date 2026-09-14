# Threat Model

## Project Overview

Biz-transPay is a React/CRACO frontend with a FastAPI backend and MongoDB. It
supports merchant accounts, payment links, mobile-money and crypto flows,
wallet operations, payouts, currency exchange, KYC, administrator actions, and
provider webhooks.

## Assets

- **Accounts and sessions** — credentials, bearer tokens, HttpOnly sessions,
  MFA enrollment data, and recovery state.
- **Wallet balances and transaction records** — monetary balances, ledger
  entries, payment intents, payouts, refunds, and reconciliation state.
- **Merchant and customer data** — identities, contact details, KYC status,
  uploaded-document metadata, payment-link configuration, and notifications.
- **Provider credentials** — encrypted provider keys, webhook secrets, and
  server-side routing configuration.
- **Administrative controls** — roles, MFA state, balance actions, provider
  configuration, and audit-relevant changes.

## Trust Boundaries

- **Browser to API** — the browser is untrusted; protected requests require
  server-side authentication, authorization, CSRF, and origin checks.
- **API to MongoDB** — all filters and updates must be structured and scoped;
  user-provided search text is treated as bounded literal input.
- **API to payment providers** — provider selection and credentials remain
  server-side; callbacks must be authenticated, signed, idempotent, and
  reconciliable.
- **Customer to merchant** — public payment links expose only the capability
  needed to pay and never expose provider identity or private merchant data.
- **User to administrator** — administrator roles, MFA, permissions, recent
  step-up authentication, confirmation, and auditability are enforced by the
  backend.
- **Preview/development to production** — production callbacks, TLS, WAF,
  backups, deployment access, and disaster recovery are infrastructure
  responsibilities and must be configured on the published deployment.

## Scan Anchors

- Production entry point: `backend/server.py`
- Authentication and token handling: `backend/auth.py`
- Financial mutation barriers and reconciliation: `backend/server.py`
- Provider adapters and webhook handlers: `backend/paydunya.py`,
  `backend/fedapay.py`, `backend/izipay.py`, `backend/mbiyo.py`
- Frontend entry points and API clients: `frontend/src`
- Public, authenticated, and admin routes are declared in `backend/server.py`
- `backend/scripts` contains operational scripts and is not a public HTTP
  surface

## Threat Categories

### Spoofing

Sessions must be signed with a configured secret, expire when idle, rotate when
required, and be revocable remotely. Administrator MFA is TOTP-based and
server-enforced. Provider callbacks must be verified with provider-specific
signatures or secrets before any state transition.

### Tampering

Prices, fees, currencies, roles, provider routing, and wallet balances are
authoritative on the server. Idempotency claims, single-use-link reservations,
atomic wallet markers, and reconciliation prevent replay, TOCTOU races, and
double settlement.

### Repudiation

Sensitive actions must carry an authenticated actor or provider identity,
operation identifier, timestamp, and resulting status. Financial operations
must be deterministic and repairable after a process crash.

### Information Disclosure

API responses must be scoped to the authenticated owner and contain no provider
credentials or internal routing details. React output remains escaped; arbitrary
HTML is not rendered. Security-sensitive logs must not print credentials,
tokens, or personal data.

### Denial of Service

Authentication, public payment, webhook, search, and money-movement routes use
route-aware rate limits. External calls require bounded timeouts. Request,
upload, and search inputs must have explicit size and complexity limits.

### Elevation of Privilege

Every protected operation must enforce permissions on the backend, not only in
the frontend. Admin routes require effective roles and, where applicable,
recent step-up authentication and explicit confirmation. MongoDB lookups must
include the owning user or permitted administrative scope.

## Required Guarantees

- Invalid or replayed payment callbacks never credit a wallet.
- A retry never creates a second credit, debit, refund, payout, exchange, or
  settlement.
- A failed upstream request does not permanently consume a retryable idempotency
  key or a single-use link.
- A provider outage or reconciliation error does not silently become a
  successful financial state.
- Security controls reject unsafe requests while leaving valid customer,
  merchant, payment-link, payout, exchange, and administrative flows available.
- Published production deployments must provide the external callback reachability
  and infrastructure controls that local Preview cannot prove.