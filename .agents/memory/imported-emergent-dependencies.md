---
name: Imported Emergent dependencies
description: How to handle private dependencies in imported applications when setting up on Replit
---

Imported applications can include packages that only exist in the source platform's private registry. Replit's package firewall may install the public dependencies but cannot resolve those private package names.

**Why:** A private dependency can prevent every backend dependency from installing, even when the app only uses a small wrapper from that package.

**How to apply:** Identify the narrow interface the app uses, replace it with a local compatibility module backed by a public dependency already in the requirements, and remove only the unavailable private package from the install list. Keep the adapter's interface compatible with the existing call sites.