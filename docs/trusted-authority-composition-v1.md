# Trusted session and restricted authority composition V1

This Backend-only package composes accepted economic foundations into an internal synthetic execution path. `createTrustedAuthorityComposition` is never imported by the server, mounted on a public route, or registered as a scheduler. Its explicit `synthetic-internal` mode and fixed synthetic producer identities do not provide a live activation flag. Protocol remains pinned to 0.4.0; canonical economic validation, message/signature inspection, network identity and finalization bindings continue to use that SDK.

## Compatibility and installation boundary

Affected repository: Backend only. Existing frontend/site consumers, public routes, receipts, environment contracts and Devnet workers are unchanged. No SDK release is required. The internal economic factory requires five separately authenticated operational database pools plus the existing identity persistence service. These roles are authority compartments; a process holding all five credentials is not a process-isolation security boundary.

Migration 026 must precede the updated role provisioning command and login verification. Future reviewed installation order is `npm run migrate`, `npm run db:economic:roles`, verification under each intended actual LOGIN, then internal composition startup. The role installer now requires migration 026 and remains privileged provisioning, never runtime fallback. Historical migrations 001–025 are unchanged by the ACL correction. The additive migration 026 creates the observer summary view and revokes prior app/reader group access to raw observer reports, including column grants; role provisioning then grants access to the view. Between those steps readiness fails closed. No production migration, login provisioning or deployment is authorized by this package.

The added session chronology check deliberately tightens eligibility: new consent and first contact require issuer-asserted token issuance at or after canonical session creation. Existing consent is never rewritten. Already-contacted operations keep same-operation recovery. A legacy never-contacted operation that fails chronology cannot gain contact; it is not automatically released merely because the new check rejects it. Reclamation still requires the accepted affirmative expiry/revocation evidence.

## Canonical sessions and consent

`CanonicalEconomicSessionService` delegates creation/revocation to the existing `IdentityPersistence` contract. Account version CAS, canonical `account_sessions` and `account_security_events` remain authoritative. Verified issuer, subject and provider session are bound through the existing immutable economic session-binding table. There is no parallel session store. The synthetic test identity-service LOGIN has only the existing identity-service grants it needs, independently of economic actors.

The caller of the internal binding adapter must supply verified provider context. Consent ingestion independently verifies the JWT issuer, audience, scope, subject, session and issuance/expiry claims; resolves the canonical account/session; checks exact envelope ownership and digest; and generates the consent ID on the server. Account/session locks, expiry, revocation and chronology are checked again for claim and first contact. A browser cookie, arbitrary bearer string or client-shaped consent cannot supply this authority.

The stored `authenticated_at` value is the verified issuer's JWT `iat`. It is evidence of token issuance, not proof of a fresh interactive login or `auth_time`. A future real provider integration must define issuance/reauthentication semantics and obtain an eligible token after creating the canonical session. This package does not choose reauthentication UX or loosen the comparison for second-resolution tokens. Timestamp offsets are compared as instants in the session adapter.

## Authority flow

| Actor | Permitted responsibility | Separate authority |
| --- | --- | --- |
| Existing identity service | Create/revoke canonical sessions with account-version CAS | Cannot commit economic signer contact |
| Application LOGIN | Prepare/claim operation; call approved contact, expiry and accounting functions | Cannot issue consent/Runtime evidence, write signed results or effect evidence |
| Issuer LOGIN | Bind verified sessions; ingest authenticated consent and fixed-source Runtime decisions | Cannot create reservations/finalizations or signer/observer results |
| Signer-result LOGIN | Query exact committed operation and persist verified signer outcomes | Cannot grant consent, first contact or finalized observer accounting |
| Observer LOGIN | Submit bounded effect/finality evidence through observer authority | Cannot grant consent, Runtime approval, signer contact or signer result |
| Reader/support LOGIN | Read bounded projections, history and incident reports | Cannot perform economic transitions or read stored artifact bytes through the reader views |
| Migration/admin | Provision reviewed schema/grants and disposable fixtures | Never substitutes for a runtime LOGIN |

The composed path is authenticated session → exact economic envelope → trusted consent → fixed-source Runtime evidence → durable claim → atomic contact authority → exact synthetic signer operation → verified result/recovery → synthetic observation → accepted finalized accounting. Issuance, policy, signing and settlement are separate stages.

Runtime, signer and observer source IDs are explicit constructor configuration and checked at startup. The Runtime adapter emits bytes through the existing authenticated-ingestion boundary, including negative fixtures for rejection, malformed evidence, wrong issuer/network/scope and envelope mismatch. Production transport authentication, credential rotation and provider replacement are open integration work.

## Synthetic adapters and recovery

Adapters live in `tests/helpers/syntheticAuthorityAdapters.ts`. Only the contracts and orchestration live under `src/economic/composition`. The disposable `economic_synthetic` schema is installed by the test harness, not product migrations.

The signer accepts only an existing finalization operation with its exact operation ID, tuple/message identity, customer-artifact digest and sponsor key identity/version. Test fixture setup uses known dummy keys to prebuild bytes outside the adapter. The adapter has no key storage, transaction-building method, arbitrary-sign interface, KMS/HSM, RPC or broadcast. Its immutable database operation record survives new adapter/composition instances. Querying an absent operation returns unknown; it never creates or replaces an operation.

The accepted contact grant is one-shot. After a crash immediately following contact commitment, recovery queries the same operation. If no external operation is known, exposure stays uncertain. The package intentionally does not infer that an unobserved signer call was harmless or retry it as a new first-contact action.

Signed bytes do not imply settlement. Unknown observer state remains pending; possible effect preserves uncertainty; only exact finalized evidence can charge accepted actual fee components. Finalized `settled` and `failed-onchain` labels use the Protocol 0.4.0 resolved-effect vocabulary. Observation is obtained from the fixed producer, never from a caller-supplied request body. The observer write and accounting call are separately durable; retry after the former reuses the same effect and completes accounting once.

## Contradictions and retained evidence

Migration 025 adds append-only observer reports, bounded signer-conflict reports and manual-review incidents. Observer reports retain both variants of conflicting source/reference evidence, their digests, disposition, database actor and time. Migration 026 separates the full forensic observer payload from the support projection. Only observer/admin authority retains direct access to `economic_observer_reports`; application and reader grants expose `economic_observer_report_summary`. The internal trace reads that view. Its 18 explicit columns contain report/finalization/effect identities, digest, disposition, database actor/time, bounded source/reference, enumerated observation state/outcome, bounded transaction/network identifiers and bounded numeric accounting strings. Nonconforming values become NULL. It does not return a raw `report` member, arbitrary additional keys or nested provider objects. Source/reference and other permitted identifiers remain visible as bounded strings; this is a typed projection rather than a general secret-redaction service. Existing incident/event semantics are unchanged.

Signer reports retain field excerpts/digests and bounded artifact bytes when available; reader summaries omit raw artifact bytes. Malformed non-JSON signer values receive an explicit marker. Input beyond the bounded object/byte contracts is rejected; this is not an unbounded forensic archive.

Mismatched operation/network/transaction/source, conflicting finality/amounts, effects before contact, and evidence after terminal expiry/refusal create incident history without granting new economic authority. Existing known accounting/release is preserved. A previous possible-effect transaction cannot be silently replaced by later apparently matching evidence. Signed or unclassified rejected late callbacks retain their original callback evidence and create an incident when a canonical finalization already exists.

Incident presence freezes further first contact, expiry/refusal release and finalized consumption for that operation. Truthful same-operation signed-result recovery may still be retained, without clearing the incident or granting settlement. There is no clear-incident or unfreeze API. Already released exposure cannot be retroactively made unreleased by an incident; reconciliation for a genuine late external effect remains a future operator policy. This scope supplies durable facts and a conservative stop, not user-facing dispute resolution.

A storage failure while persisting an otherwise valid signer response is recorded separately from a signer-evidence conflict. It keeps uncertainty and permits same-operation retry rather than creating a false permanent contradiction incident.

## Expiry worker and budgets

`NeverContactedExpiryWorker` offers explicit one-shot batches: default 25, maximum 100. It has no timer, lease, route or production registration. Selection is advisory and only chooses apparently invalidated never-contacted reservations without known contradictory evidence. Every selected ID goes through the existing authoritative expiry transaction and its locks. Duplicate workers/restarts converge; infrastructure failures propagate for retry. An affirmative selection result never grants release by itself.

Budget disablement blocks new reservations while preserving existing reserved/contacted recovery. Immutable budget versions retain original attribution, and exposure is summed across versions. Synthetic tests exercise active/disabled budgets, lowered versioned limits, existing recovery, expiry release and consumed costs. Production limits, replenishment and funding remain unselected.

PA-01 adds only `economic_authority_events(finalization_id,event_type)`. A transactional 20,000-row representative history fixture uses `ANALYZE` and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the actual expiry event predicate and asserts planner selection of this index; fixture data is rolled back. This proves suitability for that tested query/data shape, not a production latency SLO.

## ACL readiness

`npm run db:economic:verify -- app|issuer|signer|observer|reader` connects using `DATABASE_URL` for that actual LOGIN. Do not place credentials in logs or command history. The optional `--synthetic-fixtures` flag permits only the exact test schema grants needed by synthetic signer/observer adapters. Normal verification does not require synthetic tables.

The verifier reads PostgreSQL catalogs without `SET ROLE` or corrective writes. Authority-relevant relations are ordinary tables (`r`), partitioned tables (`p`), views (`v`), materialized views (`m`) and foreign tables (`f`) in the current database, across `public` and every other schema except `information_schema` and names starting with the literal `pg_` prefix. A user schema such as `pgscope` remains inspected. Sequences (`S`) have a separate privilege check; indexes/TOAST objects are not independent table-authority entries. This does not inspect relations in other databases or query foreign data. Actual schema/name pairs are separate lookup keys: duplicate names across schemas and quoted names containing dots cannot borrow another relation's policy. Its explicit checked-in allowlist is independent of observed live grants. It checks effective identity, unsafe role attributes, exactly one intended role membership, inherited privileges, schema/database ownership or CREATE, required/forbidden table and column grants, PUBLIC leakage, function execution/ownership/pinned definer paths, and schema-qualified sequence privileges. Missing expected objects/grants fail. The relation inventory is bounded to 20,000 entries and fails closed above that limit. Each live column contributes one entry; a zero-column relation retains one entry for ownership and table/PUBLIC checks. Foreign relations use the same independent role allowlist as ordinary relations: effective SELECT/INSERT/UPDATE/REFERENCES column grants, forbidden DELETE/TRUNCATE/TRIGGER grants, direct/inherited ownership and PUBLIC table/column ACLs are checked. Their presence alone with no unapproved authority is permitted; there is no foreign-table trust exception. The five economic LOGINs are verified individually. The separate canonical identity service has no economic verifier role; no new identity-service privilege model is introduced.

Factory construction and every composed economic stage recheck readiness for five distinct logins. Drift fails readiness; the unmounted consent router returns a bounded 503. Database grants and transition guards remain authoritative between checks. This is a point-in-time ACL assessment, not protection against a compromised administrator or arbitrary out-of-band schema/function replacement.

## Audit and validation boundary

The reader trace reconstructs current canonical session/account state and session security events, original consent and Runtime IDs, intent/generation, contact status, signer operation/result identity, observer reports, exposure/version/accounting, expiry and incidents. Economic authority events provide ordered transition evidence. Tokens, provider secrets and signing bytes are not printed to operational logs.

The integration suite uses actual restricted LOGIN connections, an additional restricted identity-service login, dummy credentials and a disposable local PostgreSQL cluster. Privileged setup creates fixtures and injects deliberate faults only. Multi-instance tests discard composition objects and reconstruct from durable storage; no economic correctness claim depends on process-local response memory.

Unresolved real integrations are provider token/session issuance, isolated credential deployment, real Runtime authentication, custody/signing implementation, external observer finality proof, incident reconciliation, production budget values and scheduler operation. OBS-04 independent Protocol vector-generator provenance remains deferred Protocol maintenance. Independent audit is the next gate; there is no Phase B push, PR, merge, deployment, Mainnet entry, live signer/observer, sponsorship funding or ZERA activation.
