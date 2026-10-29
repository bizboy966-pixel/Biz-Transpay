# Biz-transPay Preview on Plesk

This setup is for a temporary Preview hostname and an isolated MySQL database.
Do not point it at the main domain, the production database, or live payment
callbacks.

## Plesk Node.js settings

- Application Root: the repository root (for example, `/httpdocs`)
- Application Startup File: `app.js`
- Package Manager: `npm`
- Node.js: version 20 or newer
- Document Root: `generated-artifacts/frontend-build` under the application root
- Application Mode: `production` is compatible; the separate migration-mode
  variable below must remain `preview`

## Environment variables in Plesk

Add these in the Plesk Node.js environment settings. Do not put them in Git:

- `BIZTRANSPAY_MIGRATION_ENV=preview`
- `MYSQL_DATABASE_URL=mysql://USER:PASSWORD@localhost:3306/PREVIEW_DATABASE`
- `SESSION_SECRET=<a long random secret>`

`JWT_SECRET` may be set separately; otherwise the Node app uses
`SESSION_SECRET`. The MySQL database must be dedicated to Preview. In Plesk,
`localhost` refers to the Plesk server; it does not work from Replit Preview.

## Build and start

From the repository root in Plesk, run:

```sh
npm install
npm run build:frontend
```

Then click **Restart App** in Plesk. The build is written to
`generated-artifacts/frontend-build`; that directory is generated locally on
Plesk and excluded from Git.

The current Node startup checks that the split-table data schema already exists.
`backend-node/sql/preview-schema.sql` creates only `migration_locks`; it does
not create the application data tables. If schema validation fails, stop here
and install the correct split-table schema into the isolated Preview database.
Do not redirect production traffic or provider callbacks to this app.

## Current migration limit

The Node API is still incomplete. Routes not yet ported intentionally return
`MIGRATION_INCOMPLETE`; therefore this is a Preview shell and must not be used
for live payments or real customer accounts.
