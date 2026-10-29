# Biz-transPay Node.js / MySQL Preview migration

## Safety status

This is an isolated migration workspace. It is **not a replacement backend**:

- all route inventory entries remain `pending`;
- the Node server serves only `/healthz`;
- all other routes return `503 MIGRATION_INCOMPLETE`;
- startup refuses to run unless `BIZTRANSPAY_MIGRATION_ENV=preview`;
- the code never reads Replit production data, performs provider calls, or runs on the current Replit workflow.

Do not connect a production database, route the live domain here, or enable payment
callbacks. The user explicitly requested Preview-only work until they approve a
separate production migration.

## Current porting foundation

- `src/security.cjs` contains cross-language bcrypt, PIN pepper, TOTP, JWT and
  Fernet primitives. Tests compare them with the existing Python implementation
  using synthetic test values, including decrypting Python Fernet data and having
  Python decrypt a Node-created Fernet token. Password rules, session/MFA token
  claims, and explicit integration-encryption keys are also covered by fixtures.
- `src/session-service.cjs` ports the browser-session rules as an isolated service:
  idle/absolute expiry, three active sessions, rotation, logout, step-up age,
  CSRF/session cookies, and the required user-PIN gate.
- `src/wallet.cjs` reproduces the existing Python idempotency identifiers and
  signatures and implements an atomic wallet-operation state machine against a
  transactional repository interface.
- `src/mysql-store.cjs` and `src/document-store.cjs` use the split-table ZIP layout:
  one allowlisted table per collection, `doc_id`, and the full JSON in
  `raw_document`. Writes also refresh the matching `field_*` columns.
- `sql/preview-schema.sql` creates only the InnoDB lock-support table. Import the
  split-table ZIP separately to create the collection tables and captured records.
- The ZIP is a best-effort, non-atomic production capture, not a guaranteed
  complete or lossless migration snapshot. Its own verification report lists
  collection mismatches; do not treat it as a validated production replacement.
- `route-inventory.json` lists the Python routes. A `pending` entry is not
  implemented or tested in Node.js.

These modules are not yet connected to login, user, payment, API or admin routes.
The split-table store tests use a SQL mock; they are not a substitute for
integration tests against the exact MariaDB version and imported Preview schema.
No Node route has been marked verified.

## Tests and route inventory

```sh
npm test
npm run inventory
npm run check:parity
```

The parity command intentionally fails until every route is implemented and
verified; additional end-to-end financial checks are required afterwards.

## Preview-only setup rules

- The source database is the **Replit development/Preview** database only.
- Target MySQL credentials belong in Plesk's private environment configuration;
  never commit them or paste them into chat.
- `DATABASE_URL` for the existing Python application is PostgreSQL. A MySQL URL
  cannot be substituted until the MySQL adapter and all collection semantics are
  completed and validated.
- Keep the existing React application unchanged. Its current build output is
  `frontend/build`; it is not a Node API server.
- Production database, live DNS, and provider callback settings remain untouched
  until Preview is validated and the user explicitly authorizes that phase.
