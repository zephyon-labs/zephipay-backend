# Non-value Auth0 attestation and durable confirmation bridge V1

This package connects accepted Auth0 proofs to the existing economic-consent table through an unmounted issuer service. It creates consent evidence only. It does not create Runtime approval, reserve exposure, finalize an operation, sign a transaction, submit to a chain, observe settlement, or activate a wallet route. ZephiPay remains usable without ZERA.

Base: `9bc94e24a3cd70fb1d83f226ad6bd76bd28ca1d3`. Branch: `feat/auth0-confirmation-bridge-v1`. The base contains the exact independently accepted provider-readiness package merged through Backend PR #8. This continuation requires its own independent audit and remains local.

## Status and trust claims

| Area | Status | Evidence and limit |
| --- | --- | --- |
| Challenge, consumption, consent and recovery | Implemented | PostgreSQL transactions, immutable records and restricted issuer LOGIN |
| Auth0 proof provenance | Implemented | Accepted adapter plus private provenance for its reauthentication results; no new JWT dialect |
| Authenticated identity-to-issuer invocation | Implemented local seam | Accepted signed service transport with exact body, caller, recipient, deployment and credential generations |
| Browser/mobile provider roundtrip | Backend contract implemented; client integration modeled | Server transaction ID and nonce, canonical session and envelope binding; no SDK or Site wiring |
| Auth0 tenant/domain/audience/client, connections, grants, assurance | UNATTESTED | See [nonsecret local record](auth0-confirmation-profile-attestation-v1.json) |
| Operator attestation | Mechanism implemented; actual tenant attestation deferred | Signed nonsecret artifact, pinned public root and fingerprint, append-only registration and monotonic policy head |
| Confirmation replay | Durable | PostgreSQL challenge primary key and consumption record survive service reconstruction |
| Service-transport replay | Deferred for production | Existing ledger interface; tests use explicitly volatile ledgers. Confirmation durability does not close this separate gap |
| Production readiness | Refused | `confirmationProductionGate` always returns false for this non-value package, including TEST or fully ATTESTED policy records |

Only Backend changes. No SDK export, public API route, environment variable, receipt format, Site contract, or ordinary Send behavior changes. Protocol remains pinned to v0.4.0. No dependency change is required. Future deployment order, after separate approval: migration 028 under administrative authority, role provisioning, issuer/identity readiness verification, then separately audited client wiring. Existing deployments must not adopt the updated role installer before migration 028. No deployment is performed here.

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

Exact-object parsing rejects additional authoritative fields, duplicate JSON keys and missing fields. The caller can nominate an existing envelope/session, but cannot set nonce, account/version, policy, issuer, environment, challenge identity or deadlines. The signed request binds the access-token digest; confirmation also binds the verified callback digest. A refreshed access token is allowed only after canonical and scope checks; original and confirmation authentication references remain separately recorded.

The trusted identity adapter must derive the canonical session from its authenticated session authority, never a browser field. It must retain the server transaction reference in the SDK's server-side transaction context, validate SDK state/PKCE/callback binding, and present the exact canonical envelope for an explicit user action. Only then may it sign `/confirmation/confirm`. Callback success itself is not confirmation. The bridge rejects another session, transaction, challenge, envelope, action, nonce or provider proof. Possession of a bearer token plus browser-shaped proof does not supply the signed identity-service request.

This package does not implement or attest that future identity adapter, browser CSRF/transaction store, mobile deep-link handler or SDK callback integration. Those are mandatory before mounting any route. No Auth0 SDK internals are changed. Cookies are not part of economic challenge identity; future iOS/Android adapters must preserve the same canonical semantics.

## Durable records and state

Migration 028 adds:

- `economic_confirmation_policies`: signed nonsecret artifact, fingerprint, deployment, policy revision, database actor and recorded time; append-only.
- `economic_confirmation_policy_heads`: one administrator-managed monotonic revision per deployment. Issuer can lock but cannot advance or rewrite it.
- `economic_confirmation_challenges`: challenge/request/transaction IDs; canonical account, principal, session and account version; envelope, intent/generation and fixed action; environment, issuer/subject; configuration fingerprint/revision, policy fingerprint/revision and provider-key revision; original authentication digest; server nonce; database request time, expiry and immutable reauthentication requirements. Append-only.
- `economic_confirmation_consumptions`: one row per challenge, unique existing consent reference, authentication/callback/request digests, actual `auth_time`, assurance, confirmation and expiry times, database actor. Append-only.
- `economic_confirmation_summary`: bounded support projection without nonce, token or raw provider artifact.

`ISSUED` means there is an eligible unconsumed record. `CONFIRMED` means a consumption and linked consent committed; it never means executed or paid. `EXPIRED` is derived from database time. `INVALIDATED` is derived from canonical status/version/revocation, current generation/attempt state, policy head or durable key revision. Expired records take precedence over invalidation; historical CONFIRMED records take precedence over later expiry/revocation. The view describes local durable state, not a live provider-readiness probe. It cannot observe an external snapshot-head change before the local deployment revision is advanced; use still checks both sources and fails closed.

There is no expiry worker or destructive rewrite of history. Recovery requires a currently valid authenticated canonical session. Later account-version changes do not hide committed history from an otherwise still-valid session. A revoked session cannot recover through the user path; authorized support retains the bounded projection. Support state is observational and cannot confer authority.

## Atomicity, locks and time

The issuer uses one PostgreSQL transaction for session binding, consent insertion, challenge consumption and audit. The intent head is locked first, then canonical account/session, policy head and deployment provider revision. This preserves existing attempt and canonical revocation ordering. Registry locks are acquired through the accepted qualifier. Head locking serializes simultaneous confirmations; the consumption primary key is the final durable one-use constraint.

Consent is inserted into the existing `economic_consent_evidence` schema. `authentication_reference` holds the callback digest, `authenticated_at` remains provider token issuance for existing chronology checks, and the consumption separately records actual `auth_time`. The accepted economic-session binder stores `zephipay:canonical:<session UUID>` as a server-owned session reference. It is explicitly not an Auth0-signed `sid`. Provider issuer/subject plus canonical session remain independently verified. The consumption links consent to immutable policy/configuration and challenge context without widening the existing public consent contract.

The freshness threshold rounds database issue time upward to a NumericDate second. Expiry rounds downward and is bounded by challenge policy, canonical session, envelope, access proof and attestation expiry. Consent additionally ends no later than callback expiry, maximum authentication age or configured consent lifetime. Policy intervals are positive, capped at 600 seconds for challenge/freshness/consent and 24 hours for an operator artifact.

Readiness/proof checks repeat after waits. Deferred PostgreSQL constraint triggers check expiry at commit and link consumption to the same consent envelope, principal, session, issuer, subject, callback digest and times. Failure before commit rolls back both consent and consumption. A failure after commit, including authenticated-response generation or delivery failure, is recovered by reading the committed outcome. It must not trigger blind repeat confirmation.

If revocation/version change commits first, confirmation fails. If confirmation holds the canonical locks first and commits while eligible, later revocation waits, then prevents subsequent authority without deleting history. Durable provider/policy rotation follows the same serialized ordering. An external snapshot retirement observed during processing aborts the transaction. Rotation is not a cross-system distributed transaction: administrators must coordinate the durable revision and signed snapshot publication, and unknown/mismatched states fail closed. This package preserves that accepted readiness boundary.

## Operator attestation and production gate

`loadConfirmationPolicy` requires an authenticated artifact, a pinned Ed25519 public trust root, its expected fingerprint and a verified deployment. The artifact must match deployment ID/environment/configuration/issuer/audience/client and carries a revision, operator/reference, bounded validity, selected dialect/algorithm/flow, required scope, allowed connections, refresh/grant policy and explicit freshness/assurance requirements.

An offline administrator registers the artifact and advances the policy head. Ordinary identity, app, issuer, signer, observer and reader credentials cannot register policy or promote its revision. The issuer locks and compares the exact registered public payload/signature and policy head. Unknown, retired, expired or UNATTESTED facts fail closed for creation/use. Local fixtures use explicit TEST attestations. Manual attestations express operator responsibility; a signature is not independent discovery of tenant settings, allowed connections, or upstream assurance behavior.

The local [attestation record](auth0-confirmation-profile-attestation-v1.json) separates code observations from deployed facts. No secret values or tenant identifiers were guessed. The Site source uses Auth0 SDK 4.26.0, removes refresh capability and restricts its auth route surface, but those facts do not establish tenant grant settings or a working fresh-authentication claim profile. Real tenant values, actual supported flow, claim/scopes, algorithm and reauthentication capability remain UNATTESTED.

Production status is always false in this package. Separate review must resolve tenant/operator evidence, connection assurance, client integration, durable shared service-transport replay, credential/network/TLS isolation and deployment authorization. No token, cookie, client secret or private key is persisted by the bridge. Signing keys in local tests authenticate synthetic JWT/service/operator artifacts only; no new test signs a blockchain transaction.

## Compatibility and deferred work

Site login/logout/callback, email verification, returning-user behavior and ordinary sessions are unchanged by source and route reachability. No browser session or real tenant was exercised, so this is not a live end-to-end compatibility claim. Current Devnet execution is unchanged; the bridge is absent from public Send wiring. No Protocol changes, ZERA registry addition, supply/allocation change, mint, distribution, staking, liquidity or routing activation occurs.

After independent audit, the next bounded task is operator-attested Auth0 profile registration plus an isolated, non-value identity/SDK transaction adapter, with durable shared transport replay proved before production use. Deployment, wallet authorization, signing, settlement and ZERA activation remain separate decisions.
