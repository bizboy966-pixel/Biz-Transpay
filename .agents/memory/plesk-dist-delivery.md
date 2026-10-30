---
name: Plesk dist delivery
description: The user's recurring source build, commit, and manual Plesk delivery workflow.
---

For changes intended for biz-transpay.com, rebuild the frontend `dist` and commit the relevant application source plus generated output locally. The user pushes to GitHub and restarts Plesk.

**Why:** The user repeatedly requested “Build commit dist” and said they push to GitHub directly.

**How to apply:** Build and commit deployment-bound changes, but do not push to GitHub or restart production unless separately asked.
