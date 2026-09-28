---
name: Nested JavaScript installs
description: Package installation behavior when a frontend app lives below the workspace root.
---

For this project, the Replit package installation flow wrote JavaScript dependencies to workspace-root `package.json` and `package-lock.json`, while the browser app is launched from `frontend/` and uses its own manifest and Yarn lockfile. The local CRA build resolved the root-installed package after it was also declared in the frontend manifest.

**Why:** A library can appear installed and work in the current workspace without the frontend's own dependency metadata being sufficient to reproduce that install elsewhere.

**How to apply:** Before adding a frontend runtime library, inspect the launch script and both package manifests, then verify the production build from the frontend directory and confirm the deployment install path includes the dependency.