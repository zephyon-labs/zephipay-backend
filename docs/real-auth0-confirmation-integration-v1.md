# Real Auth0 confirmation integration V1 — compatibility findings

Status: **INTEGRATION BLOCKED pending a binding-contract decision and authoritative operator evidence.** Production readiness is **false**. This checkpoint records concrete configuration discovery and a reproduced SDK incompatibility; it does not claim an implemented or successful real-provider confirmation path.

## Protected closure

[Backend PR #9](https://github.com/zephyon-labs/zephipay-backend/pull/9) merged the exact independently accepted `600a987838c94abd02812086a11dd3529a9cccfa` through the active main ruleset, without bypass. Required [PR CI](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37299699946) and [main CI](https://github.com/zephyon-labs/zephipay-backend/actions/runs/37300309156) passed. Canonical main and origin/main equal `c583e8a87d4b34257ce8d834d2ed2c5008e1bc30`, with the accepted tree unchanged. The merged feature worktree and local/remote branch were removed and metadata pruned normally.

Phase B is isolated on `feat/real-auth0-confirmation-integration-v1` in `zephipay-backend-real-auth0-confirmation-integration-v1`, based on that canonical commit. No Phase B push, PR, merge or deployment is authorized or performed. A future authorized deployment must apply migration 029 before updated role provisioning and readiness checks.

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

The updated [attestation record](auth0-confirmation-profile-attestation-v1.json) preserves `status: UNATTESTED` and `production_ready: false`. It is an evidence record, not a signed `ConfirmationPolicy`. No policy is fabricated, signed or registered: required connection, assurance, environment and trust-root facts are unknown. Public metadata advertises issuer capabilities, not application-specific configuration. The absence of `acr` from `claims_supported` does not prove it can never be issued.

## Reproduced SDK/bridge incompatibility

The installed `@auth0/nextjs-auth0` 4.26.0 public middleware was executed with synthetic discovery, a supplied 64-character nonce, `max_age=0` and `prompt=login`. It returned an authorization redirect containing a different SDK-generated 43-character nonce, S256 PKCE, SDK state and an encrypted transaction cookie. Only synthetic discovery was consulted; the redirect was not followed and no external authentication request occurred. No SDK method or nonce generator was patched.

This follows the [versioned SDK implementation](https://github.com/auth0/nextjs-auth0/blob/v4.26.0/src/server/auth-client.ts): the SDK generates and stores its own nonce and validates the ID-token nonce against that transaction on callback. The public login options do not let the caller replace that stored value.

The accepted bridge independently generates an immutable 32-byte hexadecimal nonce in `economic_issue_confirmation`. `Auth0AuthenticationVerifier.verifyReauthentication` requires the ID-token nonce to equal that exact challenge nonce. `economic_record_confirmation_proof` repeats the equality against the durable challenge. Consequently an ordinary SDK callback cannot satisfy the unchanged bridge contract. Changing the redirect URL would not change the SDK's protected transaction expectation and is not a solution. Patching SDK internals, treating an unrelated token as a callback proof, or removing either nonce check is not acceptable.

## Narrow next decision

A concrete compatibility extension would retain the existing immutable economic challenge and append an immutable server-owned binding from the SDK-generated OIDC nonce/state to the existing challenge ID, database nonce, transaction ID, canonical session, subject, envelope, environment, issuer/client and policy/configuration versions. It would require guarded creation before redirect and one-use callback consumption, with the SDK still responsible for state/PKCE/provider callback validation. Existing proof registration and guarded terminal admission would remain mandatory. Callback completion would still be separate from explicit confirmation.

That is a proposed change to the accepted binding contract, not an implemented fallback. Approval was requested under the workspace rule requiring approval before breaking public-contract changes. No new proof format, SQL function, nonce interpretation or terminal-write path has been implemented while that decision is pending. Any approved extension must be independently audited with actual restricted LOGIN, replay, reconstruction and expiry tests.

Authoritative operator evidence must also identify allowed connections and the meaning of accepted assurance values. Auth0's [reauthentication documentation](https://auth0.com/docs/authenticate/login/max-age-reauthentication) requires validating `auth_time`; `iat` and `prompt=login` alone are insufficient. An upstream federated exchange can update `auth_time` without proving fresh human interaction. This package does not invent those guarantees.

## Integration and validation status

No real Auth0 web adapter, canonical Site-session mapping, challenge HTTP surface, callback binding, or trusted-consent path has been activated or presented as complete. Mobile clients would retain the same canonical challenge/consent semantics; browser cookies must not become economic identity. Existing Site login/logout, returning-user behavior, email verification, Send routes and SDK remain unchanged by this checkpoint.

The accepted runtime/test tree already passed hosted lint, unit tests, build, migration validation, fresh migration/role provisioning and the complete PostgreSQL regression on both the PR and merged main. Phase B changes documentation/evidence only. Local lint, build, 607 unit tests, 136 focused confirmation/readiness tests, migration validation and diff checks passed. The identical runtime/test source passed 465 PostgreSQL tests with zero failures/skips in both hosted runs, including confirmation and restricted LOGIN coverage. No new adapter-specific PostgreSQL or real-provider end-to-end result is claimed. The SDK probe establishes the incompatibility, not a successful real-provider roundtrip. Existing bridge tests cover wrong subject/session/challenge/nonce/envelope, expiry, revocation, account/configuration/policy changes, duplicate consumption, lost response and service reconstruction; those results do not establish the missing Site adapter's security. That adapter must receive its own failure/recovery regression once the binding decision is resolved.

No production source, schema, Runtime approval, signer contact, blockchain signature, broadcast, fund movement, Mainnet activation or ZERA behavior changed. Protocol remains v0.4.0 and the 200M ZERA baseline is unchanged. The external `/tmp/real-auth0-confirmation-integration-v1` package preserves Phase A closure, allowlisted evidence, public discovery and the executable SDK probe. Local commit/patch fingerprints belong in its external manifest.
