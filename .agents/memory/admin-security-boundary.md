---
name: Admin security boundary
description: Additional protections applied to the Biz-transPay administrative panel and high-impact staff actions.
---

The admin panel is a critical zone: admin sessions require MFA, high-impact actions require recent password-plus-MFA authentication and an explicit confirmation phrase, and every admin endpoint request is written to the audit log, including denied attempts.

**Why:** A valid administrator session alone is not enough protection for balance changes, transaction decisions, account administration, or platform reset operations.

**How to apply:** Keep the server authoritative. Use the optional `ADMIN_ALLOWED_IPS` allowlist with `ADMIN_TRUST_PROXY_HEADERS=true` only when the deployment proxy is trusted; otherwise use the direct client address. Preserve the 24-hour absolute session limit, 30-minute idle expiry, 15-minute step-up window, MFA login requirement, brute-force controls, unusual-login alerts, and explicit confirmation for destructive or financial actions.