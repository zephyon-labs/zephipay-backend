# Auth0 confirmation bridge V1 — independent audit handoff

Scope: the local, non-value Backend continuation on `feat/auth0-confirmation-bridge-v1`, based on `9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3`. Review the single feature commit relative to that base. The final external manifest supplies the exact commit, parent, tree, changed-file inventory, per-file SHA-256 values and binary patch SHA-256, avoiding a self-referential commit fingerprint in this document.

## Protected closure already completed

- Exact accepted predecessor: `94b0b3ba7bba9569d281c59b917caee05c44429f`, based on `4d9b6e4529559f480896278ea6d2a6e7eda670f7`.
- Independent verdict: ACCEPT. Exact combined patch SHA-256: `a2e4c0068047c1e1159b056e3052a8be0664914d00edfbbcdad326ab4f78f44a`.
- [Backend PR #8](https://github.com/zephyon-labs/zephipay-backend/pull/8) merged normally with required protected verification and matching accepted head; no bypass or semantic correction.
- [Required PR CI](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37167391801) and [canonical-main CI](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37167597739) succeeded.
- Merge `9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3` has the accepted tree. Canonical main equals origin/main and is clean. The merged worktree and local/remote predecessor branch were removed safely; normal metadata pruning completed.
- Phase B has not been pushed, opened as a PR, merged or deployed.

## Review map

| Files | Main responsibility |
| --- | --- |
| `src/economic/confirmation/confirmationBridge.ts` | Exact request parsing; authenticated service caller; canonical locks; Protocol binding; issue/roundtrip/confirm/recover; atomic admission |
| `src/economic/confirmation/confirmationPolicy.ts` | Pinned signed operator policy, registration, immutable policy identity, retirement and production claim gate |
| `src/economic/readiness/auth0Authentication.ts` | Small additive provenance/freshness recheck for already accepted reauthentication verification |
| `migrations/028_auth0_confirmation_bridge.sql` | Four durable tables, bounded state view, append-only and deferred commit guards |
| `sql/economic-database-roles-v1.sql`, `authorityPrivilegePolicy.ts`, `verifyAuthorityLogin.ts` | Exact issuer-only insertion columns and lock-only privileges; reader projection; actual-LOGIN verification remains fail-closed |
| `tests/auth0Confirmation.test.ts`, `tests/helpers/confirmationFixtures.ts`, `tests/postgresAuth0Confirmation.integration.ts` | Synthetic proof/profile fixtures, adversarial and durable PostgreSQL tests; no new transaction signing |
| `package.json`, `scripts/validate-migrations.ts` | New suite in normal PostgreSQL regression and explicit migration validation |
| `docs/auth0-confirmation-bridge-v1.md`, `docs/auth0-confirmation-profile-attestation-v1.json` | Architecture/operational contract and truthful local UNATTESTED record |

Existing migrations 001–027, package lock, generic provider token verifier, Protocol dependency pin and public Send wiring are unchanged. No other repository is modified. The ZERA baseline remains exactly 200,000,000 units with the same canonical allocation artifact and SHA-256 `182299950ae49c2bd2d8d5a99d2f73b3d0f77520982ab3c04ff8e2b9c1bbdff1`.

## Audit priorities

1. Trace the authenticated identity-service request to its canonical session; distinguish it from caller-supplied session IDs. The future client adapter must derive this session and explicit confirmation from trusted context.
2. Check issuer/subject account resolution, canonical payment principal, session chronology, account version and current attempt generation. Confirm Protocol owns the envelope digest.
3. Follow nonce, server transaction ID, exact envelope and fixed action across roundtrip and confirmation. Copied proof objects, callback substitution and another challenge must fail.
4. Check freshness against `auth_time`, configured ACR and both database/current provider time. No `iat` fallback or inference that a token proves a wallet signature.
5. Review head/account/session/policy/provider lock order, simultaneous confirmations and both revocation orderings. Examine the deferred commit guard after asynchronous provider checks.
6. Verify consumption/consent binding and rollback at both insertion points. Test crash-equivalent lost responses and object reconstruction without repeating confirmation.
7. Check operator registration privileges, policy retirement, configuration and key rotation. Historical projection must not be confused with current external provider readiness.
8. Check actual LOGIN ACLs, column provenance, append-only records and bounded reader exposure. No expanded Runtime/signer/observer authority is added by this bridge.
9. Verify source reachability: no production route imports the bridge. No wallet signing, exposure reservation, Runtime approval or settlement adapter is called by the new integration tests.
10. Preserve the explicit gaps: TEST fixtures are not tenant attestation; volatile transport ledgers are not durable replay; source inspection is not a live Site compatibility test.

## Validation and failure evidence

All new PostgreSQL cases use a dedicated disposable local PostgreSQL 16 database and distinct restricted fixture LOGINs. No real provider, production database, live signer, live observer or RPC endpoint is configured. The full existing regression contains historical offline dummy transaction-signing fixtures; the new bridge suite has no transaction-signing code and no signer/observer port attached.

| Validation | Result |
| --- | --- |
| `npm run lint` / TypeScript no-emit | PASS |
| `npm run build` | PASS |
| `npm test` | 607 passed, 0 failed |
| Focused Auth0 readiness, accepted correction and new confirmation unit tests | 136 passed, 0 failed; includes 13 new confirmation tests |
| `npm run test:postgres:confirmation` | 34 passed, 0 failed |
| All six actual restricted LOGINs | PASS within new suite |
| `npm run migrate:validate` | 28 ordered migrations validated |
| Fresh local migration and role installation | PASS |
| Full PostgreSQL regression | 412 passed, 0 failed |
| Checksummed migration reapplication | PASS; no migrations reapplied |
| Final `git diff --check` | PASS |

The initial 28-case development run had one fixture-setup failure: synthetic ACL tables expected by six-role verification were missing. The fixture now installs the existing synthetic schema without invoking its services. The subsequent 34-case suite passed. No ACL check was weakened. Commit-time expiry was strengthened before the final validation run; only the new uncommitted migration was revised, and this task's disposable database was rebuilt. Previously accepted migration bytes were not changed.

| Failure class | Demonstrated result |
| --- | --- |
| Lost creation response | Repeated same session/request ID returns same challenge, transaction and timestamps; another envelope conflicts |
| Authentication/callback without explicit confirmation | Zero consent records |
| Lost confirmation response / two instances | One committed consumption and consent; authenticated read recovers result |
| Duplicate confirmation / reconstructed process | Rejected from durable storage, including reverified old provider response |
| Concurrent confirmation | Exactly one winner, repeated three times |
| Revocation wins first | Confirmation rejects after canonical lock wait, repeated three times |
| Confirmation wins first | Revocation waits; immutable confirmed history remains, repeated three times |
| Account version/status, cancellation/replacement | Prior challenge becomes unusable |
| Wrong session/envelope/challenge/transaction/action/proof/nonce/subject/caller/environment | Rejected; no authority admitted |
| Missing/stale `auth_time`, missing/insufficient assurance, wrong issuer/client | Accepted adapter rejects callback |
| Provider/key/configuration/policy retirement | Old proof/policy or challenge rejected; mid-admission key retirement rolls back, repeated three times |
| Durable key revision changes during confirmation | Rotation waits for eligible confirmation transaction, then blocks old revision |
| Database-clock expiry and final readiness delay | No consent; deferred guard rejects expiry reached before commit |
| Database error inserting consent or consumption | Both records roll back; ISSUED recovery and safe later retry |
| Unattested/expired operator facts | Creation/use blocked; TEST and ATTESTED records still cannot claim production readiness |

## Reproduction

Use Node 22 and a new disposable PostgreSQL 16 database under a fixture administrator. Supply connection URLs without printing credentials. Run `npm ci`, lint/build/unit tests, migration validation, `npm run migrate`, `npm run db:economic:roles`, the confirmation suite and normal `npm run test:postgres` sequentially. Tests intentionally truncate their isolated fixture data. Do not point them at any shared or deployed database.

Use `TEST_DATABASE_URL` for test commands and `DATABASE_URL` for migration/role commands. Do not run live canary/provision/submission commands. `git diff --check <base> HEAD` must pass. Verify the patch's SHA-256 against the manifest before audit. Recompute the binary patch with `git diff --binary <base> HEAD`.

## Remaining gates and recommended next task

Actual tenant profile, allowed connections, required claims/scopes, ACR semantics, grant/refresh policy and deployed flow remain UNATTESTED. Pinned operator root selection, real deployment/TLS/workload evidence, durable shared service-transport replay, operational retention/quotas and a trusted client transaction adapter remain open. No browser session, mobile callback or real Auth0 roundtrip is claimed to have been tested.

Recommend independent audit of this exact local commit before any protected closure. After acceptance, the next architecture/integration task is an operator-attested Auth0 profile and isolated non-value identity/SDK transaction adapter, including durable transport replay. No live payment, custody, signing, settlement or ZERA activation is authorized by this handoff.
