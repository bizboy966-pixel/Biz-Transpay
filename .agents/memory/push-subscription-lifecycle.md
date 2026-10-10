---
name: Push subscription lifecycle
description: Keep a browser's push opt-in active across authentication sessions.
---

An opted-in browser must remain registered for push after application logout; logging in again must not prompt the user to activate push again.

**Why:** the user expects an activation to persist across logins, and push notifications may need to reach the device while the user is signed out.

**How to apply:** clear session-specific prompt dismissal on logout, but keep browser FCM registration intact; only a deliberate push opt-out should unregister the device.
