# Provider session and credential readiness V1 — audit handoff

Status: READY FOR INDEPENDENT AUDIT.

Scope: Backend readiness only. See [architecture and trust boundaries](provider-session-credential-readiness-v1.md) for the provider contract, chronology, freshness, ownership matrix, rotation, compromise assumptions and unresolved integrations.

## Predecessor closure

- PR: https://github.com/zephyon-labs/zephipay-backend/pull/6
- Accepted exact head: `37df91c9b438df83adfc2e9fb775dcf00417fe32`.
- Audited predecessor patch: 21 files, +1,448/−24; SHA-256 `da01dbf77f6fc761f839a63252eba36f678f4c896d8da78f3f6c89d75fb3ec9f`.
- Required hosted verification: https://github.com/zephyon-labs/zephipay-backend/actions/runs/37085523287, successful.
- Normal protected merge, no bypass and no candidate edits. Canonical merge: `745b363e1df973c8923a1a848c2c0d62de5a4e42`.
- Canonical local main was fast-forwarded, clean, identical to origin and the accepted tree. No deployment was invoked.
- OBS-04 remains deferred Protocol maintenance.

## Candidate

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

Final validation on this candidate:

| Check | Result |
| --- | --- |
| Lint / TypeScript noEmit; build | Passed; built CommonJS provider module loads |
| Unit tests | 423 passed, including 28 provider-token cases; zero failures/skips |
| Focused provider / actual LOGIN integration | 49 passed; zero failures/skips |
| Full PostgreSQL regression | 330 passed, including the 49 provider cases; zero failures/skips |
| Race / failure repetitions | Replay and revocation-during-verification each repeated three times; rotation rollback and reconstruction covered |
| Migrations | 27 validated and applied fresh; 026→027 upgrade and role provisioning preserve seeded records |
| Whitespace / scope | git diff --check passed; no historical migration or mounted route changes |

The frozen implementation-only patch SHA-256 is `f5706f2226323e16a164081c9878fb4c03cace2b677a5e450742dbc6846504e4` (src/sql/migrations/tests/package/scripts; excludes these documentation files).

The exact candidate patch manifest and local commit are recorded at closure in `/tmp/provider-readiness-audit-manifest.json`. Logs use the `/tmp/provider-readiness-` prefix. They contain no real credentials or bearer tokens.

Fresh disposable database: migrations 001–027 applied, explicit role installation successful. Separate 026→027 upgrade fixture preserved all six seeded account/identity/session/security-event rows exactly; SHA-256 `ab0140967f84e83261f6fea63bc769b4bca2d17af7fedfa032d3d1dfd3247af0`. Historical migrations 001–026 are byte-for-byte unchanged in Git.

Intermediate failures were test issues: an assertion expected frozen-object assignment to throw under the test runner; a fixture session timestamp predated its account update; one fault-injection SQL parameter needed explicit UUID/text casts. All corrections remain in this candidate. No failure was suppressed, no security gate was disabled, and no real endpoint or production secret was used.

## Boundaries and next package

No live provider account, real signer/observer, wallet route, Mainnet operation, funding or transfer. Existing Devnet routes and wiring remain unchanged; the shared canonical identity refactor is covered by regression. No ZERA registration, qualification, activation, mint, distribution, staking or liquidity. The canonical 200M economic baseline SHA-256 remains `182299950ae49c2bd2d8d5a99d2f73b3d0f77520982ab3c04ff8e2b9c1bbdff1`.

Next: independent security/architecture audit of this local candidate. After acceptance, separately choose and verify a real provider adapter, authenticated inter-service transports, production freshness/key-rotation policy, secret-manager/process isolation and emergency revocation procedures in non-value staging. Live economic integration requires a later explicitly scoped package.
