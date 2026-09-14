---
name: Edge protection boundary
description: Separation between Replit's upstream DDoS controls and application-level request hardening.
---

Published Replit apps are protected at the platform edge by WAF and load balancing. The app still applies defense-in-depth controls: route-aware rate limits, optional blocked IP/CIDR rules, request-size caps, security headers, login bot challenges, and sensitive-endpoint guards.

**Why:** Volumetric DDoS mitigation must happen before traffic reaches the application process; FastAPI middleware cannot absorb a network flood safely.

**How to apply:** Keep the origin behind the published Replit edge, avoid treating the development Preview as production DDoS protection, configure proxy-header trust explicitly before using forwarded IPs, and use a shared rate-limit store if multiple app processes are deployed.