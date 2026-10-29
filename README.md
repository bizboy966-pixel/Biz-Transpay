# Biz-transPay

Biz-transPay keeps its React frontend and is being migrated to a Node.js API
with MySQL storage. The Node migration is not yet feature-complete. The API
intentionally starts in Preview mode only; do not connect it to production or
publish it until route parity, MySQL behavior, payment callbacks, and regression
checks have been validated.

## Replit Preview

The `Start application` workflow runs:

- React on port 5000;
- the Node API on port 8000;
- the API in diagnostic mode if no isolated Preview `MYSQL_DATABASE_URL` is
  configured.

Use an isolated Preview database only. Never put a production database URL in
the workspace's shared development environment.

## Node API

The API source is under `backend-node/`. `route-inventory.json` tracks routes
still to be migrated. The inventory command checks this file:

```bash
cd backend-node
npm test
npm run inventory
```

The Node server requires `BIZTRANSPAY_MIGRATION_ENV=preview` and, when using
MySQL, `MYSQL_DATABASE_URL` plus the required application secrets. Without
these, business routes remain disabled.

## Plesk/MySQL

Do not point the Plesk application at the live database or switch live provider
callbacks during this migration. First configure a separate Preview database,
test the Node app and all required flows, and compare users, balances, KYC,
transactions, and provider references. Production cutover requires a separate
approved migration and deployment.
