---
name: Public developer documentation
description: How to publish country coverage while keeping provider configuration and credentials private.
---

Public developer documentation should distinguish technical country/operator eligibility from routes currently activated in the serving environment. Publish only the integration fields a merchant needs: country, operator code and name, currency, public amount limits, and a broad customer-flow category.

**Why:** Static provider catalogues describe possible integrations, while credentials, enabled modes, and merchant configuration vary by environment. Conflating the two can advertise an unusable route or make a development preview appear to describe production.

**How to apply:** Keep route selection server-side; expose eligible and active catalogues separately; omit provider identities, configuration, fee splits, and secrets. State which environment supplies the live-availability list.