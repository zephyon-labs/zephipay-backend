# Pre-signer lifecycle and operational authority V1

This Backend package releases reserved capacity only when durable evidence proves an invalidated operation has never crossed the signer-contact boundary. It remains disconnected from every existing payment route, worker and live composition. It introduces no signer, Runtime provider, chain observer, wallet connection, deployment or asset activation.

## Scope and compatibility

Only `zephipay-backend` changes. Protocol remains the pinned 0.4.0 SDK; its asset identity, intent, authorization, attempt fence, finalization tuple and signature verification remain canonical. No existing HTTP schema, environment variable, route, receipt, Devnet implementation or other repository changes.

The unmounted foundation repository constructor now requires explicit signer-result and observer-evidence connections when those adapters are supplied. Its internal operation DTO adds `budgetId`, `budgetVersion` and `EXPIRED_NEVER_CONTACTED`. All current consumers are foundation tests; there is no deployed consumer migration. Future integration must apply migration 024, provision and verify database roles, establish trusted session bindings, and only then construct these internal services. This package does not authorize that integration or deployment.

## Lifecycle and reservation accounting

| Signer state | Exposure | Meaning and permitted action |
|---|---|---|
| `NOT_CONTACTED` | `RESERVED` | No committed contact grant. Recheck eligibility before contact; expiry requires affirmative invalidation and absence of contradictory evidence. |
| `CONTACT_COMMITTED` | `UNCERTAIN` | One durable contact grant exists, even if the process died before sending anything. Never reclaim on timeout. |
| `RESULT_UNKNOWN` | `UNCERTAIN` | Query the same signer operation; no new finalization identity or timeout release. |
| `RESULT_AVAILABLE` | `UNCERTAIN` or `CONSUMED` | Verified signed artifact is durable. Signing does not prove settlement; stored trusted observer evidence is required for realized accounting. |
| `REFUSED` | `RELEASED` | Existing definitive signer-refusal semantics remain unchanged. |
| `EXPIRED_NEVER_CONTACTED` | `RELEASED` | Terminal loss of contact authority. No revival, signature/result transition or new contact is possible. |

`expireNeverContacted(id, actor)` executes `economic_expire_never_contacted` in one database transaction. It requires the canonical intent generation and committed finalization fence, exact `NOT_CONTACTED`/`RESERVED` state, no realized accounting, and at least one locked authoritative reason: expired intent/consent/Runtime/session, revoked consent/Runtime/session/asset/network, or inactive canonical account. Missing session linkage alone is not an affirmative expiry/revocation reason and does not grant contact.

Any contact ledger, possible-effect/finalized observer evidence, contact/result/accounting audit evidence or uncertain/matching signed callback prevents reclamation. Known results, refusal and uncertain contact states cannot take the expiry path. There is no submission implementation in this foundation: every future submission-capable composition must use this contact authority and record effect evidence before a possible external effect. This is a proof within that mediated authority model, not proof that an arbitrary external key holder never signed or submitted anything elsewhere.

Release sets the existing reservation to `RELEASED`; it does not delete or zero requested units. The immutable expiry record holds the released base/priority/rent amounts, old/new state, generation, reservation ID, consent/Runtime/session references, reasons, system actor, database session actor and time. The existing exposure projection distinguishes requested, reserved, consumed and released amounts. Structurally, a never-contacted operation cannot already contain realized accounting; malformed/contradictory states fail closed instead of erasing it.

The expiry record, terminal transition, release and authority event commit atomically. A failure before commit rolls them all back. A lost response after commit is an idempotent replay: same row/version, one release record, one authority event. `recover` returns terminal expired state without calling either signer method. The attempt remains `FINALIZATION_COMMITTED`; expiry is not cancellation and does not reopen a generation. Any future replacement-intent product flow remains separate work.

## Serialization and trust evidence

Contact, expiry, signer-result recovery and observer evidence use the same lock order: intent head, budget-family head, immutable budget version, finalization row. Eligibility then locks canonical account, consent, Runtime, session and qualification records. Canonical session revocation locks account before session; evidence/configuration revocation does not acquire the intent or budget lock. Wall-clock eligibility is checked after authority lock waits.

The controlled contact function inserts an immutable contact-authority record and changes state in the same transaction. Exactly one successful first-contact transaction receives the one-shot grant. A crash after its commit loses the one-shot grant; later recovery only queries the same operation. If expiry commits first, contact returns no grant and recovery cannot call the signer. If contact commits first, expiry fails even if revocation follows immediately or no signer result ever arrives.

New rejected callbacks retain Protocol-derived evidence classification. A verified complete sponsor result is `SPONSOR_RESULT_PRESENT`; a matching-message signature inspection that throws remains `REJECTED` (uncertain). Legacy rejected callbacks remain uncertain; migration does not reinterpret their bytes. Parse/profile failures and confirmed unsigned artifacts are `INVALID_ARTIFACT`, while a verified customer-only callback remains `CUSTOMER_VERIFIED`. Uncertain or sponsor-signed evidence blocks reclamation and fresh contact. Callback insertion serializes on the intent head. Evidence arriving after terminal expiry is retained as incident evidence and cannot revive authority; no unseen future callback can be treated as proof available to an earlier transition. Trusted signer/observer adapters must honor the committed authority boundary.

## Budget administration

An immutable budget version owns its network, sponsor/key identity and exposure limits. A family head contains `ACTIVE`/`DISABLED`, current version and administrative revision. New reservations require the current active version and persist its exact ID/version. Limits are fixture/configuration input; no production SOL limits, pricing, replenishment or treasury policy is selected.

Disablement stops new reservations. It neither releases outstanding exposure nor revokes a previously committed operation's budget attribution. Existing operations may complete the existing eligibility/recovery path under their original version. A separate evidence/session revocation can prevent new contact; a budget disablement is not evidence of never-contacted status.

All versions in a family share capacity accounting: reserved and uncertain maximum amounts plus realized consumed amounts, and the count of outstanding operations. Replacing the version never resets exposure. Reduced limits below existing exposure prevent new claims without making old recovery impossible. Version changes preserve disabled status. Compare-and-swap administrative revision prevents stale updates; after an ambiguous response, read the head and confirm the intended status/version before retrying. Old versions and reservations remain immutable. No new family for the same network/sponsor/key identity can silently reset these costs.

## Canonical account-session authority

`EconomicSessionAdministration.bind` is a trusted identity-service seam. It binds verified provider issuer/subject/session ID to an **existing** canonical `account_sessions.session_id` owned by that external identity's account. Binding is immutable and cannot be moved to a replacement session. There is no separate identity/session authority and no public binding endpoint.

Consent requires the binding and an active, effective, unexpired, unrevoked canonical account session. Consent expiry is bounded by JWT expiry, intent expiry and canonical session expiry. Claim and first contact recheck the stored canonical session under locks. Provider authentication policy remains fixed by server composition. Frontend logout/cookie deletion is not authoritative revocation; the existing identity persistence/service must record session revocation and its security event.

Migration leaves historical consent's new `account_session_id` NULL; it does not infer identity from an old provider session string or rewrite historical consent. NULL cannot authorize a new contact. Already-contacted operations retain their prior recovery rules regardless of later session revocation, and known artifacts/receipts are not rewritten. Existing contacted states receive contact-ledger entries marked `LEGACY_STATE`; their legacy timestamp is provenance from the old row, not a fabricated exact signer-contact time.

## Database roles and deployment contract

Schema migration and role setup are deliberately separate. Migration 024 works without `CREATEROLE`; a production composition must also complete `npm run db:economic:roles` using an explicitly privileged migration connection. This invokes `sql/economic-database-roles-v1.sql` transactionally. Failure is fatal and must not be ignored. CI explicitly runs both steps; permission tests fail if the groups are missing.

| NOLOGIN group | Authority |
|---|---|
| `zephipay_economic_admin` | Owns scoped foundation objects/functions; schema/configuration administration. Its credentials never belong to request-facing code. |
| `zephipay_economic_app` | Initial attempt/reservation columns, guarded attempt transitions, callback/audit append, and approved contact/expiry/unknown/stored-accounting functions. No direct finalization lifecycle or result/accounting writes. |
| `zephipay_economic_issuer` | Trusted authenticated consent/Runtime evidence and canonical session bindings; one-way evidence revocation. Cannot change canonical accounts/sessions or grant contact. |
| `zephipay_economic_signer` | Existing committed operation's verified signer result/refusal/unknown columns. No reservation creation, contact ledger, observer evidence or realized accounting. |
| `zephipay_economic_observer` | Bounded operation view and append-only possible-effect/finalized accounting evidence. No raw artifacts, consent/session claims or finalization mutation. |
| `zephipay_economic_reader` | Selected support views/history/configuration. No economic authority or raw signing artifacts. |

The normal app has restricted INSERT columns and an initial-state trigger: it cannot insert contacted, terminal or realized finalizations, even with terminal-shaped input. Deferred guards also require the matching contact ledger or expiry record. Observer evidence validates operation/network, and finalized accounting additionally requires the verified signed transaction and bounded realized amounts. The app may apply only a stored observer record through a controlled function. Signer results still pass Protocol cryptographic checks in the trusted signer-result service; SQL privileges are not a replacement cryptographic verifier or trust in arbitrary client bytes.

Row locks in PostgreSQL require an UPDATE privilege. Some roles therefore receive UPDATE on one immutable identifier column solely to acquire locks. Existing lifecycle/version guards reject actual/no-op mutations of those columns. The test suite exercises these attempted writes. No runtime group can disable triggers, alter schema, truncate, delete protected history or execute internal lock/invalidation helpers.

Security-definer functions have a pinned trusted search path; their owner is the NOLOGIN admin group. Internal helpers and all foundation functions lose PUBLIC execution. `public` loses PUBLIC CREATE. No role can inherit another role, be SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS at group provisioning time; unexpected group attributes/membership cause setup to fail. The installer is explicit and repeatable, resetting scoped table/column grants. Existing Devnet/identity table ownership is not transferred.

Before any real integration, deployment must verify all of the following with actual login identities:

1. Migration login can own/migrate the scoped objects and provision these groups. Use a maintenance window for grants; do not run role replacement concurrently with operational requests.
2. Each operational login is non-superuser, cannot create roles/databases, cannot bypass RLS, does not own the database/schema/tables/functions, and has only its intended economic group plus explicitly reviewed unrelated grants. It cannot SET ROLE to any higher or sibling authority, directly or through inherited memberships.
3. No public/other-schema function, ownership, default grant or inherited role supplies an alternate write/DDL path. The explicit SQL covers this foundation's objects; deployment-wide preexisting grants need an inventory. Verify schema CREATE and all table/column/function privileges, not just table-level ACLs.
4. Migration/configuration credentials stay outside runtime connections. Separate issuer, signer-result and observer credentials belong only to their trusted server components. The constructor requires explicit connections but does not attest login privileges or provide process isolation. A process holding all credentials remains trusted at their combined authority level.
5. Run permission-denial and positive transition probes under each actual login against disposable/staging fixtures. Do not substitute SET ROLE from a superuser as evidence of login isolation.

Exact login names, passwords, secret delivery and process/service deployment topology are deliberately outside this package. The PostgreSQL tests create visibly synthetic LOGIN roles with a fixture-only password in a disposable cluster. No real credential is created or read. Existing account/session infrastructure keeps its own separate identity authority credentials.

## Reproducible validation

Use an empty disposable PostgreSQL 16 database and a privileged test/migration login with CREATE ROLE. Never point these destructive fixture tests at a shared or operational database.

```sh
npm ci
npm run lint
npm run build
npm test
npm run migrate:validate
DATABASE_URL="$DISPOSABLE_DATABASE_URL" npm run migrate
DATABASE_URL="$DISPOSABLE_DATABASE_URL" npm run db:economic:roles
TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" npm run test:postgres:economic
TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" npm run test:postgres
git diff --check
```

Repeat the critical race tests sequentially in the same disposable database; do not run suites that truncate shared fixture tables concurrently:

```sh
for iteration in 1 2 3 4 5 6 7 8 9 10; do
  TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" npx tsx --test --test-concurrency=1 \
    --test-name-pattern='race:|session eligibility waits' tests/postgresOperationalAuthority.integration.ts || exit 1
done
```

Tests use independent connections/transactions and real restricted LOGIN identities. Coverage includes both contact/expiry lock winners, result recovery, consent/Runtime/session revocation, cancellation, double expiry/release, budget disable/version races, deferred-commit failures, lost responses, session lock timeout/retry, immutable history, direct write/DDL/escalation denial, and temporary-schema shadowing. There is no chain RPC or live adapter in these tests.

## Remaining gates

Independent audit is next. No Phase B push, PR or merge is authorized by this package. After audit, a separately authorized package can close the protected workflow and define trusted session-service composition, least-privilege deployment verification and synthetic adapter integration. Real signer/observer/Runtime transport authentication, activation controls, production budget values, expiry scheduling, incident adjudication for contradictory historical callbacks, and user experience for replacement intents require later review. OBS-04 independent-vector-generator provenance remains deferred and unchanged.

ZERA remains inactive with no registry entry, minting, routing, qualification, distribution, staking or liquidity change. Its canonical 200M supply/allocation baseline is unchanged. ZephiPay remains useful without ZERA.
