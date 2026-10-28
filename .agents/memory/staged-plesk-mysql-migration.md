---
name: Staged Plesk/MySQL migration
description: Migration boundary and target hosting choices for moving Biz-transPay away from Replit
---

The user plans to use a domain purchased through Cyberincy, Plesk hosting, and MySQL as the destination. Their intended deployment flow is build locally, commit/push to GitHub, pull the repository in Plesk, then start the app. The current application uses PostgreSQL, so MySQL requires a backend database-adapter conversion and financial non-regression testing; it is not a direct database restore.

**Why:** The user explicitly requires a Preview-first migration and says production must remain untouched until the new environment works and is approved.

**How to apply:** Initially use only Preview/development data and a temporary hostname. Do not access, export, modify, publish, or redirect production, DNS apex, or payment-provider callbacks during this phase. Ensure the Plesk build/start setup matches the app's actual generated frontend directory and has its Preview database and secrets configured. Only plan a separate production migration after Preview is validated and the user authorizes it.
