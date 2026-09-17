---
name: Python environment manifests
description: Keeping imported Python projects aligned when installing temporary verification packages
---

When installing Python packages for verification, treat the existing backend requirements file as the source of truth. Package tooling may also rewrite pyproject.toml, uv.lock, and .replit, even when the application itself does not need those manifest changes.

**Why:** A temporary test dependency or a rebuilt virtual environment can leave the running workflow healthy until restart, then change dependency versions or remove backend imports. That creates a false sense of safety and can break the application on the next workflow restart.

**How to apply:** Install only the packages needed for the check, pin runtime packages to the existing requirements when restoring the environment, inspect git status, and restore unrelated manifest changes before the final workflow restart.

For Replit publication, a dependency file nested under `backend/` is not necessarily installed automatically just because the run command imports it. Keep an explicit publication build step that installs `backend/requirements.txt` before starting the server.

**Why:** The development workspace may already contain packages in `.pythonlibs`, while a published VM image can start from an environment without `uvicorn` or other backend dependencies.

**How to apply:** When the deployment run command launches Python from `.pythonlibs`, verify the publication build installs the backend requirements before the healthcheck begins.