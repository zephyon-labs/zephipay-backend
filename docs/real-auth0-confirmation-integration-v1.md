# Real Auth0 confirmation integration V1 — non-value SDK binding

Status: **candidate for independent audit of the approved nonce-contract amendment**. Production readiness remains **false**. The isolated integration executes the real Auth0 SDK against a synthetic provider and real restricted PostgreSQL LOGINs. It does not attest a deployed Auth0 tenant or activate a live Site route.

## Protected closure

[Backend PR #9](https://github.com/zephyon-labs/zephipay-backend/pull/9) merged the exact independently accepted `600a987838c94abd02812086a11dd3529a9cccfa` through the active main ruleset, without bypass. Required [PR CI](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37299699946) and [main CI](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37300309156) passed. Canonical main and origin/main equal `c583e8a87d4b34257ce8d834d2ed2c5008e1bc30`, with the accepted tree unchanged. The merged feature worktree and local/remote branch were removed and metadata pruned normally.

Phase B is isolated on `feat/real-auth0-confirmation-integration-v1` in `zephipay-backend-real-auth0-confirmation-integration-v1`, based on that canonical commit. No Phase B push, PR, merge or deployment is authorized or performed. A future separately authorized rollout must apply migrations through **030**, then updated role provisioning/readiness, then Backend identity/issuer composition, and finally the reviewed Site host. No Protocol release or live Send change is required by this package.

## Actual configuration evidence

Inspection used Site commit `80883547ca42b83f8f80e417e733feeca9c11ae8`, the new Backend canonical main, allowlisted nonsecret local configuration values, public OIDC discovery, and the installed Site SDK. No secrets, cookies, live tokens or tenant management credentials were inspected or printed. No tenant mutation or real authentication request occurred.

| Fact | Verified evidence | Deployment classification |
| --- | --- | --- |
| Issuer | Local Site domain and Backend issuer agree: `https://dev-olu4s64jtgac3n4c.us.auth0.com/`; public discovery returns that issuer | VERIFIED for local/public evidence; production application binding UNATTESTED |
| API audience | Both local configurations use `https://api.zephipay.com` | VERIFIED locally; tenant API/client authorization UNATTESTED |
| Web client ID | Local Site uses `MCyUd7keY6wvNgEDCn4x7kaXKwufWT5z` | VERIFIED locally; actual application configuration UNATTESTED |
| Scopes | Site source produces `openid profile email read:account write:account read:payments write:payments`; strips `offline_access` | VERIFIED source/local configuration; actual issued scopes and operator-selected confirmation scope UNATTESTED |
| Token dialect | Accepted economic verifier requires Auth0-profile JWTs with API audience, `azp`, `scope`, `iat`, `exp` | VERIFIED requirement; actual tenant/API token dialect UNATTESTED |
| Signing algorithm | Backend expects RS256; discovery advertises RS256 along with HS256 and PS256 | VERIFIED support/requirement; actual application algorithm UNATTESTED |
| Callback | Local base derives `http://localhost:3000/auth/callback`; SDK route is `/auth/callback` | VERIFIED locally; deployed base and tenant callback allowlist UNATTESTED |
| Login/logout | Existing allowed SDK routes: GET `/auth/login`, `/auth/callback`, `/auth/logout`; login returns to `/personal`; Site applies logout/generation fences | VERIFIED source; deployed roundtrip UNATTESTED |
| Session | SDK 4.26.0, nonrolling seven-day absolute lifetime, Site cookie `__zephipay_session_v2`, server-only SDK access and application ordering checks | VERIFIED source; deployed cookie/session behavior UNATTESTED |
| Email verification | Existing Site reads verified-session `email_verified` and uses bounded verification continuations; email is not canonical payment identity | VERIFIED source; connection/email-verification behavior UNATTESTED |
| Refresh | Site removes `offline_access` and saved refresh tokens; browser access-token endpoint disabled | VERIFIED source; tenant refresh/grant policy UNATTESTED; web-session refresh-token execution NOT APPLICABLE to this source configuration |
| Reauthentication | SDK supports `max_age=0`, `prompt=login`, S256 and callback nonce validation; discovery lists `auth_time` | VERIFIED capability; fresh-human authentication, allowed connections and accepted ACR semantics UNATTESTED |
| Canonical confirmation session | Current Site source has no confirmation adapter mapping its verified SDK session to canonical `account_sessions` | VERIFIED integration gap; production mapping UNATTESTED |
| Operator and deployment trust | No authoritative signed profile/root, endpoint/isolation evidence or durable callback/transport replay evidence supplied | UNATTESTED |

The updated [attestation record](auth0-confirmation-profile-attestation-v1.json) preserves `status: UNATTESTED` and `production_ready: false`. It is an evidence record, not a signed `ConfirmationPolicy`. No production policy is fabricated, signed or registered: required connection, assurance, environment and trust-root facts are unknown. Public metadata advertises issuer capabilities, not application-specific configuration. The absence of `acr` from `claims_supported` does not prove it can never be issued.

## Original incompatibility and approved contract

The installed `@auth0/nextjs-auth0` 4.26.0 public middleware was executed with synthetic discovery, a supplied 64-character nonce, `max_age=0` and `prompt=login`. It returned an authorization redirect containing a different SDK-generated 43-character nonce, S256 PKCE, SDK state and an encrypted transaction cookie. Only synthetic discovery was consulted; the redirect was not followed and no external authentication request occurred. No SDK method or nonce generator was patched.

This follows the [versioned SDK implementation](https://github.com/auth0/nextjs-auth0/blob/v4.26.0/src/server/auth-client.ts): the SDK generates and stores its own nonce and validates the ID-token nonce against that transaction on callback. The public login options do not let the caller replace that stored value.

The accepted bridge independently generates an immutable 32-byte hexadecimal nonce in `economic_issue_confirmation`. `Auth0AuthenticationVerifier.verifyReauthentication` requires the ID-token nonce to equal that exact challenge nonce. `economic_record_confirmation_proof` repeats the equality against the durable challenge. Consequently an ordinary SDK callback cannot satisfy the unchanged bridge contract. Changing the redirect URL would not change the SDK's protected transaction expectation and is not a solution. Patching SDK internals, treating an unrelated token as a callback proof, or removing either nonce check is not acceptable.

The user approved a separate durable SDK transaction binding on October 6, 2026. The old verifier remains available for previously supported direct-challenge adapters. Once a challenge has an SDK binding, database guards prohibit falling back to the old path without the exact registered SDK callback.

## Implemented non-value path

`Auth0SdkConfirmationAdapter` runs in the trusted identity compartment. Its host is the existing SDK's public `middleware`, `onCallback` and `getSession` APIs. The executable host in `tests/helpers/auth0SdkHostFixture.ts` uses the actual unmodified SDK 4.26.0 and Next 16.2.12. These are pinned development dependencies for reproducible integration tests; Backend production code has no Next/Auth0 SDK runtime import. Existing production dependency versions, including jose 6.2.7 and Protocol v0.4.0, remain fixed by the lockfile.

1. The SDK validates the initial login and authenticates its encrypted session. The Backend adapter independently verifies the SDK-held access token, including issuer, subject, client, audience, scope, key revision and time. SDK user subject must match that verified token. Email is not consulted.
2. The trusted identity service chooses an existing canonical session and calls `bindExistingSession`. The existing immutable `economic_session_bindings` authority records an opaque digest reference to the SDK-held ID token. Canonical account ownership, session chronology, expiry and revocation remain authoritative. A browser-shaped session ID or cookie is not an identity source. An SDK session cannot be rebound to another canonical session.
3. The existing signed identity-to-issuer bridge issues an exact Protocol-envelope challenge. There is no second intent model. `start` requires the SDK session's durable mapping to match this challenge's exact canonical session.
4. The SDK generates its own state, nonce and S256 PKCE transaction and protects it in its encrypted transaction cookie. The adapter inspects the server-returned authorization redirect, checks issuer/client/audience/callback/max-age/scope, and commits an immutable transaction binding **before releasing the redirect/cookie**. It neither supplies the economic nonce as the OIDC nonce nor rewrites the SDK redirect/cookie.
5. The binding snapshots the canonical challenge, economic nonce, transaction, issuer+subject, account/session/version, envelope/generation, environment, policy/configuration/provider revisions, expiry and client/audience. It stores the SDK nonce, state digest, code challenge, exact callback URI and fixed opaque `returnTo`. No code verifier, raw state, JWT, access token, cookie or client secret is stored in the new tables.
6. Only the SDK's successful `onCallback` branch reaches callback registration. The protected returnTo identifies the binding; the incoming state digest must match it. The existing Auth0 verifier checks the signed ID token again using the SDK nonce and the immutable challenge's subject/freshness/assurance/context. `iat` is never substituted for `auth_time`.
7. A guarded identity-only database function records the callback exactly once, after rechecking current canonical truth and the actual identity LOGIN/generation. The new SDK session digest is bound to the same canonical session in that transaction. The canonical head → account → session lock order is retained.
8. Callback completion creates **no consent**. A subsequent trusted explicit-confirm action reopens the SDK session, checks its ID-token digest against the durable callback, re-verifies that token, and records the existing identity proof for the exact confirmation body. Exact proof-registration retries return the same proof ID. The separately authenticated issuer still executes `economic_admit_confirmation`; existing consent, consumption and admission atomicity, one-use semantics and admission-time expiry guards remain mandatory.

Migration 030 is additive. Historical migrations 001–029 are byte-for-byte unchanged. It adds two private append-only tables, an optional proof reference, identity-only guarded functions and mandatory proof/admission guards for SDK-bound challenges. The accepted admission function is unchanged. The issuer cannot register callbacks; identity cannot admit consent. Operational roles have no direct access to the two new tables. Restricted LOGIN validation checks the updated reviewed allowlist.

## Trust boundary and host requirements

The SDK host and session reader are server composition dependencies, never HTTP request data, caller claims or `validated=true` flags. The host must install the supplied hook directly as Auth0Client's `onCallback`, use the configured tenant/client/base/callback, request code + S256 + `max_age=0`, and retain all SDK callback checks. The isolated fixture demonstrates this concrete composition. A future Site mount must additionally preserve the Site's existing application-session ordering/logout fences and request/CSRF controls for explicit confirmation. This package deliberately leaves live routes unchanged.

The authenticated restricted identity compartment attests callback provenance to PostgreSQL, as it already attests provider proofs. PostgreSQL does not claim to execute OIDC or independently verify JWT signatures. An arbitrary ID token, plain JavaScript proof, service role, or reference is insufficient through this adapter. Process-memory branding is reconstructed by signature verification against the current key snapshot, with durable callback lookup; memory alone is not the replay ledger. Production workload/network/replay and operator trust remain separately unattested. Mobile adapters can retain the same canonical challenge/consent semantics without browser cookies as economic identity.

The test provider enforces the transmitted S256 verifier against the SDK-generated authorization challenge, one-use authorization codes, and synthetic issuer/JWKS/token endpoints. Negative tests require the real SDK to reject incorrect state, missing transaction cookie, wrong nonce, issuer, audience, expired token and a provider-rejected PKCE exchange before a successful hook. Other tests cover absent/stale auth_time, wrong subject/assurance, wrong canonical session, challenge/envelope/action/transaction substitution, stale account/policy/provider revision, revocation, callback replay, duplicate confirmation and reconstruction.

## Recovery and bounded expiry

- Lost proof-registration response: reconstruct the SDK session and adapter, then retry the identical body; recover the same durable proof. A changed access token/body requires a new ceremony rather than rewriting the proof.
- Lost confirmation response: use the existing authenticated bridge recovery operation; it returns the admitted consent without consuming again.
- Callback replay: rejected by the one-use durable callback row, even with a copied original encrypted transaction cookie and another otherwise valid provider response.
- Lost start response, or callback commit followed by failed SDK session persistence: fail closed. The missing SDK cookie/token is not reconstructed from database flags; begin a new canonical challenge/ceremony. Existing challenge/binding expiry is never extended. Nothing grants consent automatically.
- Expired or invalidated challenge/session/policy/configuration/key/credential: fail closed at database and service checks. Expiry tests observe PostgreSQL itself past the deadline, with the existing 1500 ms safety margin and two nonbackward observations. Host sleeps do not establish eligibility.

## Operator evidence and existing Site preservation

The [attestation record](auth0-confirmation-profile-attestation-v1.json) remains UNATTESTED with `production_ready:false`. The nonce incompatibility is resolved in this candidate; local success is not tenant/client/connection assurance. No production policy or root has been fabricated, signed or registered. Synthetic TEST policies exist only in disposable fixtures. The current Site lacks the mounted confirmation host and canonical session bootstrap; no live integration is claimed.

Authoritative operator evidence must establish the actual client grants, algorithm/dialect, deployed callback allowlist, confirmation scope, allowed connections and accepted assurance semantics. Auth0's [reauthentication documentation](https://auth0.com/docs/authenticate/login/max-age-reauthentication) requires validated `auth_time`; `iat` and `prompt=login` alone are insufficient. Federated SSO may update auth_time without fresh human interaction. Missing evidence remains a deployment blocker.

Site login/logout, returning-user handling, verification flow, SDK session ordering and live Send are preserved because the Site tree is untouched. There is no mounted Backend route, Runtime approval, signer contact, blockchain signature, submission, settlement, funds movement, Mainnet or ZERA activation. ZERA's 200M economic baseline is unchanged.

## Validation and audit artifacts

Final local validation passed on the candidate: 607 unit tests, 212 focused authentication tests, 115 confirmation PostgreSQL tests (29 exercising the real SDK/binding), 97 restricted-LOGIN/provider tests, and the complete fresh-database PostgreSQL regression of **494 tests with zero failures/skips**. The 29 SDK cases passed in both the focused and full runs. Lint, build, the SDK host's strict typecheck, migrations 001–030, the 028→029→030 upgrade/repeat test, role provisioning and diff checks passed. All implementation file hashes were unchanged during the full run. Final edits after that run only record these results.

Validation results and exact candidate hashes are recorded in the external `/tmp/real-auth0-confirmation-binding-v1` audit package. It preserves initial fixture failures and subsequent results rather than overwriting them. The earlier `/tmp/real-auth0-confirmation-integration-v1` discovery/nonce-blocker checkpoint and Phase A closure evidence remain intact.

The dependency audit is not clean: npm reports advisories in existing production dependencies and the pinned development-only SDK/Next fixture stack. The exact audit outputs are preserved in the external package. No Next server, image optimizer or OG route is started by the fixture; no dependency remediation or production upgrade is included in this narrowly approved change. This is not a dependency-security clearance.

The next step is independent review of this bounded non-value contract amendment and adapter. Mounting a Site host, obtaining operator attestations, conducting a real tenant non-value ceremony, or deploying requires its own concrete review and authorization. No production-readiness claim follows from this candidate.
