---
name: PayDunya callback hosting
description: Hosting requirements observed when PayDunya PUSH validates a disbursement callback.
---

PayDunya PUSH rejects temporary `.replit.dev` callback URLs as inaccessible, even when they answer publicly. Its callback accessibility check must receive a successful response for `GET`, `POST`, and `HEAD`.

**Why:** PayDunya returned business code `4002` (`the callback is not accessible`) for a working development URL; testing showed the production-domain requirement and a separate `HEAD` check.

**How to apply:** Build disbursement callbacks from the public production request host, never the development domain. Publish callback route changes before testing PUSH and keep all three HTTP methods reachable without authentication.