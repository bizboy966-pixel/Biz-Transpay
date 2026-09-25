---
name: AfribaPAY verification gates
description: Non-obvious safety constraints for testing and enabling AfribaPAY.
---

AfribaPAY's official documentation states that its sandbox can process real payments. Do not make automated payment requests to sandbox or live endpoints; verify behavior with mocked clients only. Keep live API and payout URLs unset until AfribaPAY confirms the production hosts.

The generic country-code list includes more destinations than the confirmed Mobile Money operator catalogue. Do not add a country based on the generic list alone; require documented operator and currency availability.

**Why:** Sandbox testing can move real funds, and generic country acceptance does not prove that a country has a supported Mobile Money route.

**How to apply:** Keep live activation gated on provider-confirmed hosts and route availability. Use unit tests with mocked HTTP for integration behavior.