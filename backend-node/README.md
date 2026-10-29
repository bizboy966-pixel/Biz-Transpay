# Node.js API migration

The Node backend is an incomplete Preview migration, not a production
replacement. It starts only with `BIZTRANSPAY_MIGRATION_ENV=preview`. Without
an isolated Preview `MYSQL_DATABASE_URL`, it serves diagnostics only; business
routes stay disabled.

## Implemented foundation

- `src/security.cjs` preserves compatibility with existing bcrypt hashes,
  PIN peppering, TOTP, JWT claims, and Fernet-encrypted values using synthetic
  frozen compatibility vectors.
- `src/session-service.cjs` implements browser-session rules as an isolated
  service, including expiry, rotation, logout, step-up age, CSRF cookies, and
  the user-PIN gate.
- `src/wallet.cjs` preserves financial idempotency signatures and provides an
  atomic wallet-operation state machine against a transactional repository.
- `src/mysql-store.cjs` and `src/document-store.cjs` implement the collection
  adapter and field projections used by the migration.
- `route-inventory.json` tracks the legacy API routes and their Node status.
  `pending` routes are not implemented; `implemented_unverified` routes still
  need parity and runtime validation; only `verified` means end-to-end tested.

These foundations do not establish full API, payment, admin, notification, or
Telegram parity. Use only an isolated Preview database. Do not connect the
production database, change live DNS, or redirect provider callbacks until the
entire route inventory, MySQL behavior, and financial regressions are verified
and production cutover is separately approved.

## Checks

```sh
npm test
npm run inventory
npm run check:parity
```

The parity check must pass before any production cutover.
