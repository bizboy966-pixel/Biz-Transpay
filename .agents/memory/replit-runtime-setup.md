---
name: Replit runtime setup
description: Environment-specific setup constraints for this imported payment application.
---

The imported project depends on an internal payment package that is not available
from Replit's public package registry. Preserve the application's existing
interface with a small local compatibility layer rather than restructuring the
payment flows.

**Why:** The original pinned dependency prevents a clean dependency install in
the Replit environment even though the public Stripe SDK is available.

**How to apply:** When rebuilding or moving the runtime, check private package
availability first. Keep payment credentials in Replit Secrets and keep local
the configured Replit PostgreSQL database for persistent application state.

The imported CRA/CRACO setup uses Webpack Dev Server 5. Its proxy must be an
array configuration, and setting `HOST=0.0.0.0` can trigger schema failures in
this combination.

**Why:** The older CRA proxy shape and host setting caused the post-merge
workflow to fail even though the same application code compiled before the
workflow reconciliation.

**How to apply:** Keep the `/api` proxy in CRACO's final dev-server config as
an array and let the Replit preview workflow use the frontend's default host
binding.

The multi-process workflow launcher must remain the parent supervisor for both
FastAPI and CRACO; it must not replace itself with the frontend process while
the backend runs in the background.

**Why:** Replacing the launcher disabled its exit cleanup and left orphaned
FastAPI processes holding port 8000, causing later workflow restarts to fail
intermittently.

**How to apply:** Track both child PIDs, wait for either service to exit, and
terminate both children from signal and exit traps. Verify lifecycle changes
with two consecutive workflow restarts, not only a first successful start.