---
name: Backend test environment
description: Environment constraints that affect end-to-end backend test results.
---

Run backend HTTP integration tests against the active local workflow or an explicitly configured published endpoint. The default test URLs may point to an older external preview, and container-side requests to the Preview hostname can fail certificate verification. Shared application rate limits also make parallel or repeated authentication fixtures unreliable.

Backend unit-test modules import `server` as a top-level module; invoke them from the workspace root with `PYTHONPATH=backend python -m pytest ...` so collection resolves that import consistently.

**Why:** A test failure caused by the wrong host, TLS trust chain, stale data, or login throttling does not demonstrate a regression in the running application.

**How to apply:** Set the test base URL explicitly, use the backend module path for unit tests, run stateful suites serially when needed, reset or isolate test fixtures, and treat live provider tests as separate from deterministic unit/concurrency tests.