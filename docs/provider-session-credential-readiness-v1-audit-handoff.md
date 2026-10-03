# Provider session and credential readiness V1 — audit handoff

Status: READY FOR FOCUSED RE-AUDIT — pinned-key initialization correction validated locally; final evidence below.

Scope: Backend readiness only. See [architecture and trust boundaries](provider-session-credential-readiness-v1.md) for the provider contract, chronology, freshness, ownership matrix, rotation, compromise assumptions and unresolved integrations.

## Predecessor closure

- PR: https://github.com/zephyon-labs/zephipay-backend/pull/6
- Accepted exact head: `37df91c9b438df83adfc2e9fb775dcf00417fe32`.
- Audited predecessor patch: 21 files, +1,448/−24; SHA-256 `da01dbf77f6fc761f839a63252eba36f678f4c896d8da78f3f6c89d75fb3ec9f`.
- Required hosted verification: https://github.com/zephyon-labs/zephipay-backend/actions/runs/37085523287, successful.
- Normal protected merge, no bypass and no candidate edits. Canonical merge: `745b363e1df973c8923a1a848c2c0d62de5a4e42`.
- Canonical local main was fast-forwarded, clean, identical to origin and the accepted tree. No deployment was invoked.
- OBS-04 remains deferred Protocol maintenance.

## Originally reviewed candidate

Reviewed commit: `0188ab7167a2344e6bda03035d6baa2e0878969e`. Independent verdict: REVISE BEFORE MERGE for AUD-PSCI-01 (P2 material); provider/session architecture accepted.

- Base: `745b363e1df973c8923a1a848c2c0d62de5a4e42`.
- Branch: `feat/provider-session-credential-readiness-v1`.
- Worktree: `/home/zeranova/dev/zephyon-labs/zephipay-backend-provider-readiness-v1`.
- Local commit only. No Phase B push, PR, merge or deployment.
- Migration 027 adds empty deployment identity/LOGIN registration and append-only token-use evidence. Explicit role provisioning adds the identity compartment and narrowly scoped new grants.
- `jose` 6.2.7 moves to production dependencies without a version change. SDK remains v0.4.0.

## Review priorities

1. Verify exact token profile, signed environment/context/subject/session scope, strict time handling, one-use jti policy and public-key provenance. Test defaults do not constitute approved production provider settings.
2. Verify atomic token consumption with canonical session creation/binding/revocation and consent. Historical consent `authenticated_at` remains iat; actual auth_time is distinct. No backdating or session recreation from token claims.
3. Verify account lock order, canonical CAS and post-wait eligibility checks. Confirm consent expiry carries recent-authentication and token-age limits into claim/contact gates.
4. Verify every process has exactly one operational DB credential. Inspect actual-login identity/group/grant/ownership/delegation verification and database/environment/generation matching. Validate that identity, issuer, app, signer and observer each lack the rest of the chain.
5. Verify provider key revision survives reconstruction via durable deployment registration. Review credential retirement and in-flight cutoff limitations; application checks alone do not attest OS isolation or terminate arbitrary active SQL.
6. Verify legacy unmounted synthetic composition remains distinct from the new service seams. No claim that provider login grants wallet signature, Runtime approval, live signer authority or independent observation.

## Evidence

Validation on the original reviewed candidate (historical):

| Check | Result |
| --- | --- |
| Lint / TypeScript noEmit; build | Passed; built CommonJS provider module loads |
| Unit tests | 423 passed, including 28 provider-token cases; zero failures/skips |
| Focused provider / actual LOGIN integration | 49 passed; zero failures/skips |
| Full PostgreSQL regression | 330 passed, including the 49 provider cases; zero failures/skips |
| Race / failure repetitions | Replay and revocation-during-verification each repeated three times; rotation rollback and reconstruction covered |
| Migrations | 27 validated and applied fresh; 026→027 upgrade and role provisioning preserve seeded records |
| Whitespace / scope | git diff --check passed; no historical migration or mounted route changes |

The original implementation-only patch SHA-256 was `f5706f2226323e16a164081c9878fb4c03cace2b677a5e450742dbc6846504e4` (src/sql/migrations/tests/package/scripts; excludes these documentation files).

The original candidate patch manifest and local commit were recorded at closure in `/tmp/provider-readiness-audit-manifest.json`. Logs use the `/tmp/provider-readiness-` prefix. They contain no real credentials or bearer tokens.

Fresh disposable database: migrations 001–027 applied, explicit role installation successful. Separate 026→027 upgrade fixture preserved all six seeded account/identity/session/security-event rows exactly; SHA-256 `ab0140967f84e83261f6fea63bc769b4bca2d17af7fedfa032d3d1dfd3247af0`. Historical migrations 001–026 are byte-for-byte unchanged in Git.

Intermediate failures were test issues: an assertion expected frozen-object assignment to throw under the test runner; a fixture session timestamp predated its account update; one fault-injection SQL parameter needed explicit UUID/text casts. All corrections remain in this candidate. No failure was suppressed, no security gate was disabled, and no real endpoint or production secret was used.

## Boundaries and next package

No live provider account, real signer/observer, wallet route, Mainnet operation, funding or transfer. Existing Devnet routes and wiring remain unchanged; the shared canonical identity refactor is covered by regression. No ZERA registration, qualification, activation, mint, distribution, staking or liquidity. The canonical 200M economic baseline SHA-256 remains `182299950ae49c2bd2d8d5a99d2f73b3d0f77520982ab3c04ff8e2b9c1bbdff1`.

Next: independent security/architecture audit of this local candidate. After acceptance, separately choose and verify a real provider adapter, authenticated inter-service transports, production freshness/key-rotation policy, secret-manager/process isolation and emergency revocation procedures in non-value staging. Live economic integration requires a later explicitly scoped package.

## AUD-PSCI-01 correction

Root cause: the reviewed constructor called `createLocalJWKSet`, which checks the set shape but lazily imports a key only when asked to resolve it. `checkProviderRevision` trusted a matching revision without proving any key had imported. The exact reviewed source accepted `{kty:"RSA",kid:"missing-public-material",alg:"RS256",use:"sig"}` at revision 1 with zero provider JWTs presented. The local reproduction is `/tmp/provider-keys-original-reproduction.json`.

The correction is confined to two provider source files, their focused tests/shared malformed-key fixtures, and these two documents. No SQL, migrations, role model, dependency/SDK version, issuer/audience/client/environment binding, action scope, chronology, auth_time policy or token-consumption semantics change.

- Explicit awaited factory/initialization; uninitialized verifiers cannot satisfy either readiness surface.
- Validate every configured key: complete canonical RSA n/e, unique kid, strict metadata allowlist, fixed RS256 profile, signature use, verify-only key_ops, no private material, and named minimum `MIN_PROVIDER_RSA_BITS = 2048`.
- Eager JOSE resolver import of every key, imported algorithm/strength/usage checks, and a no-token WebCrypto verification primitive check.
- Build privately and publish one immutable revision/resolver pair after full success. Recheck monotonic revision after awaits. Failed snapshots never partially activate; the prior validated snapshot is retained subject to durable revision matching.
- Both readiness surfaces additionally assert successful initialization and a stable matching revision across the database check. Existing deployment/ACL checks and no-admin-fallback behavior remain intact.

Thirty malformed-key fixtures cover missing/empty/malformed n/e, invalid or noncanonical base64url, zero/leading-zero/even values, bad exponent, wrong kty/alg, private members including undefined metadata, incompatible key_ops/use, 1024-bit RSA, duplicate kid, unsupported metadata, and a valid-plus-broken mixed set. Every fixture fails before readiness succeeds, without invoking token verification. Injected import/verification failures prove that metadata checks are insufficient by themselves. The PostgreSQL cases exercise both readiness surfaces under their actual restricted LOGINs.

The valid 3072-bit replacement tests cover initialization in progress, atomic visibility, caller mutation, older/newer overlapping initialization, retired keys, stale reconstructed service state, ACL and durable revision mismatches. Invalid-higher-revision races run three times in unit tests and three times with PostgreSQL rotation/replay. Existing replay and revocation races are retained. Token regressions include wrong signatures, tampering, unsigned/HS256 confusion, duplicate headers/claims, embedded key/certificate URL headers, exact issuer/audience/client/environment/context and scopes.

Final correction validation:

| Check | Result |
| --- | --- |
| Lint / TypeScript noEmit; build | Passed; built CommonJS provider module loads |
| Full unit suite | 471 passed; zero failures/skips |
| Focused provider-token suite | 76 passed; zero failures/skips; included in full unit suite |
| Focused provider / actual LOGIN PostgreSQL suite | 85 passed; zero failures/skips |
| Full PostgreSQL regression | 366 passed; zero failures/skips; includes the 85 provider cases |
| Rotation / replay races | Three invalid-replacement races per unit and PostgreSQL suite; existing replay and revocation races retained |
| Database fixture | Unchanged migrations 001–027 applied fresh; explicit role installation passed; no migration changes requiring separate migration validation |
| Whitespace / scope | git diff --check passed; correction changes only the seven provider source/test/documentation files |

The frozen source/test correction patch SHA-256 is `42a7607a56f90bc0241704ba76610f02da509214dda10802f95cc30de60cd8f3`. Exact corrective and combined patches, fingerprints, changed files, log hashes and the local commit are recorded in `/tmp/provider-keys-correction-audit-manifest.json`; logs use `/tmp/provider-keys-*.log`. Original evidence is preserved separately. The local corrective commit is a child of the reviewed commit; neither candidate is pushed by this correction.

Focused re-audit should confirm eager initialization and rejection before traffic, the 2048-bit floor and metadata/usage profile, both readiness dependencies, and atomic rotation without replay or chronology regressions. Remaining deployment/provider-selection observations from the accepted architecture are unchanged. No live integration, activation or deployment is part of this correction.
