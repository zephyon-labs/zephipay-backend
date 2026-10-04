# Auth0 confirmation bridge V1 — focused corrective re-audit

Scope: the local, non-value Backend candidate on `feat/auth0-confirmation-bridge-v1`, based on canonical `9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3`. Original audited commit: `6930f211688c7b0602bb4322913f06ec87daf565`. Its verdict was **REVISE BEFORE MERGE**, with AUD-CONF-01 P1 and AUD-CONF-02 P2. Review the one corrective commit and the combined candidate. The external audit manifest supplies the exact commit/parent/tree, changed-file inventory, per-file hashes and both binary patch fingerprints without creating a self-referential commit hash in this document.

**Current closure status: CORRECTION REQUIRED.** The scoped confirmation suite passes 86/86, but required full PostgreSQL validation is not clean in this environment. The complete first run passed 463/465; the two failures passed in isolation, while one bounded full retry hit a different unchanged expiry test and was stopped. A PostgreSQL clock trace independently recorded a 0.771709-second backward step. Do not treat this package as ready for focused re-audit until the full suite passes under stable clock conditions. No accepted finalization/Runtime/provider implementation or existing downstream test was modified to mask these failures.

## Prior protected closure

The accepted provider-readiness predecessor `94b0b3ba7bba9569d281c59b917caee05c44429f` merged normally through [Backend PR #8](https://github.com/zephyon-labs/zephipay-backend/pull/8). [PR verification](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37167391801) and [main verification](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37167597739) passed. Canonical main is `9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3`. This bridge candidate and correction remain local: no push, PR, merge or deployment.

## Findings and correction

| Finding | Root cause | Corrected contract |
| --- | --- | --- |
| AUD-CONF-01, P1 | Issuer INSERT grants made terminal-shaped challenge/consumption/consent rows possible without the service ceremony. Nullable reauthentication JSON and incomplete database policy/provenance checks allowed stale and fabricated evidence. | Remove direct confirmation mutation grants, including old column grants. Guard challenge issuance and terminal admission under the existing NOLOGIN administrative owner. A separate existing identity credential registers mandatory scalar provider evidence; issuer cannot register it or write terminal rows. |
| AUD-CONF-02, P2 | `SET CONSTRAINTS ALL IMMEDIATE` can run deferred expiry triggers before the physical commit; waiting afterwards invalidated the claimed invariant. | Model B: database-observed, locked admission before expiry; consent expiry bounded by the challenge. Late visibility can preserve historical CONFIRMED while the already expired consent is immediately downstream-ineligible. No physical-COMMIT-time promise remains. |

See the [architecture contract](auth0-confirmation-bridge-v1.md) for exact function signatures, ACL inventory, credential trust and migration ordering. PostgreSQL documents early [constraint scheduling](https://www.postgresql.org/docs/16/sql-set-constraints.html) and [security-definer hardening](https://www.postgresql.org/docs/16/sql-createfunction.html).

## Review map

| Files | Corrective responsibility |
| --- | --- |
| `migrations/029_confirmation_database_authority.sql` | Mandatory scalar proofs, configuration rules, admission records, canonical locks/validation, guarded operations, root-only markers, legacy quarantine, support projection, legacy table/column grant revocation and removal of the false expiry guard |
| `sql/economic-database-roles-v1.sql`, `src/economic/composition/authorityPrivilegePolicy.ts` | NOLOGIN ownership, exact EXECUTE grants, private helpers/tables, issuer read-only challenge/consumption privileges, identity-only proof registration |
| `src/economic/confirmation/confirmationProofAuthority.ts` | Accepted access/reauthentication verification in the separate identity compartment; exact confirmation-body digest registration |
| `src/economic/confirmation/confirmationBridge.ts` | Existing authenticated service contract with guarded SQL issuance/admission and an internal opaque proof reference |
| `src/economic/confirmation/confirmationPolicy.ts` | Persist the configuration revision from the already verified deployment alongside the immutable signed policy |
| `tests/postgresAuth0Confirmation.integration.ts` | Actual restricted LOGIN negative/positive matrix, mandatory evidence, atomicity, late commit, bounded races, recovery and downstream expiry |
| `tests/postgresConfirmationUpgrade.integration.ts` | Actual 028-to-029 upgrade with old malformed terminal rows, historical row preservation, consent quarantine, repeat migrations and role provisioning |
| `package.json`, `scripts/validate-migrations.ts` | Include the upgrade test in normal PostgreSQL regression and recognize migration 029 |
| Architecture and this handoff | Corrected trust/expiry claims and focused re-audit evidence |

Migrations 001–028, package lock, accepted Auth0 verification, provider/readiness implementation, generic evidence ingestion, finalization, signer/observer implementation, Protocol v0.4.0 dependency and public Send wiring are unchanged from the audited commit. The combined candidate retains the original accepted-verifier provenance addition relative to canonical main; this corrective commit does not revise it. No other repository is modified. ZERA's baseline SHA-256 remains `182299950ae49c2bd2d8d5a99d2f73b3d0f77520982ab3c04ff8e2b9c1bbdff1`.

## Security review priorities

1. Verify every ordinary LOGIN lacks direct challenge/consumption/proof/admission mutation, and cannot use reserved bridge consent/audit markers. Confirm column privileges as well as table privileges. The existing generic consent authority is deliberately preserved outside the bridge markers.
2. Trace identity-only attestation and issuer-only issuance/admission through actual registered `session_user`, credential generation, pinned search paths and NOLOGIN ownership. Helpers and proof tables must remain private. PostgreSQL checks canonical data and evidence scalars; it does not verify JWT signatures. The trusted identity application owns that cryptographic step. A single issuer LOGIN cannot invent the missing identity attestation; a single identity LOGIN cannot admit terminal state. Joint compromise and administrator control are outside this single-credential claim.
3. Compare account/principal/session/version, current intent/generation, environment, stored Protocol envelope, server transaction ID, fixed action, immutable current policy, configuration fingerprint/revision, provider revision, nonce, exact body digest, freshness and assurance at guarded admission. Identity proof registration also checks the body transaction ID against the challenge. Reload and lock the attempt after acquiring the intent head so a cancellation/finalization committed during the wait cannot leave a stale OPEN snapshot. Caller comparisons cannot replace stored truth.
4. Check explicit non-null proof fields and exact stored reauthentication structure. Empty JSON, omitted/null security fields and unapproved assurance must fail independently of service parsing. Approved labels are trusted only as an identity-verifier attestation, never accepted from issuer/browser JSON.
5. Review serialized canonical revocation/version ordering, duplicate challenge/proof constraints and atomic consent/consumption/admission/audit insertion. Proof registration may remain after a failed terminal transaction; it grants no authority alone.
6. Reproduce valid admission, early `SET CONSTRAINTS ALL IMMEDIATE`, wait beyond challenge expiry and commit. History may say CONFIRMED; expired consent must grant no subsequent claim, first-contact, sponsor-finalization, signing or submission authority. Preserve accepted recovery semantics for operations already contacted while valid.
7. Review 028 upgrade quarantine: immutable challenge/consumption rows retained byte-for-byte, only linked consent revoked, generic unlinked consent untouched, old rows never promoted to CONFIRMED. New policy-rule registration is required before new ceremonies.
8. Verify source reachability and unchanged economic boundaries. No public route imports the bridge, and no new code invokes Runtime approval or a signer/observer port. TEST fixtures, volatile transport replay ledgers and local multi-role fixtures are not a real tenant or deployment-isolation attestation.

## Validation evidence

All PostgreSQL commands target a disposable local PostgreSQL 16 fixture. Distinct actual restricted LOGIN connections exercise identity, application, issuer, signer-result, observer and reader roles. Suites run sequentially because they reset fixture data. No real Auth0, production credentials, deployed database, live signer, observer or RPC endpoint is configured.

The existing full regression includes historical offline dummy transaction-signing fixtures. This correction adds no transaction signing. The new downstream test uses a privileged pre-contact database fixture with a deliberately non-valid dummy artifact and a throwing signer spy; it never represents that fixture as a verified customer signature. It tests the shared authoritative loader used by claim/sponsor-finalization, the real SQL first-contact gate, and recovery before signer invocation. Existing full regression supplies the unchanged complete claim-path coverage.

| Validation | Result |
| --- | --- |
| `npm run lint` / TypeScript no-emit | PASS |
| `npm run build` | PASS |
| `npm test` | 607 passed, 0 failed |
| Focused readiness, accepted artifact correction and confirmation unit tests | 136 passed, 0 failed |
| `npm run test:postgres:confirmation` | 86 passed, 0 failed |
| All six actual restricted LOGINs | Included in confirmation and normal PostgreSQL suites |
| `npm run migrate:validate` | 29 ordered migrations validated |
| Fresh local migrations and role installation | PASS |
| Explicit 028-to-029 historical-row upgrade | 1 passed, 0 failed |
| Checksummed repeat migration and repeat role installation | PASS in upgrade test |
| Isolated retry of the two unchanged timing-related failures | 2 passed, 0 failed; no implementation changes |
| Full PostgreSQL regression | NOT CLEAN: complete run 463/465; 2 isolated retries passed; bounded full retry stopped after another unchanged expiry failure |
| Final `git diff --check` | PASS |

Development failures are retained in the external manifest. An upgrade fixture initially omitted an existing required session binding; adding that fixture prerequisite resolved it. Synthetic callbacks, endpoint attestations and service messages encountered timing rejections; final fixture issuance uses a small validity margin, without changing production verification. A database-expiry test also woke before the PostgreSQL deadline when using the application clock; final deadline waits and expiry assertions use PostgreSQL clock observations. One targeted run accidentally overlapped a resetting confirmation suite and failed in setup; that run is discarded and final suites run sequentially. Intermediate runs were stopped during final review to add explicit transaction binding and reload the attempt after lock waits; only the uncommitted 029 migration changed, and the correction database was rebuilt before final validation. The first full regression passed 463/465, with two failures in unchanged signer recovery and short-lived-intent setup. An independent 100-sample PostgreSQL clock trace observed time moving backward by 0.771709 seconds. The two cases passed in isolation. The one bounded full retry then failed `expired intent and Runtime evidence deny contact; expiry selection remains advisory` with a missing expected rejection after an application-clock wait, and was stopped. These failures are consistent with the independently observed clock instability, but the exact cause of each failure is not independently proven; the original log and clock trace remain audit evidence. No security assertion, ACL check or downstream expiry check was relaxed.

| Regression | Evidence |
| --- | --- |
| Direct terminal fabrication | All six LOGINs denied direct confirmation-table writes and reserved bridge consent/audit writes; unsupported guarded functions denied |
| Guarded positive path | Separate accepted identity proof then issuer admission; exactly one admission and consumption |
| Negative evidence matrix | Empty JSON; missing/null auth time, assurance, provider evidence, nonce, transaction ID and digests; unapproved assurance; wrong nonce/session/envelope/transaction/body; stale provider/policy/config/account evidence and retired identity credential generation rejected |
| Legacy malformed stored challenge | Empty requirements, stale account/provider/configuration/policy rejected; existing account/principal constraint also preserved |
| Partial terminal writes | Injected failure at consent, consumption, admission and audit leaves zero terminal authority; valid retry succeeds |
| Expiry model B | Early constraint scheduling and late commit retain history but expired consent fails the shared authority loader; fresh Runtime cannot substitute; SQL first-contact and recovery reject, signer calls zero |
| Bounded races | Three repetitions each for concurrent confirmation, revocation orderings and account-version advancement; cancellation lock waits under Read Committed and Repeatable Read; duplicates rejected from durable storage |
| Multi-instance recovery | Lost response and reconstructed service recover the same durable admission; no process-local terminal authority |
| Migration/repeat | 028 fabricated-shaped history remains immutable, linked consent revoked, generic consent unchanged, LEGACY_UNVERIFIED projection, old column grants removed, 29 checksums, repeated provisioning |

## Reproduction and artifact boundary

Use Node 22 and a new disposable PostgreSQL 16 database under a fixture administrator. Supply connection URLs without printing credentials. Run lint/build/unit tests, migration validation, migrations through 029, role provisioning, confirmation tests, upgrade test and full PostgreSQL tests. Use `TEST_DATABASE_URL` for tests and `DATABASE_URL` for migration/role commands. The upgrade test creates and drops its own disposable database, so its fixture administrator requires that authority. Do not point these truncating fixtures at a shared or deployed database; do not run two suites on the same fixture concurrently.

The original audit package is preserved at `/tmp/auth0-confirmation-bridge-v1-audit`. The corrective package is `/tmp/auth0-confirmation-bridge-v1-correction-audit`. Recompute its two patches with `git diff --binary 6930f211688c7b0602bb4322913f06ec87daf565 HEAD` and `git diff --binary 9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3 HEAD`, then compare SHA-256 values to the updated manifest. The manifest records exact final validation, development failures and unchanged-boundary hashes. Do not run canary, live provisioning or submission commands.

## Remaining gates

Actual tenant profile, allowed connections, claims/scopes, ACR semantics, grant/refresh policy and deployed flow remain UNATTESTED. Operator root selection, real deployment/TLS/workload and identity/issuer isolation, durable shared service-transport replay, operational retention/quotas and a trusted explicit-confirmation client transaction adapter remain open. No browser/mobile or real Auth0 roundtrip is claimed.

First obtain a clean full PostgreSQL regression in a stable clock environment. The correction cannot yet be declared ready. Then recommend focused independent re-audit of AUD-CONF-01/AUD-CONF-02, the new dual-credential trust boundary, the precise admission-time expiry model and migration quarantine before protected closure. After acceptance, the next bounded task remains an operator-attested Auth0 profile and isolated non-value identity/SDK transaction adapter with durable transport replay. Stop after the local corrective commit and audit artifacts; this handoff authorizes no deployment, live payment or ZERA activation.
