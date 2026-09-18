---
name: VM publish readiness
description: Why the Biz-transPay VM publication can remain in Repair during startup
---

The public VM health check targets the frontend port and expects `/` to return 200 quickly. Starting the CRA development compiler as the production process can return 500, timeout, or refuse connections while it compiles.

**Why:** A previous publication built successfully and created the VM but remained at “Waiting for deployment to be ready” because the frontend dev server was not ready for the readiness probe.

**How to apply:** Build the CRA frontend during the publication build phase and serve its static output from the FastAPI process on the public port. Keep the separate CRACO launcher only for the development workflow.