# Foundation 1B native session core — offline implementation V1

Review candidate only. Implements the authorized unmounted portion of accepted
Native Session Contract V1.1. This milestone does not establish native login,
production session authority, or readiness to mount an endpoint.

Baseline: `a7f7270cc074359cbbdb32a06d665b2933b8a22c`.
Local branch: `feat/native-session-core-offline-v1`.
P2 correction parent: `d2b49fecb528960cd301a5e4992b561030f85806`.

## Scope and isolation

| File                                     | Responsibility                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/nativeSession/contracts.ts`         | Distinct identifiers, credential classes, persistence/authentication ports and result types         |
| `src/nativeSession/values.ts`            | Descriptor snapshots, bounded values and domain-separated proof commitments                         |
| `src/nativeSession/policy.ts`            | Server-owned client classification and isolated route admission                                     |
| `src/nativeSession/core.ts`              | Completion, validation/recovery and capability-based cancellation/revocation                        |
| `src/nativeSession/records.ts`           | Validated, immutable persistence snapshots and state relationships                                  |
| `tests/helpers/nativeSessionHarness.ts`  | Opaque synthetic authentication, existing-account fixtures and fault-injectable memory transactions |
| `tests/nativeSessionCore.test.ts`        | State, transaction, identity, timing and canonical-effect regressions                               |
| `tests/nativeSessionPolicy.test.ts`      | Admission attacks, descriptor tests and source-isolation checks                                     |
| `tests/nativeSessionCorrections.test.ts` | Four original P2 reproductions, denial watermarks and hostile persistence regressions               |
| This document                            | Review evidence, assumptions and integration gates                                                  |

All package files are additions relative to canonical main. Existing server entry points, routes, authentication
middleware, identity persistence, migrations, dependencies and configuration are
unchanged. The core imports only its own modules, `node:crypto` and `node:util`
(the latter restricted to persistence Proxy detection). No existing
source module imports it. Synthetic evidence issuers and persistence adapters exist
only under `tests/`; they are outside the production TypeScript compilation root.
The compiled core is an unused module, with no composition or registered route.
Its `productionReady: false` field is descriptive, not an authorization mechanism.

The AST boundary test checks static imports/exports, `require` and dynamic imports,
including negative controls. Computed module loads are prohibited inside the new
core. This limited scanner is not a comprehensive security audit or a proof about
arbitrary computed loading in future code. Unchanged existing source plus absence
of importers establishes this candidate's unmounted boundary.

## Domain contract

`loginAttemptId`, `nativeBindingReference` and `canonicalAccountSessionId` have
different branded types and runtime shapes. Attempt and binding IDs use distinct
prefixes; canonical session IDs use the existing UUID shape. An immutable index
lookup locates a binding; it does not establish authority. The binding is re-read
under serialization before any operation.

Attempt creation is deliberately **not implemented**. The harness seeds pending
attempts and existing identity mappings. No public preparation endpoint, identifier
generator, provisioning behavior, retention worker or rate limiter is supplied.

| Operation              | Required evidence                                                  | Result and state effect                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`             | Attempt ID, trusted authentication handle and access secret        | Matching fresh authorization-code bootstrap may bind one existing account and create one canonical session; exact retries inspect current state |
| `validate`             | Binding reference, trusted authentication handle and access secret | Reads current canonical authority; can recover a committed completion after a lost response; cannot create or extend a session                  |
| `revoke` while pending | Binding reference and separate revocation secret                   | Commits `CANCELLED`, or `EXPIRED` at/past the attempt deadline; no canonical session creation                                                   |
| `revoke` while active  | Binding reference and separate revocation secret                   | Revokes the canonical session once and commits `REVOKED`, or latches already-revoked/expired authority                                          |

No access token is required to use the revocation capability. Possession allows
denial of this binding's account access, not account access itself. An unknown
binding and a wrong revocation proof return the same rejection. Production
anti-enumeration, abuse controls and capability delivery remain future work.

Pending attempts become completed, cancelled or expired; bindings become active,
cancelled, expired or revoked. Terminal bindings never become active again.
Ownership, context, commitments, deadlines and canonical session linkage are
immutable after their permitted initial assignment. A fresh explicit bootstrap for
a different attempt may create a different session; this is not global logout or
an account-wide prohibition on signing in again.

Structured results distinguish `account-access`, `terminal`, `rejected`,
`conflict` and `unavailable`. Token expiry is distinct from binding/session expiry.
Verifier failures, invalid clock authority, lock failures and ambiguous commits
return unavailable authority. A failed operation does not manufacture a terminal
acknowledgement. Results contain neither secrets nor economic capabilities.

## Authentication and credential boundaries

`AuthenticationPort` is a trusted adapter seam, **not a JWT verifier**. This
candidate supplies no production implementation. Tests issue opaque object handles
through a private `WeakMap`; raw claim objects, copied handles and handles from a
different issuer fixture are rejected. These handles are not tokens.

The policy snapshots normalized metadata using data descriptors and classifies
the principal using a server-configured exact issuer/client pair. Audience cannot
select another credential class. Missing/unknown clients, unsupported or conflicting
client dialects, disallowed audiences/scopes, extra authority fields, unsupported
grants and malformed bootstrap claims fail closed. Principal objects issued by
one policy cannot be copied or reused with another policy instance.

The normalized seam currently accepts `azp` only. A future verifier must establish
its authenticated meaning and reject missing/conflicting client identities before
normalization; it must not silently discard conflicting raw JWT claims. The seam's
strict field allowlist is not a proposed allowlist of every standard JWT field.

Native completion requires an authorization-code bootstrap with exact attempt ID
and challenge. Refresh evidence may validate an existing binding but cannot create
a replacement. Environment, issuer, client, audience and immutable owner are checked
against the binding. Native, legacy Web and service credential classes have separate
route rules in the isolated harness. **Deployed route admission remains unchanged.**
The fixture registry and scope labels are not an inventory or approval of live clients.

Access and revocation proofs use separate SHA-256 commitments over a versioned
domain, proof purpose, environment, issuer, client, audience, creation key and
32-byte secret. Comparisons are constant-time over fixed-size hashes. Stored
commitments cannot be submitted in place of secrets. Real random generation,
delivery, storage and theft resistance are not implemented; fixed fixture values
are intentionally synthetic. These remain bearer capabilities, not DPoP.

## Transaction, clock and canonical effects

The persistence contract requires exclusive binding serialization first, then
exclusive canonical account access before session access. There are no shared-lock
upgrades. Current serialized state is checked before non-idempotent creation or
revocation. Account-version increments and security events must commit atomically
with canonical changes and the binding transition.

The authorization decision uses one persistence-owned clock sample after the
relevant existing-row locks. Deadlines reject at equality. It checks nonnegative
safe-integer times and rejects observations below the binding's persisted
high-water mark, creation time or relevant canonical timestamps. Validation never
extends immutable session expiry. Committed terminal state stays terminal even if
the clock later moves backwards. Access evaluation during a detected rollback
returns unavailable; acknowledgement of an already-terminal revocation can avoid
a fresh clock sample.

After authentication provenance, binding/proof, context and owner checks, a valid
clock sample is written before any access decision returns. This includes token
expiry, missing scope/bootstrap, unknown account, suspension, future issue time
and pending-validation denials. The watermark and any ensuing terminal/canonical
changes share one transaction. Save, commit or acknowledgement failure returns
`AUTHORITY_UNAVAILABLE`, not an acknowledged denial or successful authorization.
Wrong evidence, proof, context, owner or credential class cannot reach this clock
write. Only the persistence clock supplies its value; token dates and request fields
cannot select a watermark. The guarantee is per binding, not a global token clock.

This is a decision-time check, not a guarantee that a token remains valid until
the response reaches the client. It does not retract previously returned account
data or cancel requests authorized earlier. Account-access results are snapshots,
not reusable authorization tickets. Any future protected operation must perform
its own current authoritative validation.

The memory harness serializes **all** transactions with one mutex and clones state
for rollback. Its lock traces model the required ordering, not PostgreSQL locks.
Injected faults cover lock acquisition, canonical creation/revocation, binding
writes, pre-commit rollback and post-commit lost acknowledgement. The persistence
promise resolves only after commit; terminal transitions return data through that
boundary rather than throwing an exception that would roll them back.

There is no disk durability, process-restart proof, row-level concurrency proof or
deadlock-freedom claim. A new core instance sharing the same harness demonstrates
logical recovery only. Real PostgreSQL wall-clock corrections cannot be eliminated
by this model: a rollback above an old watermark may go undetected, and an expired
deadline not yet latched may appear unexpired under wall-clock correction. Database
clock monitoring and the accepted failure policy need independent integration tests.
An expired credential already denied in a committed observation on this binding
cannot regain access through a subsequent rollback below that observation.

Persistence records are snapshotted immediately on receipt, including nested
binding context/owner and created or locked canonical sessions. Proxies are rejected
before reflection; own data descriptors are captured without executing getters.
Validation and output projection use only frozen copies. Unknown fields/states,
malformed values, inconsistent actor/ID pairs and invalid cross-field relationships
yield unavailable authority. Exact resolved-account/locked-account equality is
checked before completion, and existing-session access requires ACTIVE/COMPLETED
binding state with matching canonical ownership and an ACTIVE account. Canonical
revocation is represented by a valid timestamp or null, with expiry checked at the
observed time; no caller-provided session-state label is accepted.

Snapshot validation cannot prove a coherent but dishonest persistence adapter's
claims. The adapter still owns exclusive serialization and atomic commit. Tests
distinguish mutation of previously returned JavaScript objects from an actual store
transition: immutable copies prevent projection substitution; queued revocation
serializes after an in-flight operation and prevents subsequent authority. There is
no new mobile-style lifecycle generation system or replacement database authority.

Canonical compatibility evidence:

- [Existing memory identity repository](../src/storage/memory/inMemoryIdentityPersistence.ts)
  increments account version and emits `SESSION_CREATED`/`SESSION_REVOKED`. The
  differential regression compares these effects with the synthetic native flow.
- [Existing PostgreSQL canonical helpers](../src/storage/postgres/postgresIdentityPersistence.ts)
  preserve the same account mutation/event coupling. They are inspected, not called.
- The `economic_confirmation_summary` view in migration 031 invalidates a pending
  confirmation when its captured account version differs. The existing
  [Web confirmation service](../src/economic/web/controlledWebConfirmation.ts)
  maps invalidated summaries to `SESSION_CHANGED`.

The regression demonstrates the version changes that trigger this interaction;
it does not execute the real Web/PostgreSQL confirmation flow. No versioning is
decoupled. Future recovery must obtain fresh eligible confirmation context and
consent instead of reviving the invalidated confirmation.

Account lookup is existing-only and keyed by issuer plus subject, with canonical
account UUID/`zp:account:<uuid>` consistency checks. No email-based binding or
implicit account provisioning exists. Account access explicitly reports economic
authority as unavailable; it cannot provide consent, Runtime approval, payment
execution or an economic-session binding.

## Validation evidence

Corrective checks on 2026-11-06, Node `v22.20.0` and TypeScript `5.9.3`:

| Check                                                                     | Result                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Focused command below                                                     | 146 passed; zero failures, cancellations, skips or TODOs                  |
| `npm test`                                                                | 758 passed across 40 suites; zero failures, cancellations, skips or TODOs |
| `npm run lint`                                                            | Passed (`tsc --noEmit`, repository's lint command)                        |
| `npm run build`                                                           | Passed; generated output is ignored under `dist/`                         |
| Dedicated strict TypeScript check for all three native-session test files | Passed; ES2022 target permits test-only `Array.at`                        |
| Prettier 3.9.10, explicit corrective-file inventory, print width 100      | Passed                                                                    |
| Source-isolation and scanner negative controls                            | Passed within focused and full suites                                     |
| `git diff --cached --check`                                               | Passed before commit                                                      |

Focused tests and dedicated test typecheck:

```sh
node_modules/.bin/tsx --test tests/nativeSessionCore.test.ts \
  tests/nativeSessionPolicy.test.ts tests/nativeSessionCorrections.test.ts
node_modules/.bin/tsc --noEmit --strict --target ES2022 --module CommonJS \
  --esModuleInterop --skipLibCheck \
  tests/nativeSessionCore.test.ts tests/nativeSessionPolicy.test.ts \
  tests/nativeSessionCorrections.test.ts
```

Backend has no formatter script/dependency. Formatting uses the already-installed
Prettier CLI at `../zephipay-mobile/node_modules/prettier/bin/prettier.cjs`, targeting
only the seven files in this corrective patch. No package installation or Mobile modification
is involved. Backend source retains its existing ES2020 target.

Adversarial evidence includes 12-way duplicate completion/revocation, both ordered
cancellation/completion races, external canonical revocation, terminal replay,
rollback/lost-response recovery, immutable expiry under refresh, wrong/bootstrap
proofs, wrong identity/client/class/audience/scope, accessor/Proxy snapshots,
clock rollback/equality/invalidity, lock failures and order violations. The complete
local regression command excludes the separately named PostgreSQL and chain suites.

## P2 corrective evidence

The four security assertions were run against the unchanged prior candidate before
any core or harness edit: **four failures**, each demonstrating the reported access
violation. The same four assertions pass after correction. The new correction test
file contains 68 tests in total; the prior 78 native-session tests remain unchanged
except for the narrow `node:util` isolation allowlist entry.

| Original violation                           | Observed before correction                                                                                                 | Corrected result                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P2-01 expired credential then 1 ms rollback  | At `1800000300000`, denial did not retain the observation; at `1800000299999`, the same credential received account access | Committed watermark remains `1800000300000`; rollback yields unavailable authority |
| P2-02 A: resolve Alice A, lock returns Bob B | Alice's identity received account `...0102` instead of resolved `...0101`                                                  | Exact account equality fails; no authority or writes                               |
| P2-02 B: changing account properties         | Result combined account B's ID with account A's `zp:account:` actor                                                        | Persistence Proxy rejected before reflection; no authority or writes               |
| P2-02 C: `UNSUPPORTED` binding state         | Plausible canonical linkage still received account access                                                                  | Recognized-state/cross-field validation rejects it before writes                   |

Original reproduction command, run at the prior candidate with only the new four-test
file present:

```sh
node_modules/.bin/tsx --test tests/nativeSessionCorrections.test.ts
```

Local TAP evidence is preserved at `/tmp/zephipay-native-session-p2-before.tap`,
`/tmp/zephipay-native-session-p2-focused.tap` and
`/tmp/zephipay-native-session-p2-regression.tap`. These temporary logs are not
versioned; the permanent regression cases and this evidence record are.

Additional coverage includes six committed denial paths; failed watermark writes,
rollback and ambiguous commit; joint rollback of watermark/terminal state; invalid
clocks; untrusted requests that cannot reach the clock; malformed accounts, bindings
and sessions; accessors and reflection traps; record mutation by later callbacks;
malformed creation rolling back canonical effects; and queued revocation. Normal
completion, validation, cancellation, expiry, recovery and duplicate revocation
remain covered by the original suite and new positive controls.

The raw adversarial port deliberately performs no cloning or state sanitization;
it isolates the core's record-boundary checks and is not a durability model.
Separately, the memory harness now independently rejects unknown states, invalid
state combinations, premature terminal states, ownership mismatches and invalid
pending transitions. It does not reuse the core's record validators as its oracle.

This correction changes no public HTTP contract, live admission rule, canonical
account-version/security-event behavior, or economic capability. It awaits Matt/Nova
review and Sol's focused independent re-audit; it is not integration approval.

## Required gates before integration

1. Matt/Nova review, then Sol's independent implementation audit of this candidate.
2. Separately authorized PostgreSQL adapter/schema work and disposable-database tests:
   real lock order, account identity stability, canonical helper composition,
   concurrent bindings, immutable constraints, rollback/commit ambiguity, clock
   correction, terminal retention and Web cross-channel confirmation recovery.
3. Controlled Auth0 Action/SDK feasibility proof: authenticated bootstrap claim,
   authorization-code-only transaction binding, client/audience/claim semantics,
   refresh behavior and replay resistance. No custom-claim feasibility is presumed.
4. Inventory legitimate live Web/service clients before any central admission
   enforcement. Preserve their behavior while closing all native legacy-route paths.
5. Separately approve attempt preparation, cryptographic random generation,
   bounded retention/tombstones, cleanup, rate limits and production observability.
6. Native SDK/storage and durable logout-barrier design, including writer quiescence,
   deletion/journal failures, rotation, account switching and offline revocation.
7. Founder decisions on native clients, audience/scopes, pilot lifetimes, provisioning,
   logout scope and bearer/DPoP risk. The five-minute token and 24-hour session values
   in tests are explicit fixtures, not deployed policy or permanent consumer limits.

No database, Auth0, credentials, native builds, remote Git, production systems or
economic operations are used. Production deployment holds remain untouched; their
remote state is not re-queried during this offline milestone. Web, Mobile and
Protocol repositories remain outside the write scope.
