# Non-value Auth0 attestation and durable confirmation bridge V1

This package connects accepted Auth0 proofs to the existing economic-consent table through an unmounted issuer service. It creates consent evidence only. It does not create Runtime approval, reserve exposure, finalize an operation, sign a transaction, submit to a chain, observe settlement, or activate a wallet route. ZephiPay remains usable without ZERA.

Base: `9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3`. Branch: `feat/auth0-confirmation-bridge-v1`. The base contains the exact independently accepted provider-readiness package merged through Backend PR #8. This continuation requires its own independent audit and remains local.

The original candidate `6930f211688c7b0602bb4322913f06ec87daf565` received REVISE BEFORE MERGE: AUD-CONF-01 (P1, direct issuer SQL could fabricate confirmation) and AUD-CONF-02 (P2, deferred expiry checks could run before physical commit). Migration 029 and the local corrective commit address these findings. The corrected expiry contract is admission-time eligibility, described below; it is not a physical-COMMIT-time guarantee.

The full-validation gate remains uncleared: the scoped 86-case confirmation suite passes, but unchanged downstream tests encounter timing failures in an environment with observed backward PostgreSQL clock movement. See the [corrective handoff](auth0-confirmation-bridge-v1-audit-handoff.md) for exact results and the CORRECTION REQUIRED status.

## Status and trust claims

| Area | Status | Evidence and limit |
| --- | --- | --- |
| Challenge, consumption, consent and recovery | Implemented; corrected candidate awaiting re-audit | Guarded PostgreSQL admission, immutable records and separate identity/issuer LOGINs |
| Auth0 proof provenance | Implemented | Accepted adapter plus private provenance for its reauthentication results; no new JWT dialect |
| Authenticated identity-to-issuer invocation | Implemented local seam | Accepted signed service transport with exact body, caller, recipient, deployment and credential generations |
| Browser/mobile provider roundtrip | Backend contract implemented; client integration modeled | Server transaction ID and nonce, canonical session and envelope binding; no SDK or Site wiring |
| Auth0 tenant/domain/audience/client, connections, grants, assurance | UNATTESTED | See [nonsecret local record](auth0-confirmation-profile-attestation-v1.json) |
| Operator attestation | Mechanism implemented; actual tenant attestation deferred | Signed nonsecret artifact, pinned public root and fingerprint, append-only registration and monotonic policy head |
| Confirmation replay | Durable | PostgreSQL challenge primary key and consumption record survive service reconstruction |
| Service-transport replay | Deferred for production | Existing ledger interface; tests use explicitly volatile ledgers. Confirmation durability does not close this separate gap |
| Production readiness | Refused | `confirmationProductionGate` always returns false for this non-value package, including TEST or fully ATTESTED policy records |

Only Backend changes. No SDK export, public API route, environment variable, receipt format, Site contract, or ordinary Send behavior changes. Protocol remains pinned to v0.4.0. No dependency change is required. Future deployment order, after separate review: migrations through 029 under administrative authority, updated role provisioning, policy registration with its verified configuration revision, issuer/identity readiness verification, then separately audited client wiring. The updated role installer requires 029. Stop the old confirmation service before upgrading: its direct writes intentionally fail after 029. No deployment is performed here.

## Five independent kinds of evidence

1. Authentication establishes the provider issuer/subject and a verified access-token context.
2. Reauthentication establishes `auth_time`, accepted assurance and a response to the server nonce. `iat` is never substituted for `auth_time`.
3. Economic confirmation is an explicit authenticated identity-service action for one server transaction and one immutable economic envelope.
4. A wallet/customer signature is a separate future asset authorization. This bridge never requests or produces it.
5. Runtime approval remains independent. A consent record cannot supply the missing Runtime decision or authorize payment by itself.

The accepted Auth0 adapter still verifies RS256 default-profile tokens, issuer, audience, client, scope, NumericDate bounds and current pinned key snapshot. A new WeakMap records only metadata for reauthentication results produced by that verifier. A copied object is rejected. After reconstruction, an unconsumed callback must be verified again; already consumed challenges remain rejected by PostgreSQL regardless of process memory.

Auth0 documents validation of `auth_time` for reauthentication, and cautions that upstream federation can affect what freshness proves. This package therefore does not infer a fresh human interaction from `prompt` or token issuance. Allowed connections and assurance semantics require operator evidence. See [Auth0 reauthentication](https://auth0.com/docs/authenticate/login/max-age-reauthentication) and [access-token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles).

## Canonical identity and envelope

The issuer resolves `(configured issuer, verified subject)` through `external_identities`, then locks the canonical account and `account_sessions` row. It verifies ACTIVE status, ownership, session creation/expiry/revocation and access-token chronology. Email, provider subject alone and caller-supplied issuer/client/environment do not establish identity.

The canonical payment principal is the existing immutable `accounts.actor_subject` (`zp:account:<uuid>`), matching the Protocol envelope principal. This is not a new identity namespace or proof of wallet ownership. The separate economic profile is not substituted for the canonical account/session.

The bridge loads the stored envelope and recomputes its binding with Protocol v0.4.0 `authorizationBindingDigestV1`. The current attempt head, generation, ownership, OPEN state, validity and existing asset/network qualification must pass. Only devnet envelopes are eligible for this non-value seam. Amount, asset and recipient are not duplicated as independent challenge truth. Cancellation or replacement invalidates further confirmation of the prior attempt.

Account version is stored and compared at use. Canonical sessions have no separate numeric version in the accepted schema: session identity, creation, expiry and revocation are checked directly; account version advances through canonical lifecycle operations. New session creation can conservatively invalidate an older challenge.

## Transport-neutral contract

All operations are POST messages on the accepted authenticated service transport, recipient `issuer`, caller `identity`. They are in-process test seams, not mounted HTTP routes. A current accepted access proof and endpoint attestation are required. Responses are authenticated using the same transport contract.

| Operation | Signed request body, in addition to `accountSessionId`, `envelopeDigest`, `authenticationDigest` | Effect |
| --- | --- | --- |
| `/confirmation/start` | `requestId` (client correlation UUID only) | Server creates challenge UUID, transaction UUID, random 256-bit nonce and immutable policy/context; returns bounded summary and transaction reference |
| `/confirmation/roundtrip` | `challengeId`, `transactionId` | Returns the stored reauthentication challenge only to the trusted identity service |
| `/confirmation/confirm` | `challengeId`, `transactionId`, fixed `action: confirm-economic-intent`, `reauthenticationDigest` | Requires the corresponding verifier-produced reauthentication proof; atomically admits consent and consumption |
| `/confirmation/recover` | `challengeId`, `transactionId` | Reads the same session's stored outcome; never consumes or extends it |

Before confirmation, the identity compartment's `ConfirmationProofAuthority.record` verifies the accepted access and reauthentication proofs, the exact confirmation body and endpoint readiness, then calls `economic_record_confirmation_proof`. The issuer receives the resulting opaque proof UUID as an internal argument, in addition to the existing authenticated body and proofs. It admits only the corresponding request digest. Proof registration alone creates no consent. A failed later admission can leave an unconsumed proof; retry still requires current canonical eligibility and unexpired evidence.

Exact-object parsing rejects additional authoritative fields, duplicate JSON keys and missing fields. The caller can nominate an existing envelope/session, but cannot set nonce, account/version, policy, issuer, environment, challenge identity or deadlines. The signed request binds the access-token digest; confirmation also binds the verified callback digest. A refreshed access token is allowed only after canonical and scope checks; original and confirmation authentication references remain separately recorded.

The trusted identity adapter must derive the canonical session from its authenticated session authority, never a browser field. It must retain the server transaction reference in the SDK's server-side transaction context, validate SDK state/PKCE/callback binding, and present the exact canonical envelope for an explicit user action. Only then may it sign `/confirmation/confirm`. Callback success itself is not confirmation. The bridge rejects another session, transaction, challenge, envelope, action, nonce or provider proof. Possession of a bearer token plus browser-shaped proof does not supply the signed identity-service request.

This package does not implement or attest that future identity adapter, browser CSRF/transaction store, mobile deep-link handler or SDK callback integration. Those are mandatory before mounting any route. No Auth0 SDK internals are changed. Cookies are not part of economic challenge identity; future iOS/Android adapters must preserve the same canonical semantics.

## Database authority and credential boundary

| Credential | Permitted confirmation operation | Denied authority |
| --- | --- | --- |
| Identity/session | `economic_record_confirmation_proof(uuid,jsonb)` after accepted provider verification | Challenge issuance, terminal admission, direct proof/challenge/consumption/admission writes, consent insertion |
| Issuer | `economic_issue_confirmation(uuid,uuid,text,jsonb)` and `economic_admit_confirmation(uuid,uuid,uuid,text,uuid,text)`; existing bounded reads | Proof attestation, proof-table reads, direct challenge/consumption/admission writes |
| Application, signer-result, observer | No confirmation mutation function | All direct confirmation mutation and terminal admission |
| Reader/support | `economic_confirmation_summary` only | Raw challenges/nonces/proofs and all confirmation mutations |
| Migration administrator / `zephipay_economic_admin` NOLOGIN owner | Trusted schema, policy, ACL and function control plane | Not an ordinary operational credential |

Migration 029 revokes both table-level and column-level legacy INSERT/UPDATE grants. Provisioning resets the complete operational ACL and grants only the listed functions. Their owner is the existing NOLOGIN administrative role, with a pinned `pg_catalog,public,pg_temp` search path and no PUBLIC EXECUTE. Internal helpers are not operational entry points. Each entry function checks the actual `session_user` against the registered role and credential generation. See PostgreSQL's [security-definer guidance](https://www.postgresql.org/docs/16/sql-createfunction.html).

Root-only insert triggers also protect the confirmation tables, the reserved `zephipay:canonical:` consent-session prefix and the `auth0-confirmation-bridge` audit actor. Existing generic consent, session-binding and audit privileges remain available outside those reserved bridge markers. Generic trusted consent remains a separate accepted authority; it cannot create a bridge admission or make the support projection report CONFIRMED.

PostgreSQL does not verify Auth0 JWT signatures. The existing identity compartment is the trusted provider-proof attestor; the accepted Auth0 verifier performs cryptographic validation. SQL independently checks mandatory scalar evidence, policy, nonce, freshness and canonical state. The issuer credential cannot manufacture that attestation, and the identity credential cannot consume it into terminal confirmation. Compromise of both credentials or the trusted identity application is outside the claim that one operational SQL credential cannot fabricate the complete ceremony. Separate process/credential isolation remains a production requirement; local tests share synthetic provider fixtures, not a deployed isolation attestation.

## Durable records and state

Migration 028 adds:

- `economic_confirmation_policies`: signed nonsecret artifact, fingerprint, deployment, policy revision, database actor and recorded time; append-only.
- `economic_confirmation_policy_heads`: one administrator-managed monotonic revision per deployment. Issuer can lock but cannot advance or rewrite it.
- `economic_confirmation_challenges`: challenge/request/transaction IDs; canonical account, principal, session and account version; envelope, intent/generation and fixed action; environment, issuer/subject; configuration fingerprint/revision, policy fingerprint/revision and provider-key revision; original authentication digest; server nonce; database request time, expiry and immutable reauthentication requirements. Append-only.
- `economic_confirmation_consumptions`: one row per challenge, unique existing consent reference, authentication/callback/request digests, actual `auth_time`, assurance, confirmation and expiry times, database actor. Append-only.
- `economic_confirmation_summary`: bounded support projection without nonce, token or raw provider artifact.

Migration 029 preserves those historical rows and adds:

- `economic_confirmation_policy_rules`: immutable verified deployment-configuration revision associated with the signed policy fingerprint; administrator registration only.
- `economic_confirmation_proofs`: immutable identity attestation with non-null typed access/reauthentication digests and timestamps, actual authentication time, assurance, nonce, exact request digest, provider/configuration/policy identity, and actual verifier LOGIN/generation.
- `economic_confirmation_admissions`: immutable one-use challenge/proof/consent link, database admission time and actual issuer LOGIN; inserted only by guarded terminal admission.

`ISSUED` means there is an eligible unconsumed record. `CONFIRMED` requires the protected admission record together with the linked consumption and consent; it records completed historical admission, never current payment eligibility or execution. `EXPIRED` is derived from database time. `INVALIDATED` is derived from canonical status/version/revocation, current generation/attempt state, policy head, configuration revision or durable key revision. Expired records take precedence over invalidation; historical CONFIRMED records take precedence over later expiry/revocation. The view describes local durable state, not a live provider-readiness probe. It cannot observe an external snapshot-head change before the local deployment revision is advanced; use still checks both sources and fails closed.

Existing 028 consumptions have no trustworthy admission provenance and project `LEGACY_UNVERIFIED`, never CONFIRMED. Upgrade retains their challenge and consumption bytes and revokes their linked consents through the existing revocation field; unrelated generic consents remain unchanged. They require a new ceremony, not automatic backfilling of admission. Registering the current verified policy also supplies the new configuration-revision rule. This conservative migration prevents old terminal-shaped rows from inheriting trust.

There is no expiry worker or destructive rewrite of history. Recovery requires a currently valid authenticated canonical session. Later account-version changes do not hide committed history from an otherwise still-valid session. A revoked session cannot recover through the user path; authorized support retains the bounded projection. Support state is observational and cannot confer authority.

## Atomicity, locks and time

The issuer's guarded function uses one PostgreSQL transaction for session binding, consent insertion, challenge consumption, admission and audit. Identity proof registration is a separate preceding transaction. Canonical locking follows intent head, account/session, policy head and deployment provider revision; registered credential generations and qualified registry rows are also locked. This preserves existing attempt and canonical revocation ordering. Head locking serializes simultaneous confirmations; unique challenge/proof/consent links enforce durable one-use admission.

Both proof registration and terminal admission independently reload canonical state. They compare account/principal/session, account version, intent/generation, OPEN state, environment, exact stored Protocol envelope reference, fixed action, policy fingerprint/revision, configuration fingerprint/revision, current provider revision, issuer/subject mapping and all validity bounds. Stored reauthentication JSON must exactly match the challenge's derived nonce and requirements; empty or missing members fail. Required proof fields are explicitly non-null and converted into typed columns. Assurance must belong to the immutable challenge policy, which must still be current. Supplied values are comparisons against this state, not a replacement source of truth. The service also recomputes the envelope digest using Protocol; SQL trusts the existing immutable envelope/digest registration rather than introducing another Backend digest algorithm.

Consent is inserted into the existing `economic_consent_evidence` schema. `authentication_reference` holds the callback digest, `authenticated_at` remains provider token issuance for existing chronology checks, and the consumption separately records actual `auth_time`. The accepted economic-session binder stores `zephipay:canonical:<session UUID>` as a server-owned session reference. It is explicitly not an Auth0-signed `sid`. Provider issuer/subject plus canonical session remain independently verified. The consumption links consent to immutable policy/configuration and challenge context without widening the existing public consent contract.

The freshness threshold is the next full NumericDate second after database issue time. Expiry rounds downward and is bounded by challenge policy, canonical session, envelope, access proof and attestation expiry. Consent additionally ends no later than callback expiry, maximum authentication age or configured consent lifetime. Policy intervals are positive, capped at 600 seconds for challenge/freshness/consent and 24 hours for an operator artifact.

**Expiry model B:** the guarded function observes `clock_timestamp()` after canonical/provenance locks and checks admission before the challenge/proof deadlines. Consent expiry never exceeds challenge expiry. A caller can keep the transaction open and commit later; that durable historical confirmation can become visible with already expired consent. Existing downstream database/service eligibility checks reject such consent before granting claim, sponsor-finalization or first-contact authority. Fresh Runtime evidence cannot replace consent, and expired consent grants no new signing or submission authority. Recovery of an operation already authorized/contacted while valid retains the existing uncertainty protocol; this correction does not cancel prior irreversible effects.

PostgreSQL allows [SET CONSTRAINTS](https://www.postgresql.org/docs/16/sql-set-constraints.html) to force deferred checks early. Migration 029 removes 028's expiry constraint triggers and their function; no replacement deferred trigger claims to observe physical COMMIT. The explicit regression admits while valid, executes `SET CONSTRAINTS ALL IMMEDIATE`, waits beyond expiry, commits, and proves the visible consent is ineligible. Existing foreign keys and generic-consent constraints remain; the guarded operation now constructs the exact consent/consumption linkage previously checked by the removed trigger.

Service readiness/proof checks still repeat after waits and can reject before commit. An injected error at consent, consumption, admission or audit insertion rolls back all terminal authority; a pre-existing unconsumed proof can remain. A failure after commit, including authenticated-response generation or delivery failure, is recovered by reading the committed outcome, without blind repeat confirmation.

If revocation/version change commits first, confirmation fails. If confirmation holds the canonical locks first and admits while eligible, later revocation waits, then prevents subsequent authority without deleting history. Durable provider/policy rotation follows the same serialized ordering; identity credential retirement also invalidates unused attestations. An external snapshot retirement observed by the service aborts its transaction. Rotation is not a cross-system distributed transaction: administrators must coordinate the durable revision and signed snapshot publication, and unknown/mismatched states fail closed. Direct SQL admission relies on the registered attestation and durable heads, not a live provider query.

## Operator attestation and production gate

`loadConfirmationPolicy` requires an authenticated artifact, a pinned Ed25519 public trust root, its expected fingerprint and a verified deployment. The artifact must match deployment ID/environment/configuration/issuer/audience/client and carries a revision, operator/reference, bounded validity, selected dialect/algorithm/flow, required scope, allowed connections, refresh/grant policy and explicit freshness/assurance requirements.

An offline administrator registers the artifact, its verified configuration revision and the policy head. Ordinary identity, app, issuer, signer, observer and reader credentials cannot register policy or promote its revision. The issuer service compares the exact registered public payload/signature and policy head; SQL verifies the registered payload fingerprint and authoritative scalar comparisons, trusting administrator registration for signature verification. Unknown, retired, expired or UNATTESTED facts fail closed for creation/use. Local fixtures use explicit TEST attestations. Manual attestations express operator responsibility; a signature is not independent discovery of tenant settings, allowed connections, or upstream assurance behavior.

The local [attestation record](auth0-confirmation-profile-attestation-v1.json) separates code observations from deployed facts. No secret values or tenant identifiers were guessed. The Site source uses Auth0 SDK 4.26.0, removes refresh capability and restricts its auth route surface, but those facts do not establish tenant grant settings or a working fresh-authentication claim profile. Real tenant values, actual supported flow, claim/scopes, algorithm and reauthentication capability remain UNATTESTED.

Production status is always false in this package. Separate review must resolve tenant/operator evidence, connection assurance, client integration, durable shared service-transport replay, credential/network/TLS isolation and deployment authorization. No token, cookie, client secret or private key is persisted by the bridge. Signing keys in local tests authenticate synthetic JWT/service/operator artifacts only; no new test signs a blockchain transaction.

## Compatibility and deferred work

Site login/logout/callback, email verification, returning-user behavior and ordinary sessions are unchanged by source and route reachability. No browser session or real tenant was exercised, so this is not a live end-to-end compatibility claim. Current Devnet execution is unchanged; the bridge is absent from public Send wiring. No Protocol changes, ZERA registry addition, supply/allocation change, mint, distribution, staking, liquidity or routing activation occurs.

After independent audit, the next bounded task is operator-attested Auth0 profile registration plus an isolated, non-value identity/SDK transaction adapter, with durable shared transport replay proved before production use. Deployment, wallet authorization, signing, settlement and ZERA activation remain separate decisions.
