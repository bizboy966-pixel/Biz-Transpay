# Biz-transPay on Plesk

The startup supports an explicit `preview` or `production` data environment.
The user has confirmed `https://biz-transpay.com` as the Production target.
Plesk actions still need to be performed in its control panel; this repository
does not connect to Plesk or change its database.

## Plesk Node.js settings

- Application Root: repository root (the supplied Plesk setting is `/httpdocs`)
- Application Startup File: `app.js`
- Package Manager: `npm`
- Node.js: version 20 or newer
- Document Root: `dist` under the application root
- Application Mode: `production`

## Environment variables in Plesk

Add these in the Plesk Node.js environment settings. Do not put them in Git:

- `BIZTRANSPAY_MIGRATION_ENV=production`
- `MYSQL_DATABASE_URL=mysql://USER:PASSWORD@localhost:3306/PRODUCTION_DATABASE`
- `SESSION_SECRET=<a long random secret>`

`JWT_SECRET` may be set separately; otherwise the Node app uses
`SESSION_SECRET`. In Plesk, `localhost` refers to the Plesk server; it does not
work from Replit Preview. Confirm the database and take a backup before
restarting the app on the main domain.

## Build and start

From the repository root in Plesk, run:

```sh
npm install
npm run build
```

Then click **Restart App** in Plesk. The build is written to `dist/` at the
application root. Plesk can detect `dist/index.html` after the build; the
directory is generated locally on Plesk and excluded from Git.

The root and frontend `.npmrc` files select the public npm registry. The npm
lockfiles use canonical `registry.npmjs.org` tarball URLs (without Replit's
`/npm/` path prefix); direct tarball URLs from other providers remain intact.

The Node startup checks that the split-table data schema already exists.
`backend-node/sql/preview-schema.sql` creates only `migration_locks`; it does
not create the application data tables. If MySQL configuration, connectivity,
or schema validation fails, Node now stays in diagnostic-only mode: `/healthz`
returns a sanitized status and business API requests return HTTP 503. The
Turnstile public-config endpoint remains available because it does not require
database access. Do not import a schema or dump into the live database without
checking its contents and taking a backup first.

The currently generated split-table export does not include every collection
required by all Node routes. Missing collections must be reconciled against a
verified database backup before enabling the affected features.

## Current migration limit

The Node API is still incomplete: 98 routes are not ported and 103 are ported
but unverified. Those routes intentionally return `MIGRATION_INCOMPLETE`, so
starting this build on the main domain will not provide full Biz-transPay
functionality; payment and account flows may be unavailable.
