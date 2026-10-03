# Provider session, token and credential isolation readiness V1

Status: local candidate with AUD-PSCI-01 pinned-key correction; focused re-audit required. No live provider, signer, observer, payment route or deployment is installed by this package.

## Protected predecessor

The accepted trusted-authority composition was merged through Backend PR [#6](https://github.com/zephyon-labs/zephipay-backend/pull/6), with required hosted `verify` passing and no post-audit edits. Accepted head: `37df91c9b438df83adfc2e9fb775dcf00417fe32`. Canonical merge/base for this package: `745b363e1df973c8923a1a848c2c0d62de5a4e42`. OBS-04 remains deferred Protocol maintenance; this package does not alter the SDK.

## Scope and compatibility

Backend alone changes. No downstream API, mounted route, shared SDK export, environment setting consumed by the running server, or Devnet workflow changes. The new consent mode is an explicitly constructed, unmounted seam. Its body contains `envelopeDigest` and an expected canonical `accountVersion`; the version is a concurrency assertion, never authentication. Legacy evidence ingestion keeps its existing one-field body and JWT pipeline. The old all-credential composition remains explicitly synthetic and must not be deployed as process isolation.

Canonical identity create/revoke transaction bodies are extracted without changing their repository contracts, validation, account CAS, session guards or security-event writes. The new identity service invokes those same bodies within a transaction that also records token consumption. Existing identity persistence remains authoritative. No economic policy is moved out of the Runtime.

Migration 027 only adds empty readiness/consumption tables. Historical migrations 001–026 and historical consent rows are unchanged. The explicit role installer now requires 027. Future approved rollout order: apply migration; provision reviewed group grants and offline deployment registration; create separate deployment LOGINs and secret ownership; independently verify each service; only then consider a separately reviewed integration. No rollout is authorized here. No SDK release or frontend migration is needed for this unwired package.

`jose` moves from devDependencies to dependencies at the identical locked 6.2.7 version because new source code verifies JWTs. No other dependency or SDK version changes.

## Provider contract

`ProviderTokenVerifier` consumes the original compact signed token. A cookie, JSON principal, decoded claims object or caller assertion cannot authenticate. Proof objects have verifier-local provenance; copying their shape loses that provenance. Raw tokens, private keys and token contents are not persisted or logged.

The readiness profile requires:

- Exact HTTPS issuer, single exact API audience, authorized client (`azp`), `zep_environment`, `zep_context`, and action-specific scope.
- Signed `sub`, provider `sid`, unique `jti`, integer `iat` and `exp`; optional integer `nbf`, `auth_time`, and provider-defined `acr`.
- Header `typ: at+jwt`, pinned `RS256`, known unique `kid`. ID-token `JWT` type, token-directed key URLs/embedded keys, duplicate JSON members, oversized tokens and ambiguous audience arrays are rejected.
- Explicit maximum token age and lifetime, zero future-time tolerance at the economic boundary. There is no production policy default.
- An explicitly supplied public-only JWKS snapshot and monotonically increasing key revision. Only the configured key set is consulted; no discovery URL or external network request is activated.

Key initialization is explicit and asynchronous. `new ProviderTokenVerifier(contract)` has no active snapshot and cannot report initialized; callers normally use `await ProviderTokenVerifier.create(contract, snapshot)`. Every `replaceKeys(snapshot)` call must also be awaited. Identity/session and consent/provider readiness both require a successfully initialized active snapshot, the matching durable revision, and the existing deployment/ACL checks. Revision equality alone never establishes readiness.

For AUD-PSCI-01, every configured key is checked before activation. The supported JWK fields are exactly `kty`, `kid`, `n`, `e`, and optional `alg`, `use`, `key_ops`. `kty` must be RSA; `kid` must be nonempty and unique. RSA modulus/exponent must be nonempty canonical unpadded base64url unsigned integers, without leading zero octets; the modulus is odd and the exponent is odd, at least three and less than the modulus. Private members and unsupported metadata (including certificate URLs/chains and `ext`) are rejected. When present, `alg` must be `RS256`, `use` must be `sig`, and `key_ops` must be exactly `["verify"]`; sign-only and mixed operations are rejected. Absence of these optional metadata fields uses the same fixed RS256 verification profile, never a provider-specific exception.

`MIN_PROVIDER_RSA_BITS = 2048` is enforced before import and against the imported key's modulus length. This matches the pinned JOSE stack's RS256 minimum and [RFC 7518 §3.3](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.3); the public integer encoding follows [§6.3.1](https://www.rfc-editor.org/rfc/rfc7518.html#section-6.3.1). Configuration work is bounded to 16 keys and 2048 decoded bytes per RSA integer (a modulus up to 16384 bits). These are local resource bounds, not a provider exception or a change to token authorization policy.

Metadata validation is followed by eager resolution/import of **every** key through the same `createLocalJWKSet` resolver used by `jwtVerify`. Imported keys must be public, verify-only `RSASSA-PKCS1-v1_5` with SHA-256 and sufficient strength. Each key also runs a WebCrypto verification operation with a deliberately invalid zero signature; the primitive must execute and return false. No provider JWT is required to discover an import, algorithm or usability failure. The initialized resolver caches those imported keys for token verification.

Replacement builds a separate candidate snapshot, deep-copied before any await. Only after all keys pass does one immutable `{revision, resolver}` reference replace the active snapshot. The revision is checked again at publication: a slower older replacement cannot overwrite a newer accepted one. An invalid replacement never changes the active revision or resolver. A prior fully accepted snapshot remains eligible only while it still matches durable deployment state; if registration has advanced, both readiness surfaces fail until a valid matching snapshot initializes. Removed keys, retired revisions and stale reconstructed services remain rejected. Readiness detects import/usability, not ownership of the corresponding private key or the authenticity of an untrusted snapshot-delivery channel; the existing pinned-source and deployment trust assumptions remain necessary.

`zep_environment` and `zep_context` are this adapter's required signed profile claims, not claims every provider emits. A selected provider must supply an authenticated equivalent through a separately reviewed adapter. Missing claims fail closed; client request fields cannot fill them. Real provider selection, claim mapping, JWKS retrieval authentication/caching, issuer session semantics, browser callback/CSRF/PKCE, and sender-constrained tokens remain integration decisions.

The claim semantics follow [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#IDToken) for issuance versus authentication time. Strict issuer/audience/type/algorithm separation follows [JWT BCP, RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html). This package defines a restricted access-token profile; it is not a complete OIDC login implementation.

## Session and token chronology

1. A verified token may create a session for its already-linked ACTIVE canonical account, under the current account version and account lock. No automatic account provisioning from a client object occurs in this seam.
2. Canonical session creation uses the database clock, an explicit service-configured lifetime and existing security-event transaction. Token consumption commits atomically with creation. A bootstrap token ordinarily predates that newly created session and cannot authorize it.
3. A newly issued token must have `iat >= session.created_at` for binding and consent. NumericDate seconds are compared to full canonical millisecond timestamps; no rounding down, backdating, tolerance or inferred session reconstruction bridges the gap.
4. Provider `(issuer, subject, sid)` binds immutably to the existing canonical session. A different account, unknown identity, revoked/expired session or rebound provider session is rejected.
5. Consent resolves the canonical account, holds account/session locks, checks the current expected account version, consumes the verified token, and inserts immutable consent in one transaction. Token validity/key revision are rechecked after waits. The existing claim and first-contact paths recheck authoritative session/evidence eligibility.
6. Revocation uses existing account version CAS and security events and blocks future consent, claim and first contact as appropriate. It does not rewrite historical consent or pretend an already-committed contact never occurred. Existing recovery rules for possible effects remain intact.

`economic_provider_token_uses` is append-only. The unique token identifier is a SHA-256 digest of issuer, deployment environment and `jti`; the raw token has a separate hash. Records include action, resource reference, session ID, account version, key revision, issuance and actual authentication timestamps. They contain no bearer token. The same `jti` cannot be reused across actions, envelopes, retries or reconstructed instances. Failed transactions do not consume a token. Successful retries require a new provider token or a future authenticated read/recovery contract; no automatic success replay is inferred.

This intentionally strict one-use profile requires provider issuance support and is not a generic reusable-bearer API contract. It prevents reuse of consumed credentials. Theft before first use remains a bearer-token threat; sender binding and secure transport are unresolved integrations. Request intent, wallet ownership and user confirmation are not proven merely by possession of a bearer token.

## Reauthentication

`iat` is issuance, not proof of a human interaction. Refreshing a token does not refresh `auth_time`. An explicit per-action policy may require a maximum authentication age and accepted provider `acr`. Missing or insufficient evidence fails; no amount, asset-price or arbitrary payment threshold is invented. Test policy values are disposable fixtures, not approved production limits.

Consent expiry is bounded by token expiry, token-age limit, any recent-authentication deadline, canonical session expiry and envelope expiry. This carries freshness into the existing claim/contact validity checks. The historical consent column `authenticated_at` continues to contain token `iat` for compatibility; actual `auth_time` is recorded distinctly in token-use evidence. Existing rows are not reinterpreted.

Login/session authentication, economic consent, customer wallet signature, Runtime approval, signer contact and independent observation remain separate authorities.

## Credential ownership and isolation

| Process/service | Credential and allowed authority | Forbidden co-residence and impact of compromise |
| --- | --- | --- |
| Identity/session | One `zephipay_economic_identity` member LOGIN; canonical account/identity/session lifecycle, security events, session bindings, token-use records; public provider keys | No issuer/app/signer/observer/root secret. Can corrupt identity/session truth within its privileges; cannot insert consent, Runtime evidence, finalization or signer result. |
| Economic app | One app LOGIN; prepare, claim/contact, existing bounded expiry and accepted accounting functions | No identity/issuer/signer/observer/root secret. Can request operations and cause denial of service; cannot mint consent, Runtime evidence, customer signatures or authoritative signer results. |
| Evidence issuer | One issuer LOGIN; authenticated consent, trusted Runtime evidence, evidence revocation, existing binding authority and token-use records; public provider keys | No identity/app/signer/observer/root secret. This is a trusted evidence authority, not a cryptographic database verifier. Compromise can forge consent/Runtime/binding evidence for eligible existing accounts; cannot create canonical sessions, sign customer bytes or manufacture the whole chain. |
| Signer-result | One signer LOGIN; established signer-result/report authority | No app/issuer/identity/observer/root secret. Can corrupt/refuse reports within DB constraints; cannot independently issue consent or claim/contact. Real signing keys are absent here. |
| Observer | One observer LOGIN; established observation ingestion/effect evidence | No app/issuer/identity/signer/root secret. Can lie about observations within admitted context. Independent chain verification remains an unresolved live integration. |
| Reader/support | One reader LOGIN; reviewed scalar summaries/projections | No writable authority or raw bearer tokens. Read compromise exposes permitted metadata, not write authority. |
| Migration/admin root | Offline provisioning/migration credential; object ownership, role grants, deployment and key revisions | Never in an application image, shared secret bundle, service env or routine startup. Root can defeat all database controls and is explicitly trusted. |

No operational writable credentials may coexist. Reader credentials are also kept in a separate support process; application roles already have the reads they need. Public key material and nonsecret expected deployment configuration may coexist with the owning service credential. The test orchestrator necessarily holds dummy credentials for all compartments and an admin fixture connection; it is not a production topology.

`AuthorityProcess` accepts one pool and verifies only its actual LOGIN. Source-level separation cannot attest environment variables, process memory, host root, container boundaries, secret-manager policy or side-channel access. Those require independent deployment review. Services must use authenticated transports and separate OS/service identities; no new transport is supplied here.

Collusion is explicit: identity plus issuer compromise can fabricate identity and approval evidence; signer or observer compromise weakens those trusted attestations. A valid customer signature and existing finalization/contact checks are additional barriers, not a claim of safety under arbitrary multi-service collusion. A common host/control-plane/DB root with all secrets defeats compartmentation. Public verification keys are not provider signing authority.

## Deployment LOGIN and rotation

Use `db:economic:verify -- <role> --deployment` under the service's actual connection. No SET ROLE impersonation or admin fallback occurs. Required nonsecret expectations are `ECONOMIC_DEPLOYMENT_ID`, `ECONOMIC_DEPLOYMENT_ENVIRONMENT`, `ECONOMIC_DATABASE_NAME`, `ECONOMIC_LOGIN_NAME`, `ECONOMIC_CREDENTIAL_GENERATION`, `ECONOMIC_SCHEMA_OWNER`, and `ECONOMIC_IDENTITY_OWNER`. They are explicit CLI inputs, not server activation flags. The legacy command without `--deployment` proves only catalog privileges.

Verification retains the reviewed whole-current-database ACL inventory, including foreign/zero-column relations, all non-system schemas, column grants, sequences, callable economic functions and security definers. It checks actual session/current LOGIN, safe LOGIN/group flags, exactly the expected role membership, no admin-option membership, ownership/CREATE privileges, PUBLIC leakage, unexpected or missing grants and delegation grant options, pinned definer ownership/search path and catalog bounds. Deployment mode additionally pins public schema ownership, canonical identity table owner, economic table/function owner, actual database name, immutable expected deployment ID/environment and current registered LOGIN/generation. No service can change deployment registration.

Admin must provision `economic_deployment_identity` and exactly one registered LOGIN per role. Empty/mismatched state fails. Database names alone are insufficient; the deployment UUID is independently configured. Database cloning must change registration and expectations. TLS/server identity and secret delivery are still required externally; this readiness check is not network endpoint attestation. PostgreSQL roles are cluster-wide: separate environment clusters are preferred; shared clusters need explicit database CONNECT restrictions and independently reviewed grants, not just different names.

Rotation sequence for a service: create a fresh LOGIN with only its reviewed group; validate its candidate grants; quiesce the service; advance the registered LOGIN/generation; start a newly configured instance and pass readiness; retire old LOGIN membership/access and drain/terminate old sessions through the approved administrative process. Never reuse a stale pool as a fallback. Catalog/readiness and operation-connection checks reject an old generation, including already-established connections. Changing a password or NOLOGIN alone does not terminate existing PostgreSQL sessions; the tests explicitly check retirement of an established connection at the application boundary.

Provider-key rotation uses an independently delivered public snapshot and increasing revision, plus the deployment's registered `provider_key_revision`. Services fail closed during mismatch; reconstructed processes cannot resume with an old revision. A chosen overlap snapshot may temporarily retain prior public keys; retirement removes them. The deployment control plane must authenticate snapshots, prevent rollback, synchronize policy, and decide overlap/revocation timing. Merely changing keys does not erase accepted historical consent; emergency response must revoke affected sessions/evidence separately.

Checks run at readiness and operation boundaries. They do not make live DDL, secret replacement and arbitrary already-running statements atomically coordinated. Quiescence/session termination is required for hard cutover. An operation already authorized before a revocation/rotation linearization point may complete; the existing ledger/contact state remains authoritative. Availability is sacrificed on mismatch; there is no permissive fallback.

## Validation and remaining gates

Tests use disposable RSA keys, dummy local LOGIN passwords and isolated PostgreSQL databases. They exercise raw token negatives, canonical version/chronology, restricted-credential consent→synthetic Runtime→claim/contact, replay/revocation races, stale key snapshots, LOGIN rotation, ownership/ACL drift and actual denied SQL for every service role. Migration and full regression evidence is recorded in the audit handoff.

This is readiness for independent review, not readiness for live payments. Next package should independently audit this implementation and the proposed deployment ownership model. After acceptance, separately select the provider and authenticated service transports, approve real freshness/key-lifecycle policy, verify secret compartmentation in a non-value staging deployment, and specify emergency revocation. Live signer/observer work needs its own explicit package and audit.

Existing Devnet USDC behavior remains untouched and unwired. No ZERA registration, qualification, route, mint, distribution, staking or liquidity is introduced. The 200,000,000 ZERA baseline remains unchanged. No deployment, Mainnet execution, wallet route, funding or value transfer occurs.
