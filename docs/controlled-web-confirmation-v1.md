# Controlled web confirmation V1

Continuation of Backend checkpoint `c01697061ad0e066eb42ae6a00debed202ab373f` and Site checkpoint `fd94627e9345df796c04a415af23802e65bf8983`. Production readiness is **FALSE**. This is a TEST-only non-value product integration for independent review, not deployment or execution approval.

The Site/BFF owns the installed Auth0 SDK, browser session, state, OIDC nonce, S256 PKCE and callback validation. Backend Identity independently verifies provider JWTs, resolves canonical sessions and records SDK evidence. Backend App prepares the accepted Protocol v0.4.0 envelope; the separate restricted issuer uses the existing authenticated service transport and SQL guarded admission. Callback success is not consent. Only a subsequent explicit Site POST can request admission.

## Private boundary

`POST /internal/controlled-confirmation/{prepare,recover,start,callback,confirm,revoke}` accepts an Ed25519 signed bounded packet (32 KiB payload, at most 60 seconds). A dedicated Site key is pinned by the Backend; a different Backend response key is pinned by the Site. This narrow protocol uses the existing readiness transport's context/body/request/expiry/response binding pattern. It does not reuse any of its six operational workload keys: the Site is not a database authority role. Configuration fingerprint, environment, issuer, client, both origins and action are signed. PostgreSQL clock time checks freshness, and an append-only shared request ledger atomically rejects replay across processes. A retry uses a new request identity and recovers the same durable ceremony. No bearer-only private route exists.

The SDK-held access JWT is necessary for the accepted independent access verifier. The SDK-held ID JWT is necessary for the accepted independent SDK nonce, auth_time, assurance and durable token-digest guards. These are transmitted only over the private HTTPS boundary (localhost allowed for fixtures), never returned to the browser API, logged or stored in these new tables. Revocation sends neither token. No cookies, authorization code, PKCE verifier, refresh token, email or browser-supplied validation flag is handed off. The authorization URL is a bounded server-observed SDK output, independently checked against the pinned client, issuer, callback, S256 and max_age=0 contract before its cookies/redirect are released.

Migration 032 adds immutable web-session mappings, immutable payment/ceremony associations, replay claims, a restricted status view, and logout tombstones. A database guard checks session ownership and exact prepared-payment/challenge associations. Existing migrations 001–031 are unchanged. Identity receives only the reviewed reads/inserts for these additions; no terminal or issuer-admission grants are added.

## Session and recovery semantics

The Site creates a random opaque application-session reference inside the SDK-encrypted session. Reauthentication preserves that reference only when the successful callback belongs to the same subject and existing application session. Ordinary new login creates a distinct reference. There is no access-token `sid` assumption. One issuer/subject can have separate device sessions; no existing mapping can be rebound.

Backend session authority starts at the independently verified access-token authentication event. Actual registration is recorded using PostgreSQL time, separately from that event, so account update/audit chronology cannot move backward. The existing session-creation helper gains an optional registration-time argument; existing callers retain their behavior. Session expiry is fixed, never extended by reauthentication. Canonical account/session and access-token eligibility are rechecked on every operation.

Logout sends a signed revocation before clearing local authority. Failure reports a retryable sign-out failure and does not falsely claim durable revocation. A tombstone is retained even if logout wins before first preparation. A per-reference transaction lock orders first creation and revocation; existing canonical account/session locks order later admission. Historical evidence is preserved.

A payment has one immutable web ceremony in this version. Concurrent prepare uses the same payment request identity; double confirm can produce one admission only, and its loser recovers the committed result. Callback replay does not repeat proof/admission. A lost confirm response, refresh or reconstructed instance reads the same result. A callback committed without delivery of the new SDK session cookie cannot confirm using the old ID token; recovery reports session change. Lost start cookies or an expired ceremony fail closed; this version does not replace a bound SDK transaction or renew a prepared envelope. A new eligible payment can start a new ceremony. This is an explicit limitation, not an implicit retry that changes signed economics.

## Mounting and activation

`createControlledWebApplication` mounts the actual bounded HTTP router with an explicitly constructed `ControlledWebConfirmation` and accepted App/issuer service ports. Its constructor requires a verified TEST policy, Identity restricted LOGIN/readiness and the explicit `controlled-non-value` gate. The ordinary public Backend mounts the router closed, without authority credentials. There is no environment switch that silently combines these services with normal execution. Controlled test composition is explicit and separate; production assembly/credential provisioning remains subject to review.

Site activation requires the server-only `ZEPHIPAY_CONTROLLED_CONFIRMATION=non-value-test`, exact `ZEPHIPAY_CONTROLLED_HANDOFF_CONTEXT` JSON, dedicated `ZEPHIPAY_CONTROLLED_SITE_PRIVATE_KEY` and pinned `ZEPHIPAY_CONTROLLED_BACKEND_PUBLIC_KEY`. Nothing is `NEXT_PUBLIC`. Keys/configuration are operator inputs; none are generated or installed by this package. The UI is selected at `/personal/send?controlled=1` only while that server gate is enabled. BFF POSTs require an authenticated, ordered Site session and an Origin accepted by the current Site boundary. Start releases real SDK cookies only after durable binding. The existing callback gesture/logout fence remains in front of SDK callback processing. No browser body selects a canonical session, envelope, nonce, policy or challenge.

Only direct-wallet Solana Devnet USDC TEST preparations qualify. Username/synthetic recipients are explicitly ineligible in this experiment. The future blocker is **username payment identity → authorized canonical Solana destination**: recipient resolution, economic identities, payment destinations and the immutable payment recipient snapshot must supply an authorized destination and version. This package does not guess that mapping.

Normal Send and Devnet execution remain separate. The controlled UI shows payment details, authentication readiness, expiry/session-change states, and “Payment confirmed” with explicit no-execution context. It does not call ordinary payment confirm/execute or infer a receipt. No Runtime approval, message/blockhash preparation, wallet/sponsor contact, broadcast, reconciliation, Mainnet, funds movement or ZERA activation is available in this composition.

## Reproduce validation

Install both candidate checkouts with their lockfiles. Start a disposable PostgreSQL database, apply all migrations and the reviewed role provisioning script. Set `TEST_DATABASE_URL` to that database and `CONTROLLED_SITE_SOURCE` to the absolute Site candidate directory. Never use live databases or provider tenants.

- `npm run test:postgres:web` requires the Site candidate and executes its real SDK start/callback code with the synthetic Auth0 provider, signed handoff, actual mounted Backend HTTP route and restricted PostgreSQL authorities.
- With the same two variables, `npm run test:postgres` includes all confirmation/preparation and cross-repository tests in the complete regression, with no skipped cases. Without the Site variable, standalone Backend regression retains its existing repository-only scope.
- `npm run lint`, `npm run build`, `npm test`, `npm run migrate:validate`.
- Site: `npm run lint`, `npx next typegen`, `npx tsc --noEmit --incremental false`, `npm test`, `npm run build`.

The fixture injects only the provider network and TEST inventory, never successful SDK validation. It exercises the actual SDK's public middleware and onCallback APIs. The same vertical fixture also drives the candidate confirmation component through the actual BFF action and mounted Backend HTTP route, losing a committed confirm response and recovering it. Additional mounted Site tests cover stale generations and back/forward navigation. No live Auth0 tenant or deployed endpoint has been attested by these tests.
