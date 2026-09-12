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
MongoDB attached to the workflow if no shared database connection is configured.