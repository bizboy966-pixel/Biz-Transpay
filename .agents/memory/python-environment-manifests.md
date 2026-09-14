---
name: Python environment manifests
description: Keeping imported Python projects aligned when installing temporary verification packages
---

When installing Python packages for verification, treat the existing backend requirements file as the source of truth. Package tooling may also rewrite pyproject.toml, uv.lock, and .replit, even when the application itself does not need those manifest changes.

**Why:** A temporary test dependency or a rebuilt virtual environment can leave the running workflow healthy until restart, then change dependency versions or remove backend imports. That creates a false sense of safety and can break the application on the next workflow restart.

**How to apply:** Install only the packages needed for the check, pin runtime packages to the existing requirements when restoring the environment, inspect git status, and restore unrelated manifest changes before the final workflow restart.