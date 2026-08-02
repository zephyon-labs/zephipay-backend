# Payment persistence foundation

Sprint 1A establishes storage contracts and does not connect them to payment
execution. `POST /api/send`, Runtime orchestration, Solana submission, and the
existing receipt registry retain their previous behavior. PostgreSQL is opt-in
through `POSTGRES_ENABLED=false` and no persistence adapter is constructed at
module import time.

## Ownership and safety

Idempotency belongs in the backend because only the backend can serialize an
authenticated actor's request with signer access and durable lifecycle state.
A browser retry, process restart, or lost HTTP response must not create a new
economic action. The governing invariant is:

> If ZephiPay cannot prove the first payment failed, it must not execute it again.

`UNKNOWN` represents a payment whose successful or failed settlement cannot yet
be proved. Time alone never converts `UNKNOWN` to `FAILED`, and `UNKNOWN` cannot
transition back to `PROCESSING`.

PostgreSQL is operational truth for idempotency ownership, lifecycle state,
events, and the durable receipt projection. Solana remains settlement truth. A
future sprint must verify Solana evidence before calling the atomic receipt and
completion operation.

Receipts are append-only because changing settlement evidence after verification
would invalidate the payment record. Payment events are append-only because they
form the audit stream from which future Runtime, settlement, receipt, and
operational telemetry can be aggregated. Database triggers reject updates and
deletes on both tables.

## Repository layout

- `migrations/` contains ordered, immutable SQL migrations.
- `src/payments/` owns lifecycle types, transition validation, and canonical
  request hashing.
- `src/receipts/` owns the verified payment receipt model.
- `src/allowlist/` owns persisted beta allowlist records, but no middleware.
- `src/storage/` owns named repository contracts and explicit PostgreSQL and
  deterministic test adapters.
- `src/telemetry/` owns a persistence hook for canonical payment events. It does
  not aggregate or expose metrics.

## Migrations

Set a server-only `DATABASE_URL`, then run:

```sh
npm run migrate:validate
npm run migrate
```

For a disposable local database, apply the migration twice and run the focused
integration suite:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/zephipay_test npm run migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/zephipay_test npm run migrate
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/zephipay_test npm run test:postgres
```

These commands must target a disposable local database, never Railway or a
shared environment.

The runner applies each ordered `NNN_name.sql` file and its SHA-256 checksum in
one explicit transaction, recorded in `payment_schema_migrations`. Applied migrations must never be
edited. Add a new ordered migration instead.

`DATABASE_URL` is required by application configuration only when
`POSTGRES_ENABLED=true`. Sprint 1A leaves that flag false and does not provision
or connect Railway PostgreSQL.

## Intentionally not connected in Sprint 1A

- Express routes and `/api/send`
- Runtime execution or lifecycle callbacks
- Solana submission, confirmation, or reconciliation
- authentication, sessions, and allowlist enforcement
- background workers
- receipt or telemetry APIs
- production adapter selection
- payment enablement

Sprint 1B should connect authenticated intent creation and explicit confirmation
to these contracts while payment execution remains fail-closed until the later
authoritative-settlement sprint is complete.
