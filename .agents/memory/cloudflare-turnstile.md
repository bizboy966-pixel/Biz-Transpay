---
name: Cloudflare Turnstile hostnames
description: Domain configuration required for the project's Cloudflare anti-bot widget
---

Cloudflare Turnstile site keys are hostname-bound. A real key must list every
hostname where the Biz-transPay interface is served, including the Replit
Preview hostname when Preview testing is required. Otherwise the widget loads
but returns client error `110200` (domain not authorized).

**Why:** A valid secret and site key do not prove that the current browser
origin is authorized. Treating the issue as a code or CSP failure can leave
the server protected while the normal login and payment UI is unusable.

**How to apply:** Keep the server-side verification and fail-closed behavior.
Add the actual Preview and production hostnames in Cloudflare Turnstile
Hostname Management. Use Cloudflare's documented test keys for local
`localhost`/`127.0.0.1` testing rather than weakening production hostname
validation.

Replit environment-specific secrets can shadow the shared secret. When a
Turnstile secret validates against Cloudflare but the running app rejects it,
check and align the `development` override used by Preview before changing
backend code.

**Why:** This project had the correct widget secret available through Cloudflare
while the runtime still read a different value from an environment-specific
secret entry.

**How to apply:** For Preview, replace or remove stale `development` and
`production` overrides in the Secrets pane, keeping the exact widget secret in
the environment the workflow uses.