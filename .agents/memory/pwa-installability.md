---
name: Chromium PWA installability
description: Preserve the service-worker behavior required for Chromium's in-app installation prompt.
---

Chromium's in-app `beforeinstallprompt` requires an active, meaningful service-worker fetch handler; a valid manifest and icons alone may not be enough.

**Why:** Biz-transPay's published HTTPS site had a valid manifest and icons, but its root worker handled only push events. Chrome Android therefore did not surface the in-app installation prompt. A navigation handler with an offline fallback supplies the missing installability signal.

**How to apply:** Preserve the navigation fetch handler and offline fallback when changing the Firebase Messaging worker. Do not remove it or replace it with an empty handler. The browser install prompt is not supported by every browser; unsupported browsers still require their manual “Add to Home Screen” flow.