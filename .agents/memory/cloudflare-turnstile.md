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

Replit environment-specific secrets can shadow shared values, and agent shell
commands can retain an older secret after the Secrets pane is updated. Validate
the restarted workflow separately from one-off shell processes.

**Why:** A shell validation continued reading a stale Turnstile secret while
the restarted application workflow successfully verified a real login token.

**How to apply:** Align stale environment-specific entries in the Secrets pane,
restart the workflow, and use the application's Siteverify result as the
runtime source of truth.

Turnstile browser cleanup must be exception-safe because the SDK can throw a
non-Error value when a solved widget is detached during navigation.

**Why:** Successful login navigation previously reached the backend but could
still trigger the frontend error page while the login widget unmounted.

**How to apply:** Never pass a React-owned host node directly to the SDK. Render
Turnstile into an imperative child inside a stable React wrapper, guard reset
calls, and defer widget removal until after React finishes its deletion commit.