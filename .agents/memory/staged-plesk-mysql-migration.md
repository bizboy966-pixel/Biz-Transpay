---
name: Staged Plesk/MySQL migration
description: Migration boundary and target hosting choices for moving Biz-transPay away from Replit
---

The user plans to use a domain purchased through Cyberincy, Plesk hosting, and MySQL as the destination. Their intended deployment flow is build locally, commit/push to GitHub, pull the repository in Plesk, then start the app. The current application uses PostgreSQL, so MySQL requires a backend database-adapter conversion and financial non-regression testing; it is not a direct database restore.

For the Node.js port, use the user's split-table ZIP layout as the MySQL target: one allowlisted table per collection, with `doc_id`, full JSON in `raw_document`, and synchronized `field_*` columns. Do not revert the adapter to a single `document_store` table. The ZIP itself is a best-effort capture, not a verified complete migration snapshot.

**Why:** The user explicitly requires a Preview-first migration and says production must remain untouched until the new environment works and is approved. They also directed that Node.js routes be implemented before Python is removed.

**How to apply:** Keep the Node adapter and tests aligned with the split-table schema. Do not restore the Python runtime; use the legacy API only as a behavior reference and port those features into the current Node/Plesk/MySQL architecture. Initially use only Preview/development data and a temporary hostname. Do not access, export, modify, publish, or redirect production, DNS apex, or payment-provider callbacks during this phase. Ensure the Plesk build/start setup matches the app's actual generated frontend directory and has its Preview database and secrets configured. Only plan a separate production migration after Preview is validated and the user authorizes it.

The user states that the legacy API works fully and wants its complete behavior ported into the current Node.js API for Plesk/MySQL; they do not want the Python runtime restored.

**Why:** The user clarified that the goal is full behavioral parity in the existing deployment architecture, not switching the live app back to Python.

**How to apply:** Treat the legacy API as the compatibility specification, keep implementation in Node.js, and do not claim completion until route parity and isolated Plesk/MySQL regressions pass.

The user chose to test the Node app on Plesk. `localhost` in `MYSQL_DATABASE_URL` is local to the machine running Node: from Replit Preview it does not reach Plesk and produces `ECONNREFUSED`; on the Plesk host it can reach that host's MySQL service.

**Why:** Replit Preview and Plesk are separate machines, and opening production MySQL to Replit would violate the user's Preview-first boundary.

**How to apply:** Test on a temporary Plesk hostname with a dedicated Preview database and Plesk-local MySQL connection. Keep Replit Preview diagnostic-only if it cannot reach that database; never point either environment at production as a workaround.

Plesk installs can also fail when a Replit-generated npm lockfile embeds `package-firewall.replit.internal/npm/`; replacing only the hostname creates invalid public registry paths such as `/npm/yargs-parser`.

**Why:** The lockfile can preserve both Replit's internal host and its `/npm/` path prefix, even when npm is run outside Replit.

**How to apply:** Normalize the lockfile tarball URLs to `https://registry.npmjs.org/<package>/-/<tarball>`, configure npm to use the public registry, and preserve direct vendor tarball hosts. Keep the Preview clone and app root separate from the production domain's document root.

Plesk's Node.js build step runs `npm run build` from the application root. The root manifest must expose that command and delegate it to the frontend build. When strict npm resolution rejects the already-working dependency set, preserve the locked versions and use `legacy-peer-deps` rather than upgrading packages without compatibility checks.

**Why:** Plesk fails before startup if the root build script is absent; strict peer checks can also reject the existing React dependency graph even though its production frontend build succeeds.

**How to apply:** Verify the exact root `npm run build` command in Replit and on the Plesk host, and confirm the generated frontend directory matches what the Node server serves.

Plesk's static-output detection expects a root-level `dist/index.html`; a successful build into a custom `generated-artifacts` path may still be reported as missing.

**Why:** Plesk scans conventional static output paths when applying hosting settings and does not infer a custom CRA `BUILD_PATH`.

**How to apply:** Build to root `dist/`, point both the Node server's static root and Plesk's document root there, and keep the generated directory excluded from Git.
