# Native session PostgreSQL adapter — controlled local candidate

**Source preparation only. Database execution gate: BLOCKED.**

Prepared on 2026-11-06 from accepted core commit
`3aea9efb332693f68fa468194d5884319eacfffa`, on local branch
`feat/native-session-postgres-local-v1`, in the separate worktree
`/home/zeranova/dev/zephyon-labs/zephipay-backend-native-session-postgres-v1`.
Canonical main remains `a7f7270cc074359cbbdb32a06d665b2933b8a22c`.

This follows the handoff's explicit fallback when a safe local PostgreSQL fixture
is unavailable. No PostgreSQL connection was opened, database created, schema
applied or database test executed. SQL transcript doubles are not database evidence.
The new adapter is not accepted for integration or production use.

## Environment and database safety

Initial 2026-11-06 WSL-only tooling inspection found PostgreSQL 16 client utilities under
`/usr/lib/postgresql/16/bin`, including `psql`, but no `postgres`, `initdb` or
`pg_ctl` server binaries. No local PostgreSQL listener was identified. The Windows
Docker wrapper reported Docker unavailable in this WSL distribution and requested
Docker Desktop WSL integration. No package installation, Docker integration change,
service start or persistent system configuration change was attempted.

Subsequent Windows inventory confirmed that Docker Desktop and its Windows CLI
are installed, but the engine and Docker WSL distribution are stopped. Existing
Docker storage has a separately authorized, hash-verified cold backup. That
historical infrastructure supported Backend database testing; no Mobile Docker use
is established. Neither the inventory nor backup authorizes startup or designates
any historical database disposable. This correction performs source validation only;
WSL configuration, Docker state and all existing databases remain untouched.

**No database has been designated or used.** The unique name in unit fixtures is a
synthetic parser example, not an existing database. Existing environment variables
and application credentials were neither printed nor used to infer database safety.
Railway and other hosted services were not accessed; production holds are untouched.

The prepared test gate requires all of:

- Explicit `NATIVE_SESSION_TEST_CONFIRM=DISPOSABLE_LOCAL_NATIVE_SESSION_V1`.
- A designated name matching `zephipay_native_session_test_<16 lowercase hex digits>`.
- An explicit `NATIVE_SESSION_TEST_PORT` between 1024 and 65535.
- Literal `127.0.0.1`, no TLS, fixture-only login `native_session_fixture` and the
  synthetic password `native-session-disposable-only`; no URL or `PG*` fallback.
- Read-back of the exact database, user, loopback server address, port, PostgreSQL
  16 version and non-recovery status.
- A database comment equal to
  `ZEPHIPAY_NATIVE_SESSION_DISPOSABLE_V1:<exact database name>`, set by the local
  fixture owner as an explicit disposable designation.
- An empty non-system namespace before the preparation script applies anything.

The future operator must also establish the actual local server/container and its
data directory, and exclude SSH/proxy forwarding to a remote system. Loopback and
a naming convention alone do not prove physical locality. These setup facts have
not been established here. The helper creates neither a database nor a login; it
rejects existing populated application databases instead of resetting them.

## Changed-file inventory

| File                                               | Purpose                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/nativeSession/postgresPersistence.ts`         | Unmounted adapter, row snapshots, locking, canonical helper composition and transaction lease |
| `sql/candidates/native-session-postgres-v1.sql`    | Isolated candidate schema; outside normal migration discovery                                 |
| `scripts/prepare-native-session-postgres-local.ts` | Explicit opt-in, empty disposable fixture preparation only                                    |
| `tests/helpers/nativePostgresSafety.ts`            | Dedicated connection designation and read-only identity checks                                |
| `tests/helpers/nativePostgresRecoveryWorker.ts`    | Synthetic fresh-process recovery probe; test-only                                             |
| `tests/nativeSessionPostgresAdapter.test.ts`       | SQL transcript and safety-gate unit tests                                                     |
| `tests/postgresNativeSession.integration.ts`       | Guarded actual-PostgreSQL tests, prepared but unexecuted                                      |
| `tests/nativeSessionPolicy.test.ts`                | Narrow import allowlist extension for the new unmounted adapter                               |
| This document                                      | Evidence, safety boundary and remaining gates                                                 |

The accepted domain core, value/record parsers, policy implementation and contracts
remain byte-for-byte unchanged. Existing canonical persistence helpers, migrations
001–033, HTTP composition, middleware, dependencies and configuration are unchanged.
Installed dependencies are reused through ignored local links; nothing was installed
or modified in Web, Mobile or Protocol.

## Adapter behavior

The adapter receives an explicitly supplied pool. Importing or constructing it
does not read connection environment variables or open a database connection.
There is no application composition, public endpoint, attempt-creation API or
production authentication adapter. `productionReady=false` is descriptive; absence
of production importers is the operative isolation boundary.

Each transaction leases one client, starts READ COMMITTED, fixes its local search
path, and applies local statement/lock/idle timeouts. It locks the binding row with
`FOR UPDATE` before giving the callback a transaction interface. Existing identity
resolution is read-only against the immutable issuer/subject mapping. Canonical
account rows are locked with `FOR UPDATE` before canonical session rows. Neither
shared locks nor lock upgrades are used by the adapter. Operations are sequential
within a leased connection; there is no global mutex across connections.

This design uses the documented PostgreSQL [row-lock behavior](https://www.postgresql.org/docs/16/explicit-locking.html)
and [READ COMMITTED semantics](https://www.postgresql.org/docs/16/transaction-iso.html).
All statements for an individual transaction stay on the same client, as required
by [node-postgres](https://node-postgres.com/features/transactions). Those references
support the design; they do not replace local execution evidence.

Creation/revocation call the existing `createAccountSessionInTransaction` and
`revokeAccountSessionInTransaction` functions. Their repeated account lock is on
the same already-exclusively-held row, not a shared-to-exclusive upgrade. The
existing account-version increment and security-event behavior is reused. The
adapter requires the corresponding final binding transition before committing a
canonical mutation. No economic session, consent, Runtime approval or payment
capability is created.

Rows are selected into explicit aliases, snapshotted through own data descriptors,
and checked against the requested identity. Proxies/accessors and malformed database
integers fail closed. Integer strings are bounded to PostgreSQL's positive bigint
range; timestamps must also fit the accepted core's safe millisecond representation.
Native timestamps are written at exact millisecond precision. Reads round canonical
creation/revocation/update times up and expiry down, conservatively, when existing
rows have sub-millisecond precision; this can cause transient unavailable authority
within a millisecond, rather than backdating an account update or extending expiry.

The sole normal clock source is `clock_timestamp()` sampled after the relevant
locks. The accepted core retains committed observations on denial paths. Binding
writes additionally require the last observation from the transaction, and use the
locked state/watermark as update predicates. No host clock or caller-supplied clock
override is exposed by the adapter.

Callback results are returned only after COMMIT acknowledges. Any query, rollback,
commit or acknowledgement uncertainty denies authority and discards the client;
there is no automatic transaction replay. Caught operation failures still poison
the transaction. Escaped transaction methods, concurrent method calls on one
client and unawaited work cannot be used to continue after the lease ends. Separate
connections remain free to contend through PostgreSQL rather than an in-memory lock.

## Candidate schema inventory

The candidate adds only `native_session_candidate`:

- One `bindings` table containing distinct unique login-attempt, binding and
  canonical-session identifiers, context, proof commitments, millisecond deadlines,
  watermark, state and optional canonical owner. No raw access/revocation secret is
  stored.
- `protect_binding()` and its BEFORE trigger: pending-only insertion, immutable
  identity/context/proofs/deadline, irreversible terminal states, monotonic watermark
  and immutable assigned owner. Ordinary deletion is rejected.
- `canonical_relationship()` and a deferred constraint trigger: final-state owner,
  existing issuer/subject mapping, canonical-session relationship and chronology.
  It reads the final row at deferred execution rather than validating an obsolete
  intermediate watermark update.
- PUBLIC access to the new schema/tables/functions is revoked. No production role,
  grant, SECURITY DEFINER interface or deployment migration is introduced.

The isolated preparation script applies the unchanged identity foundation migration
002, then the candidate SQL, in one transaction on a verified empty fixture. It
records source checksums in a local migration ledger. It does **not** install the
full payment/economic schema. The normal migration runner cannot discover this file
under `sql/candidates/`. SQL parsing, trigger behavior, role privileges and migration
application remain unverified until an actual disposable server is available.

The fixture owner has administrative capabilities; this is not a production ACL
design. Administrative TRUNCATE/drop/trigger bypass is outside the runtime threat
boundary. Retention and any production schema promotion require separate review.

## P2/P3 source corrections — 2026-11-07

Corrective parent: `4b39902527eee09486b13cc7c6f57d37805fd7d0`.

**P2: bootstrap creation target.** The fixture connection and ordinary adapter keep
`pg_catalog,public,pg_temp`. That is unsuitable for migration 002's unqualified
creation statements: `pg_catalog` becomes the creation target. Preparation now
leases one client, requires an acknowledged BEGIN, and checks the disposable
identity and empty namespace on that same client before schema changes. It records
a transaction identifier, applies `SET LOCAL search_path=public,pg_temp`, and
requires the same transaction identifier, `current_schema() = public`, the exact
bootstrap path (allowing whitespace), public USAGE/CREATE, database CREATE and
PL/pgSQL USAGE before any DDL. Missing, malformed or denied context aborts preparation.
The database CREATE check covers the candidate schema; the other checks cover the
identity foundation objects. Actual DDL permission errors also abort the transaction.

PostgreSQL 16 documents that [SET LOCAL](https://www.postgresql.org/docs/16/sql-set.html)
ends on either COMMIT or ROLLBACK, and does nothing outside a transaction except
emit a warning. The transaction-ID and path read-backs therefore must not be
replaced by assuming a successful SET command proves transaction scope.
[Search-path semantics](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-SEARCH-PATH)
make `public` the explicit creation target here while implicitly searching
`pg_catalog` first for built-ins. Explicit `pg_temp` remains last. The transaction
identifier comes from documented
[`pg_current_xact_id()`](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-PG-SNAPSHOT),
which assigns an ID if needed. This is for the one-shot writable fixture bootstrap,
not an ordinary adapter operation.

Migration 002 and candidate SQL are applied byte-for-byte and their existing
checksum ledger behavior is retained. A COMMIT must return its COMMIT command tag
before success is reported. Every preparation connection is discarded, including
after rollback or acknowledgement failure; no bootstrap connection is returned for
ordinary pool use. There is no automatic retry. A lost commit acknowledgement can
leave a prepared database while the CLI reports failure; separate inspection of
the designated disposable fixture is required, never automatic reset or retry.

**P3: strict version metadata.** The safety gate captures the version once and
requires a primitive, finite integer number in `[160000, 170000)`. It does not
coerce strings or boxed values. Undefined, null, NaN, infinities, nonnumeric/numeric
strings, fractional numbers and other major versions cannot authorize preparation.

**Reproduction and limits.** The new test file executes the actual preparation CLI
source in a VM with an isolated environment, the real safety helper and unchanged
SQL files, and a fake `pg` module. It captures the real connection options and
leased-client sequence; it never loads a real pool or opens a socket. Against the
parent, migration 002 reaches the modeled catalog-creation failure, and direct
safety checks incorrectly accept undefined, NaN, nonnumeric/numeric strings,
fractions and boxed numbers. The corrected tests cover valid major-version bounds,
pre-DDL denial, lost transaction scope, missing privileges, statement/rollback/
commit failures, checksum retention and connection disposal. These are transcript
models supported by PostgreSQL 16 documentation, **not live SQL evidence**.

Correction evidence logs: `/tmp/zephipay-native-pg-p2p3-before.tap` (expected failing
new regressions against the parent) and `/tmp/zephipay-native-pg-p2p3-focused.tap`
(52 passed, zero failures/skips after correction). The accepted core, adapter,
candidate SQL, canonical migrations, dependencies and runtime configuration remain
unchanged. Only the preparation script, test safety helper, new preparation tests
and this document change.

## Validation evidence and explicit limits

Source validation uses Node `v22.20.0`, TypeScript `5.9.3` and existing Prettier
`3.9.10`. No packages were installed.

| Check                                                                  | Result and meaning                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Focused native-session unit tests                                      | 225 passed: 146 accepted-core tests, 27 adapter/safety tests and 52 preparation corrections; zero failures/skips |
| Full unit suite (`tests/*.test.ts`, the same selection as `npm test`)  | 837 passed, zero failures/skips; `.integration.ts` suites are excluded                                           |
| `npm run lint`, `npm run build`                                        | Passed; lint is the repository's TypeScript check                                                                |
| Dedicated strict typecheck of new tests, worker and preparation script | Passed; verifies types, not PostgreSQL behavior                                                                  |
| `npm run migrate:validate`                                             | Passed for 33 unchanged ordered migration files; static source checks only                                       |
| Prettier / diff checks                                                 | Passed for changed TypeScript/Markdown; SQL whitespace checked, not parsed by PostgreSQL                         |
| Actual PostgreSQL tests / schema application                           | **NOT RUN — environment gate BLOCKED**                                                                           |

The correction runs used the installed Node/tsx loader directly:
`node --import tsx --test tests/*.test.ts`; no packages were installed. The focused
selection was the five `tests/nativeSession*.test.ts` files. Dedicated strict
typechecking also included the prepared PostgreSQL integration suite and recovery
worker without executing either. Migration validation ran the existing static
`scripts/validate-migrations.ts` through the same loader; it opens no database.

Temporary correction logs: `/tmp/zephipay-native-pg-p2p3-native.tap` and
`/tmp/zephipay-native-pg-p2p3-regression.tap`. Transcript tests inspect query order and
failure handling using doubles. They do not prove SQL execution, canonical database
atomicity, concurrent row locking, deadlock freedom or durable storage.

| Prepared integration case                                           | Evidence it is intended to obtain; current status                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Duplicate completion/revocation                                     | Separate backend PIDs, one canonical session and one event/version increment per operation; unexecuted               |
| Completion/cancellation and validation/revocation, both lock orders | A second real connection blocked on the first using `pg_blocking_pids`; unexecuted                                   |
| Account-before-session exclusive lock                               | KEY SHARE conflict at the account, binding already locked, session still obtainable by a probe; unexecuted           |
| SQL statement failure after canonical creation                      | Real rollback of canonical effects and native watermark/transition; unexecuted                                       |
| Post-COMMIT acknowledgement loss                                    | Injected driver error after a real commit, then recovery; not a wire-level partition test; unexecuted                |
| Expiry                                                              | PostgreSQL-observed deadline crossing with the existing bounded clock helper; unexecuted                             |
| Equality / earlier subsequent observation                           | Controlled clock-result substitution plus real watermark persistence; not a host/database clock change; unexecuted   |
| Connection failure                                                  | Terminating a waiting fixture backend; unexecuted                                                                    |
| Record integrity                                                    | Schema violations and a corrupted driver row after a real SELECT; unexecuted                                         |
| Cross-channel version effect                                        | Actual captured-account-version predicate changes; unexecuted; full Web summary/ceremony not installed or claimed    |
| Process recovery                                                    | Process exits after COMMIT, second process validates the same session; unexecuted; not a database crash/restart test |

Physical storage loss, primary failover, power failure, network uncertainty at the
precise COMMIT boundary and genuine wall-clock rollback are not demonstrated.
The prepared process probe covers an application process only. Full outstanding
Web-confirmation invalidation/recovery against migrations 001–033 remains open in
addition to the captured-version predicate check. No simulated result substitutes
for these gates.

## Future execution after separately authorized local setup

First identify a dedicated local PostgreSQL 16 process/container and data directory;
create a fresh uniquely named database owned by the fixture login, set the exact
disposable comment, and verify no remote proxy/cloud target is involved. Set only
the three dedicated test-designation variables described above. The test helper
must pass its read-back checks before any mutation.

Then, on that explicitly designated fixture only:

```sh
node_modules/.bin/tsx scripts/prepare-native-session-postgres-local.ts
node_modules/.bin/tsx --test --test-concurrency=1 tests/postgresNativeSession.integration.ts
```

Missing designation is an error, not a skipped suite. The prepared worker uses the
same gate. No command above was run in this milestone. Do not pass an existing
application URL to these tests. Do not apply the candidate to Railway or a shared
database. Canonical identity regressions and full-schema/Web compatibility need
separate disposable fixture runs before database acceptance.

The first actual PostgreSQL 16 run must additionally confirm bootstrap object
placement in `public`, real required-role privileges, unchanged migration checksums,
and the catalog-first connection path after both committed and rolled-back
bootstrap transactions. It must exercise rejection of missing public USAGE/CREATE
and database CREATE, and prove no partial schema survives an injected DDL failure.
Source transcript tests do not close these database execution gates.

After actual database execution, resolve failures without weakening the accepted
core, record real lock/fault/clock evidence, and obtain Sol's independent database
implementation audit. Production ACLs, canonical migration promotion, client
inventory/admission enforcement, Auth0 bootstrap feasibility, native SDK/storage
and durable sign-out remain separate gates. No HTTP mounting, provider setup,
economic authorization, remote Git, deployment or deployment-hold restoration is
authorized by this candidate.
