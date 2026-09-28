---
name: FCM delivery error handling
description: Safely diagnose partial Firebase Web Push delivery and retire stale registrations.
---

Classify FCM errors per registration token and retain only sanitized provider error codes. Distinguish sender-ID mismatch, unregistered or malformed tokens from service-account and platform-provider failures. Delete a token only when the response establishes that it is permanently invalid; never log the token or raw provider response.

**Why:** A partial campaign can mean one device failed while others succeeded. Treating every 401/403 as a service-account failure hides token-specific problems, while raw FCM responses can include sensitive request details.

**How to apply:** In FCM sender and batch-delivery changes, inspect structured provider error codes before generic HTTP status, aggregate safe counts, and keep transient or platform-credential failures distinguishable from permanent token failures.