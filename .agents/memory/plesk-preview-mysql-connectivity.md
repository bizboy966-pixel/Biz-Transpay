---
name: Plesk MySQL Preview reachability
description: Network boundary when a Replit Preview process tries to use MySQL installed on the Plesk host.
---

Replit Preview cannot reach MySQL configured with the Plesk host's local-only `localhost` address. Until a non-production database endpoint is reachable from Preview, keep the UI available in diagnostic mode and keep database-backed actions blocked; do not substitute production data or credentials.

**Why:** A local hostname resolves inside the Replit runtime, not to the Plesk server. Repeated application restarts do not repair this network boundary.

**How to apply:** Validate the host/network path with a test database before backend flow testing. Keep Preview and production stores separate, and never expose database credentials in logs or chat.
