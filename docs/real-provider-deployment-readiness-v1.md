# Real provider and deployment readiness V1

Status: non-value, unmounted implementation with AUD-RPDR-01/02 corrections for focused re-audit. No production configuration, provider request, deployment, transaction signer, observer, wallet route or economic activation is supplied. Test policy values and `.example` endpoints are fixtures, not approved operating policy.

## Predecessor, scope and evidence

The exact independently accepted provider-readiness head `b798a6362f22a513eaea3d735f91558f974de52b` merged normally through protected Backend [PR #7](https://github.com/zephyon-labs/zephipay-backend/pull/7). Required hosted `verify` passed. The merge tree equals the accepted tree. This package starts at canonical Backend `4d9b6e4529559f480896278ea6d2a6e7eda670f7` and preserves the accepted generic provider verifier and database authority model.

Backend alone changes. There are no schema, migration, package, lockfile, server, route, environment-variable or SDK contract changes. New modules under `src/economic/readiness` are explicitly constructed adapters. Extracting the existing eager RSA initializer lets both profiles share the same key validation; it does not relax the generic token profile. Site, Frontend and Protocol remain unchanged. No rollout or downstream migration is part of this package; Protocol remains pinned to `v0.4.0`.

Read-only source evidence:

| Repository / revision | Inspected contract |
| --- | --- |
| Backend base above | `src/auth/authMiddleware.ts`, `src/config/environment.ts`, canonical identity repositories, accepted provider/composition modules |
| Site `80883547ca42b83f8f80e417e733feeca9c11ae8` | `src/lib/auth0.ts`, `src/lib/auth/sessionSafety.ts`, `authRouteSurface.ts`, `serverAuthority.ts`, `logoutPost.ts`, `navigation.ts`, `src/proxy.ts`, installed Auth0 SDK callback implementation |
| Frontend `5e16913a3dddf8c9157721e5481346365295df3c` | No separate Auth0 implementation identified in application source/package inspection; no native/mobile flow claimed |
| Protocol `921628b0662b18ac33a7b4efc4094d57408b6e66` | Existing Backend dependency remains `github:zephyon-labs/zephyon-protocol#v0.4.0`; no Runtime edits |

Official provider documentation was consulted for this study on 2026-10-03. Installed Site SDK is `@auth0/nextjs-auth0` 4.26.0, with package range `^4.26.0`; Backend uses `express-oauth2-jwt-bearer` at `^1.9.1`. No SDK upgrade occurred. No `.env` contents, bearer tokens or deployed secrets were inspected. Code establishes Auth0 and the configuration contract; it does **not** attest the deployed tenant hostname, client ID, API audience, access-token dialect, tenant plan, connection assurance or Management API entitlements. Those remain required operator evidence.

## Actual provider profile and capability matrix

Site uses an Auth0 confidential web application through the server SDK. Required configuration names include `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `APP_BASE_URL` and `AUTH0_AUDIENCE`. Backend pins `AUTH0_ISSUER` as an HTTPS issuer with trailing slash and an API audience. These identifiers must be authenticated deployment configuration, never chosen from a request. The API audience identifies the resource and differs from the web client ID.

The current Backend middleware permits RS256 `JWT`/`at+jwt` types and normalizes issuer, subject and optional session/authentication metadata. The new adapter deliberately selects the documented **Auth0 default access-token profile** (`typ: JWT`, `azp`). An operator must attest that the tenant uses that profile before wiring it. RFC 9068 uses a different claim/type contract and is rejected by this adapter pending a separate explicit adapter. Auth0 distinguishes these profiles and may include the API and UserInfo resources in the audience. [Access-token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles), [access-token audience](https://auth0.com/docs/secure/tokens/access-tokens/get-access-tokens).

Status meanings: REQUIRED is a deployment obligation; SUPPORTED is implemented or evidenced in the selected flow; UNSUPPORTED is deliberately rejected by this adapter; UNKNOWN needs actual tenant/deployment evidence; DEFERRED requires another integration package. These statuses do not assert production readiness.

| Capability | Status | Evidence / boundary |
| --- | --- | --- |
| Auth0 as existing web provider | SUPPORTED | Site configuration and SDK; provider replacement unnecessary |
| Exact tenant issuer, API audience and web client binding | REQUIRED | Signed profile plus separately pinned fingerprint/revision; no request overrides |
| Deployed tenant/client/audience literals and selected token dialect | UNKNOWN | Configuration shape inspected; production settings not retrieved |
| Default-profile RS256 API JWT with `azp` | SUPPORTED | Separate Auth0 adapter; strict known key, issuer, resource, client and scope |
| API audience plus exact issuer `/userinfo` audience | SUPPORTED | At most two distinct accepted audiences; arbitrary extra resources rejected |
| RFC 9068 access token, HS256, opaque token, token-directed keys | UNSUPPORTED | No permissive profile fallback |
| Human web principal under selected client | REQUIRED | Reject known M2M markers; client grant configuration must also exclude M2M/delegation |
| Organizations, agent/delegated principals, rich authorization profile | UNSUPPORTED | Explicit organization/delegation claims rejected pending separate policy |
| Guaranteed access-token `sid`, `jti`, `auth_time`, `acr` | UNSUPPORTED | Not a baseline Auth0 default-profile guarantee; no synthesized signed claims |
| ID-token `auth_time` after `max_age` authorization | SUPPORTED | Verification seam checks nonce, subject, chronology and explicit assurance |
| Actual connection-specific fresh human/MFA evidence and `acr` values | UNKNOWN | Upstream SSO may not imply new human interaction; policy requires attestation |
| Auth0 public JWKS / signing-key rotation | SUPPORTED | Public RSA keys and bounded certificate metadata projection; authenticated delivery contract below |
| Live HTTPS snapshot publisher / current-head store | DEFERRED | Injected signed-artifact transport only; no remote production fetching |
| Current web refresh-token retention | UNSUPPORTED | Site removes `offline_access` and strips refresh token before session save |
| Management API session deletion / refresh revocation entitlement | UNKNOWN | Tenant plan, scopes, grant behavior and propagation must be demonstrated |
| Back-channel logout in current Site route surface | UNSUPPORTED | SDK route is not exposed by current allowlist |
| Provider ID/token proof as exact economic consent | UNSUPPORTED | Separate confirmation challenge and canonical authority required |
| Production TLS, workload identity, secret-store isolation | DEFERRED | Fixture adapter is evidence of verification logic only |

## Signed, derived and unavailable claims

| Input / generic requirement | Auth0 source or replacement | Meaning and restrictions |
| --- | --- | --- |
| `iss`, `sub` | Provider-signed access token | Exact issuer and nonempty subject; neither is a payment identity |
| `aud`, `azp`, `scope` | Provider-signed default-profile access token | Exact API, permitted UserInfo companion, selected client and required scope |
| `iat`, `exp`, optional `nbf` | Provider-signed token | Issuance/expiry/validity only; bounded lifetime, no future issuance or economic clock tolerance |
| `email`, `email_verified` | Existing provider/account flow | Existing onboarding continues; email is not the canonical external-identity key |
| Generic `zep_environment`, `zep_context` | Unavailable as baseline Auth0 claims | Environment/configuration fingerprint derive from verified deployment configuration; action/resource belong to a server challenge. They are never relabeled as Auth0-signed claims |
| Generic `sid` | Not guaranteed in access token | Canonical ZephiPay session ID is server-owned and per-device; optional provider session references remain subordinate |
| Generic `jti` / one-use access token | Not guaranteed | Ordinary API bearer token remains reusable authentication. Durable one-use confirmation challenge is the future bounded mechanism, not invented `jti` or reuse of the token digest as consent |
| `auth_time` | Verified ID token from requested reauthentication | Required for the reauthentication seam; missing evidence fails. Access-token `auth_time` is not used as economic freshness authority |
| `acr` / `amr` | Provider/connection-dependent | Explicit configured `acr` allowlist required by seam; no guessed mapping from `amr`, `iat`, silence or login success |
| Wallet ownership / payment intent / Runtime approval | Unavailable from provider authentication | Independent signatures, exact-envelope consent and Runtime decisions remain required |

`Auth0AuthenticationVerifier` returns a verifier-local, frozen `authentication-only` proof. It cannot create the generic `ProviderTokenVerifier` proof or call the accepted generic single-use consent path. The separate `reauthentication-only` result is also not consent. It is presently consumed by no route. Removing assumptions about Auth0 claims therefore does not silently relax the accepted generic economic authority.

Canonical resolution stays `(provider issuer, provider subject) -> external_identities -> account -> payment_identity`. Each canonical session is independently identifiable, expires, and can be revoked. Account version/CAS remains authoritative. Multiple devices sharing one provider subject must never collapse into one session. Provider session IDs, when available through a verified channel, are optional mapping metadata; they cannot revive or replace canonical truth.

## Authenticated snapshot delivery and durable provenance

The trust chain is: externally pinned configuration root/fingerprint -> signed deployment profile -> pinned snapshot publisher -> signed current-head registration and signed snapshot -> eagerly initialized public-key resolver. A second endpoint-attestor root protects the database endpoint contract. These are separate trust roles. A provider HTTPS response is not itself a ZephiPay signed snapshot: a reviewed publisher must verify that response and attest its origin before publication.

`Auth0Snapshots.refresh` calls an injected `SnapshotTransport.acquire` for exactly `issuer + .well-known/jwks.json`, with redirects rejected, a 32,768-byte limit, abort signal and five-second acquisition timeout. `MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES` derives directly from the strict parser's unchanged `MAX_ECONOMIC_JSON_BYTES`; acquisition, artifact verification and service-message peeking use that effective ceiling. The earlier 131,072-byte outer allowance could never pass the 32,768-byte parser and is removed. The eventual publisher must perform CA and hostname verification for the exact authenticated issuer, enforce response and decompression bounds while reading, reject redirects/alternate domains, and apply an outbound allowlist. An outer serialized artifact must also fit the acquisition cap, so envelope/escaping overhead further reduces its available inner payload; 32 KiB is a ceiling, not a promise that every maximum-size payload fits every transport. No `jwk`, `jku`, `x5u` or certificate URL from a token is fetched. The implemented transport is a fixture contract, not an HTTPS client or an attestation that deployed TLS already exists.

The signed snapshot carries provider, deployment ID, environment, issuer, configuration fingerprint, source URL, trusted adapter ID, acquisition time, expiry, revision, previous accepted revision and JWKS. Payload SHA-256 identifies exact signed content; a separate normalized-key fingerprint identifies the projected key set. The separately signed head names configuration, revision, exact snapshot fingerprint and expiry. Snapshot validity is bounded by explicit profile policy, with no default grace extension. `previousRevision` must link to the active snapshot during replacement; reconstructed instances additionally need the authoritative external head and durable DB revision.

The actual Auth0 JWKS representation can include public certificate/thumbprint metadata. The adapter explicitly bounds and removes `x5c`, `x5t`, `x5t#S256` before passing public RSA fields to the unchanged strict initializer. Those metadata are never an alternate key trust path. Private or unknown members fail. Every one of at most 16 keys must eagerly pass canonical integer, RS256, public verify-only import, minimum 2048-bit strength and cryptographic usability checks before atomic publication. [Auth0 JWKS](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets), [key-set properties](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-set-properties).

AUD-RPDR-01 reproduced the exact published `x5t` value `NjVBRjY5MDlCMUIwNzU4RTA2QzZFMDQ4QzQ2MDAyQjVDNjk1RTM2Qg`. Its 54 unpadded base64url characters decode to the 40 ASCII characters `65AF6909B1B0758E06C6E048C46002B5C695E36B`, rather than a 20-byte binary digest. An authenticated snapshot with usable fixture RSA material was rejected; removing that metadata initialized the same RSA material. This is compatibility with an Auth0 **documentation example**, not evidence about every tenant or ZephiPay's unattested tenant.

The supported source-profile policy is deliberately narrow:

| Metadata | Supported encoded form | Validation before projection |
| --- | --- | --- |
| `x5t`, standard | 27 canonical unpadded base64url characters encoding 20 bytes | Exact encoded length and alphabet before decoding; decoded length and canonical round trip |
| `x5t`, documented Auth0 form | 54 canonical unpadded base64url characters encoding exactly 40 uppercase ASCII hexadecimal characters | Exact encoded length and alphabet before decoding; canonical round trip and `[0-9A-F]{40}` after decoding |
| `x5t#S256`, standard only | 43 canonical unpadded base64url characters encoding 32 bytes | Exact encoded length and alphabet before decoding; decoded length and canonical round trip |
| Other forms | Unsupported | No raw hex, hex prefix/separators, padding, whitespace, invalid alphabet, case folding, mixed-case/lowercase encoded hex, overlong value or SHA-256 hex extension |

The standard forms follow [RFC 7517 §§4.8–4.9](https://www.rfc-editor.org/rfc/rfc7517.html#section-4.8). The alternate form is limited to `x5t` and the source profile above. Encoded lengths distinguish the supported representations without heuristic repair. No thumbprint normalization is retained: after validation, metadata is deterministically removed, leaving the same RSA verification projection and fingerprint as omission of that metadata. RSA integers never enter this compatibility path. Duplicate JSON members, including escaped aliases, fail in the strict parser; duplicate key IDs fail in the unchanged key initializer. Both supported thumbprint algorithms may coexist as independent metadata; this adapter does not assert certificate/thumbprint/RSA equality or derive trust from them.

AUD-RPDR-02 adds pre-decode signature validation. Ed25519 signatures are exactly 64 raw bytes, represented here by `ceil(64 * 4 / 3) = 86` unpadded base64url characters. `assertArtifactBounds` rejects wrong type, length or alphabet before `Buffer.from`, parsing or signature verification. Decoded length, canonical round trip (including unused trailing bits) and actual pinned-key signature verification remain mandatory. Payload character length is checked before its UTF-8 byte count, and the byte count before buffer allocation/verification. Service-identity peeking applies the same guard before parsing an unauthenticated message. [Ed25519 signature encoding](https://www.rfc-editor.org/rfc/rfc8032.html#section-5.1.6).

The ingestion review retains bounded key IDs (512 characters), positive safe-integer revisions and exact source/adapter comparisons to bounded authenticated configuration. Key count is at most 16 before projection/import. Certificate metadata is at most four canonical base64 entries, each at most 8,192 characters before decoding; thumbprints are at most 54 characters before decoding. Aggregate payload size still wins over all per-field maxima. The unchanged RSA initializer separately bounds public integers before decoding/BigInt work and rejects weak/private/non-verification keys before eager import. Public certificate metadata is never parsed into an alternate verification key. The parser remains limited to 32,768 bytes and 24 levels of nesting; it was not enlarged.

Publication swaps one immutable provenance/resolver pair after all awaits and a second head check. An invalid or losing concurrent replacement cannot partially install or overwrite a winner. Verification rechecks snapshot identity and current registration after cryptographic work. `ProviderDeploymentReadiness` combines this with actual service LOGIN/ACL checks, endpoint attestation and equality to `economic_deployment_identity.provider_key_revision` before and after the callback transaction.

`persistProvenance` writes only public provenance and hashes to an operator-owned directory, using exclusive creation, byte-identical retry verification, file sync and directory sync. It persists no token, private key or bearer credential. This audit record is not a key cache, current-head store, or accepted trust source. Retention policy and export to an operational audit sink remain deployment decisions. A crash leaving an incomplete record fails a later conflicting retry; it does not promote incomplete metadata to trust.

The fixture `readHead` function represents a trusted, versioned control-plane store. Production must enforce a persistent monotonic revision floor outside ordinary service control, authenticate reads, bound read latency, and refuse restoring an older head after restart. Signature and expiry alone do not prevent replay of a formerly valid head. DB revision is a second floor, not a replacement for external identity. No control-plane store or mutable network cache is implemented here.

Offline startup may use a cached **signed full snapshot** only if its signature, source/configuration, age, current authenticated unexpired head, durable DB revision and endpoint/LOGIN checks all pass. No network is inherently needed to import a valid cache, but absence of authoritative head or endpoint evidence blocks readiness. A process cannot extend cache expiry locally. Unknown `kid` fails without on-demand token-directed discovery. A failed attempted replacement leaves valid old material intact only while that old revision is still the accepted head and DB revision.

## Recent authentication and exact approval intent

`iat != auth_time`. Refresh or silent SSO does not establish a new human confirmation. Auth0 documents `max_age` and the resulting ID-token `auth_time`; `prompt=login` alone is not a sufficient server-verifiable recency policy. A federated connection may perform an upstream exchange without a new human credential entry. The selected connection and assurance policy must be tested before calling its evidence fresh human/MFA authentication. [Auth0 reauthentication semantics](https://auth0.com/docs/authenticate/login/max-age-reauthentication).

The future step-up integration must independently require, as configured by reviewed Runtime policy: active canonical session; recent provider authentication; specified assurance; fresh exact-envelope ZephiPay consent; wallet/customer signature; Runtime approval. No monetary threshold is selected. None of these requirements implies the others.

The implemented callback seam verifies a signed ID token against the selected client audience, issuer, key revision, nonce, expected subject, `auth_time`, `acr`, issuance and expiry. `auth_time` must be at or after challenge request time, no later than issuance, and within explicit maximum age. Missing freshness/assurance fails; it never falls back to `iat`. The challenge includes canonical session ID, exact envelope digest, fixed confirmation action, nonce, request/expiry times and permitted assurance. The returned digest binds all those supplied fields. All inputs to this seam must come from a **server-stored trusted challenge** after the existing SDK callback succeeds.

This package does not store/consume that challenge, attest current session/account eligibility inside the reauthentication method, provide its browser transport, or issue real economic consent. A production bridge remains blocked until it implements this sequence:

1. Resolve the linked canonical account and active individual session. Generate an unpredictable challenge and persist issuer/subject, deployment/configuration, account/version, session, exact immutable envelope/resource digest, action, nonce, assurance policy version and expiry. Bind it to the initiating browser transaction without making browser input authoritative.
2. Invoke the established SDK authorization flow with policy-approved reauthentication parameters and transaction binding. Keep state, PKCE verifier and nonce under SDK/server control. The ID token is accepted only from the verified callback, not a public token upload endpoint.
3. Verify challenge/ID token evidence; use authenticated identity-to-issuer transport for the bound result. Recheck current key/configuration, canonical account/session/version and all policy deadlines after any wait.
4. Atomically consume the durable challenge and write immutable exact-envelope consent under the accepted account/session locking discipline. Concurrent replay, revoked session, changed envelope, stale version or a different device must fail. Preserve a stable operation idempotency/result lookup distinct from authentication replay handling.
5. Carry all deadlines into subsequent claim/contact guards. A browser boolean, possession of an API token, an ID token, transport signature or challenge digest alone cannot approve destination, amount, wallet ownership or economic authorization.

## Existing browser, callback and refresh boundary

The existing Site flow remains in charge of browser authentication. Installed SDK 4.26.0 code generates state/nonce and PKCE S256, stores an encrypted transaction including `max_age`, validates the callback transaction, exchanges the code with its verifier, and processes the ID token with expected nonce and maximum authentication age. It sanitizes return targets. The SDK owns those protocol checks; ZephiPay should not duplicate or bypass them. [Auth0 Next.js SDK](https://github.com/auth0/nextjs-auth0).

ZephiPay additionally allowlists only GET login/callback/logout SDK routes; access-token, MFA, passwordless, connect-account and back-channel routes remain unexposed. `serverAuthority.ts` uses server `getSession`/`getAccessToken` only when application session ordering is usable. `proxy.ts` maintains login/logout/callback gesture and ordering fences; only completed callback session-cookie installation clears the logout barrier. POST logout requires exact configured application Origin before redirecting to SDK logout. Typed internal navigation and SDK return-target sanitization protect current return paths.

Production callback requirements are a fixed trusted `APP_BASE_URL`, exact allowlisted callback/logout URLs per environment and client, secure HttpOnly SDK cookies, same-site policy appropriate to the flow, validated state/nonce/PKCE and no redirect URI derived from forwarded/request input. Auth code single-use and SDK transaction validation protect callback replay; the economic challenge still needs its own durable one-use ledger. Rotate/create canonical session binding on successful new login and reject fixation to a client-chosen session. Never log tokens/codes or leave callback secrets in telemetry, referrers or support exports. Actual proxy/cookie/domain settings and browser canaries remain deployment evidence, not proven by source inspection. [Auth0 redirect configuration](https://auth0.com/docs/authenticate/login/redirect-users-after-login).

Current Site sets nonrolling sessions with a seven-day absolute duration, secure cookies in production and `sameSite: lax`; `sessionSafety.ts` removes `offline_access` and discards any refresh token before saving. The browser is not given the SDK access-token endpoint. Tokens used to call Backend remain server-owned in this flow. Provider SSO may still allow a later login without human interaction; that cannot satisfy recent human confirmation by inference.

No service currently receives new refresh capability through this package. If approved later, the web BFF owns its confidential-client refresh credential; identity/issuer services must not inherit its client secret or cookie key. Retention, encrypted storage, rotation, reuse detection, absolute/inactivity expiry, grant/session linkage and revocation must be reviewed together. No volatile fallback or reusable economic-consent grant follows from a refresh token. Auth0 refresh-family rotation/reuse behavior and grant-level revocation depend on configuration and must be verified for the tenant. [Refresh rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation), [refresh revocation](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens).

## Logout, devices and outage behavior

Application logout, Auth0 session logout and upstream identity-provider logout are separate layers. Current Site logout does not establish immediate revocation of every previously issued API token. Canonical ZephiPay session revocation is the authoritative boundary for future economic consent/claim/contact, with account-version checks where required. Provider logout/notification must arrive through an authenticated, replay-controlled integration before changing canonical state. Auth0 Management API session capabilities can depend on enterprise entitlement; session deletion and refresh-token effects are not interchangeable or assumed immediate. [Logout layers](https://auth0.com/docs/authenticate/login/logout), [session management API](https://auth0.com/docs/manage-users/sessions/manage-user-sessions-with-auth0-management-api).

Revoke only the selected canonical session for device logout unless an explicit account-wide action is authorized. Other legitimate devices remain distinct. A future provider `sid` mapping may locate affected sessions but must not collapse all sessions by subject. Historical receipts, consent and contact evidence remain immutable. Revocation stops future authority at the established transactional boundary; it cannot undo an external effect that may already have occurred. Already-contacted operations continue through bounded observation/reconciliation and preserve ambiguity until resolved.

| Outage or transition | Required behavior |
| --- | --- |
| Existing canonical session, current verification material | Existing low-risk/read-only behavior may continue only under its existing route policy and ordinary expiry; session alone cannot replace a required access-token check |
| New login when Auth0 authorization/code exchange is unavailable | Fail/retry safely; do not provision identity from unverified browser claims |
| Token refresh | Absent in current Site retention model; any future refresh fails closed on outage/rotation failure |
| New sensitive confirmation | Require all freshness/assurance/challenge/canonical guards; no outage waiver or fabricated recent authentication |
| Snapshot delivery fails but accepted cached snapshot/head remain valid and DB revision matches | Known keys remain usable until existing deadlines; failed refresh does not itself revoke valid tokens |
| Unknown key, expired snapshot/head, unavailable authoritative head, or advanced DB revision | Reject new provider-backed readiness/authority; do not accept unknown keys, downgrade algorithms or extend expiry |
| Already-contacted operation | Reconcile existing contact/effect evidence; do not resend or pretend the effect vanished because login/provider is unavailable |

## Minimal deployment topology and credential ownership

Preserve six authority compartments: identity/session, economic app, issuer with Runtime SDK, signer-result, observer, reader/support. The existing Site BFF remains a separate browser-facing owner of its web credentials. Runtime evaluation can coexist with the issuer process through the canonical SDK; splitting every Runtime engine into a service adds no required boundary. Public configuration/key caches and each service's own adapters may coexist with that service. Reader support stays separate from writable authorities. The test orchestrator holding all dummy credentials is never a production topology.

Separate OS/service identities, secret mounts, pools and network policies are required even if infrastructure schedules processes on the same host. No ordinary process may load another writable role's credentials or fall back to an all-purpose Backend database URL. A common host administrator or control plane remains a trusted compromise boundary. Migration/admin, configuration signing, snapshot publication and endpoint attestation are separate administrative capabilities, not ordinary application secrets.

Each production LOGIN must be an exact signed-manifest value, proposed naming `zp_<environment>_<role>_g<N>`, with only the corresponding accepted group membership. No production LOGIN is created here. Fixtures use exact `provider_fixture_identity`, `provider_fixture_app`, `provider_fixture_issuer`, `provider_fixture_signer`, `provider_fixture_observer`, `provider_fixture_reader`, generation `1`, with separate rotation fixtures. DB passwords are test-only and never model a shared deployment secret.

| Service | Database credential | Provider configuration / credential | Signing capability | Allowed network | Secret ownership / rotation owner | Forbidden secrets |
| --- | --- | --- | --- | --- | --- | --- |
| Site BFF | No economic authority LOGIN | Auth0 web client ID/audience/domain; confidential client secret and SDK cookie key | Browser transaction/session protection only | Exact Auth0 endpoints; approved Backend API | Web identity operator owns client/cookie rotation | All economic DB LOGINs, snapshot/config signing roots, transaction keys |
| Identity/session | One identity LOGIN/pool/generation | Public issuer/client/resource/profile and verification material | Own workload-message key; no provider signing key | Own DB; approved snapshot/head source; issuer/application auth boundary | Identity service secret mount; offline credential operator rotates | App/issuer/signer/observer/admin DB secrets; BFF client/cookie secrets |
| Economic app | One app LOGIN/pool/generation | Public deployment identity; no provider secret | Own workload-message key | Own DB; explicitly authorized identity/issuer/signer-result/observer contracts | App secret mount; offline credential operator | Identity/issuer/signer/observer/admin DB secrets; provider secret; live signing key |
| Issuer / Runtime | One issuer LOGIN/pool/generation | Public verification/configuration; reviewed Runtime source/policy identity | Own workload-message key and existing evidence authority; no customer wallet key | Own DB; approved key/head source and Runtime integrations | Issuer secret mount; separate Runtime/configuration and credential owners | Identity/app/signer/observer/admin DB secrets; BFF credentials |
| Signer-result | One signer LOGIN/pool/generation | Public deployment configuration only | Own workload-message key; synthetic result authority only here | Own DB; explicitly authorized contact/result boundary | Signer-result secret mount; credential operator | Other DB roles; provider secrets; **no live transaction key in this package** |
| Observer | One observer LOGIN/pool/generation | Public deployment configuration only | Own workload-message key; synthetic observation authority here | Own DB; approved synthetic observation boundary | Observer secret mount; credential operator | Other DB roles; provider/signing secrets; no live observer connection here |
| Reader/support | One reader LOGIN/pool/generation | Public configuration only | Own workload-message key, no economic writes | Own DB/read summaries; authenticated support gateway | Reader secret mount; credential operator | All writable LOGINs, raw tokens and all authority/private provider keys |
| Offline administration / control plane | Migration/provisioning root, separately controlled | Config/distribution/endpoint trust-root administration; any later Management API capability separately scoped | Administrative artifact signatures, not ordinary-service keys | Reviewed administrative paths only | Distinct operators/secret policies and auditable changes | Never bundled into any ordinary image, env or pool |

The fixture has distinct configuration, distribution, endpoint and per-service Ed25519 keys. These sign **readiness artifacts/messages only**, never a transaction. Production workload-key binding and rotation need authenticated, versioned control-plane registration as well as TLS. Public keys passed to the test adapter are trusted constructor inputs, not keys accepted from a request.

## Service transport contract

`ReadinessServiceTransport` is a non-network mutual message-authentication adapter. Each caller signs its request with its own key; the recipient verifies an allowlisted caller/method/path and signs its response. Client verification pins the selected server key. Signed fields include both role identities, exact endpoints, both credential generations, deployment/environment/configuration, request UUID, method/path, body hash and at most 60 seconds of validity. Responses additionally bind the full verified request fingerprint. Separate bodies remain bounded at 64 KiB; only their digest enters the signed message. Message payloads share the effective 32 KiB artifact/parser ceiling, with exact 86-character signatures checked before identity peeking. This reconciles the prior outer size declaration without changing identity, replay, generation or request/response semantics. No arbitrary unauthenticated internal HTTP is an accepted deployment model.

| Future boundary | Caller -> server identity | Permitted purpose / integrity requirement |
| --- | --- | --- |
| Canonical authentication/session resolution | App -> identity | Resolve verified principal into current canonical context; no caller-created identity truth |
| Bound confirmation result | Identity -> issuer | Server-owned challenge/envelope/session/version evidence; still requires atomic canonical/consent checks |
| Economic evaluation | App -> issuer / Runtime | Exact envelope/resource and operation id; issuer invokes canonical Runtime SDK, not caller-supplied approval |
| Contact/result coordination | App -> signer-result | Only accepted fenced contact contract; fixture result here, never arbitrary signing bytes |
| Observation coordination | App -> observer, observer -> app if explicitly registered | Exact operation/contact identity and bounded reports; transport identity does not prove chain truth |
| Reader/support | Authenticated app/support boundary -> reader | Authorized projections only; no read request may acquire write authority |

No production routes for this table are added. Exact allowlists must be authenticated configuration per receiving service. Production transport should combine verified TLS and workload identity (for example reviewed mutual TLS) with these request bindings and a **durable shared atomic replay ledger**. The fixture injects a ledger; in-memory test state proves concurrency/reconstruction logic in one harness, not durable service deployment. Ledger outage fails closed; replay is rejected before handler admission. Retry requires a new authenticated message and the same separately authorized operation idempotency key. If processing crashes after replay consumption, recovery must query/continue durable operation state rather than re-execute blindly. Ledger storage/handler atomicity and result recovery remain design gates.

Mutual signatures alone do not attest confidentiality, network isolation, correct server code, current deployment registration or live TLS. Every future handler must also run the current deployment/credential guard. Old equally stale peers must not authenticate each other into authority after a cutover merely because they share obsolete configuration. Rotate workload keys, signed configuration and DB generations as a coordinated operation; use an explicitly reviewed overlap only if needed, never an automatic old-key fallback.

## Database, endpoint and configuration identity

`AuthorityProcess` still accepts exactly one pool and checks the actual LOGIN, group flags/membership, complete current-database ACL inventory, owners, deployment registration and credential generation. `DeploymentReadiness` binds that instance to the signed profile's exact role/LOGIN/generation and independently signed endpoint proof before and after work. `ProviderDeploymentReadiness` adds current provider snapshot and durable key revision. Wrong-role pools, admin fallback, altered generation and mismatched registrations fail. No `SET ROLE`, broader alternate connection or generic environment fallback is introduced.

Production database connections require verified TLS with a pinned expected hostname and approved trust root; Node `pg` configuration must explicitly enforce certificate verification/server name and prohibit URL options that override it. PostgreSQL documents the hostname plus trust-chain protection of `verify-full`; encryption alone does not identify the intended server. [PostgreSQL TLS](https://www.postgresql.org/docs/current/libpq-ssl.html).

The endpoint proof models an external attestor reporting expected hostname, peer fingerprint, deployment/configuration, process nonce, verification time and at most 60 seconds of validity. The attestor key is independently pinned. Copied database rows cannot produce a valid proof for the wrong endpoint; tests reject wrong hostname, fingerprint, nonce, configuration and expiry even with valid DB registration. However, the fixture runs over a local Unix socket: **it does not measure TLS or bind an actual production pool socket to that proof**. A trusted connector/sidecar must later observe the particular connection, mint a fresh process challenge proof, and enforce that correlation for pool replacement/reconnect. Table identity and a free-standing attestation are insufficient without this external control-plane/connection binding.

The signed deployment manifest binds mode, provider/dialect, deployment/environment/revision, exact issuer/resource/client/key source/adapter, explicit token/snapshot lifetimes, DB identity/peer/attestor, and six exact LOGIN generations/endpoints. An independently bootstrapped fingerprint/revision prevents an alternative signed configuration being substituted silently. Verified objects are frozen and constructor-branded. Root-key/fingerprint distribution and persistent revision floors must be controlled outside ordinary service memory and the database being attested.

Future production configuration must additionally version exact accepted assurance/connection values, challenge policy, Runtime source/policy identity, route allowlists and workload public keys. Those remain trusted constructor or server-challenge inputs in this readiness package, not a complete deployable configuration service. Request input cannot choose them. Configuration changes require audited publication, rotation and a new expected fingerprint; rollback of content uses a new revision rather than restoring an old accepted revision.

## Emergency rotation procedures

Provider verification-key cutover:

1. Obtain new public material through the approved authenticated source. Bound it, verify provenance and initialize every key before preparing publication. Auth0 may expose current/next and retained previous keys; do not assume a one-key JWKS. Decide overlap or immediate removal based on incident policy. [Auth0 signing-key rotation](https://auth0.com/docs/get-started/tenant-settings/signing-keys/rotate-signing-keys).
2. Build/sign a new immutable snapshot with increasing revision, previous accepted revision, config/source identity and deadlines. Persist public audit provenance. Publish its exact fingerprint in the authoritative head and advance the protected DB revision under a quiesced control-plane operation. Intermediate mismatches fail readiness; availability does not override consistency.
3. Start/reconfigure candidate services with the accepted snapshot. Require endpoint, LOGIN/ACL/generation, head/fingerprint and durable key-revision readiness. Resume traffic only after these gates pass. Existing and reconstructed stale processes/proofs fail; tokens for removed keys fail. An intentionally retained key works only under the newly accepted snapshot and policy.
4. Drain in-flight work and old instances/connections at the administrative cutover point. Existing pre/post guards protect bounded transactions but are not an atomic global DDL/process barrier. Preserve already-contacted operation evidence and recovery.
5. Assess sessions/consent created under a compromised key separately. Key removal does not automatically undo historical truth or revoke every canonical session; explicit canonical/evidence revocation may be required. Never lower the durable revision to roll back. Reintroduction of reviewed content requires a new higher revision and approval.

Service DB/workload credential cutover:

1. Offline admin creates a new distinct LOGIN with only the reviewed role group and a fresh secret/generation. Prepare new workload identity and signed deployment configuration. Do not grant admin or share a connection string to keep an instance alive.
2. Quiesce the role, advance registered LOGIN/generation, boot the new instance with its one new pool, and pass exact ACL, endpoint, profile and provider checks where applicable. Transition traffic only to that instance.
3. Retire old LOGIN ability/membership and old workload identity. Explicitly drain or terminate established old sessions, selected by exact old LOGIN/database and reviewed connection inventory, using separately authorized offline administration. `NOLOGIN` prevents new logins but does **not** kill already-established sessions; existing raw SQL is not magically invalidated. [PostgreSQL role attributes](https://www.postgresql.org/docs/current/sql-alterrole.html).
4. Guards reject established stale instances at operation boundaries; a generation change inside a guarded transaction causes rollback. Hard cutover still needs quiescence/connection termination because a check is not an indefinite lock against admin changes. No service silently reuses the old pool. Roll forward with another new generation if recovery is needed.

All cutovers in tests use disposable keys, fixture registrations and local database connections. No production role, provider key or session was rotated.

## Mobile compatibility

Future iOS/Android adapters retain the same Auth0 issuer plus subject mapping and server-created individual canonical session. Use separate explicitly registered native clients, authorization code with PKCE through the system browser, exact verified universal/app links or reviewed redirect schemes, state/nonce/callback replay controls, and no embedded confidential web-client secret. Secure token retention belongs in platform Keychain/Keystore under a separately reviewed refresh policy. Device loss and logout revoke that canonical session; explicit account-wide revocation remains distinct. Native reauthentication must satisfy the same server-stored challenge, real provider freshness/assurance and exact-envelope rules. The current one-client profile must be explicitly extended or instantiated for each approved native client; arbitrary client IDs are not admitted. No native UI or mobile integration is implemented.

## Compromise analysis

| Compromised boundary | Can fabricate / damage | Cannot establish by that compromise alone |
| --- | --- | --- |
| Auth0 signing/control plane | Provider identities, tokens and claimed authentication/assurance; denial of service | Customer wallet signatures, independent Runtime approval, actual chain effects; canonical guards still require their own truth, although a forged login can endanger identity/session authority |
| Snapshot transport without publisher key | Drop/delay/replay artifacts; cause outage | New accepted key material/configuration under valid signatures and current revision floors |
| Trusted snapshot publisher/root | Authenticate attacker keys in its allowed configuration; forge provider-authentication evidence when paired with such keys | Separate config/endpoint roots, wallet signature or actual settlement; control-plane compromise may widen this impact |
| Identity LOGIN/service | Corrupt permitted identity/session/account mapping and events, fabricate its transport assertions | Insert issuer consent/Runtime evidence or signer/observer reports under that DB role alone |
| App LOGIN/service | Prepare/claim/contact within admitted guards, send allowed requests, cause denial of service | Mint canonical sessions, issuer evidence, customer signatures or authoritative signer/observer truth |
| Issuer LOGIN/service | Forge consent/Runtime/binding evidence within accepted role privileges | Customer signatures, new canonical sessions, or real chain effects; it remains a trusted economic evidence authority |
| Signer-result LOGIN/service | Falsify/refuse admitted result reports | Provider auth, canonical consent or actual signing capability in this package; a future real signing key adds a separate risk boundary |
| Observer LOGIN/service | Falsify admitted observations and cause incorrect evidence within that trusted role | Actual external chain state, independent wallet signatures or provider authority |
| Reader LOGIN/service | Expose permitted metadata and withhold responses | Economic writes or other service credentials under enforced isolation |
| Deployment/control-plane administrator | Substitute trusted config/keys/endpoints, route traffic or distribute credentials within its actual reach | Independent external cryptographic facts; broad secret access can collapse compartmentation and must not be understated |
| Database admin | Alter rows, owners, ACLs, registration and all DB-based evidence; defeat DB safeguards | An external provider/customer signature or a real external effect merely by changing a table |

Collusion and shared host/secret-manager compromise can combine these powers. Message authenticity proves sender control, not truthfulness. External endpoint attestation cannot defend against its own trusted attestor/control-plane compromise. No claim of trustlessness is made.

## Validation, compatibility and remaining decisions

The audit handoff records exact commands/results and patch artifacts. Unit tests cover Auth0 profile negatives, malformed/unusable keys, authenticated provenance/configuration, interrupted verification, rotation races, stale reconstruction, outage, challenge binding and mutual transport/replay. Actual restricted LOGIN tests combine endpoint/profile/provider checks with the accepted database model, including canonical mapping/revocation, durable consumption and generation/key cutovers. The complete existing unit and PostgreSQL regression suites remain required. No schema change means no new migration; fresh application of unchanged migrations is validation evidence only.

Compatibility is established by isolation, unchanged Site/Frontend/Protocol and mounted Backend source, and regression tests. This is not a live Auth0 tenant, browser, Railway TLS or Vercel deployment canary. Existing login, logout, returning-user/email-verification and Devnet routes retain their current implementation. No protocol behavior moves into a downstream repository.

Production decisions still open: exact tenant/client/resource/dialect/grants; verified connection/assurance semantics; approved lifetime and challenge policy; provider Management API/revocation capabilities; authenticated HTTPS publisher and durable monotonic head store; signed cache retention; durable confirmation and transport replay/result recovery; connection-bound TLS endpoint attestation; workload identity/route-policy publication; secret-manager/process/network compartmentation; emergency cutover operators; native client profiles; non-value staging browser/provider/deployment canaries. No live integration may infer approval from this audit candidate.

No Mainnet, funds movement, transaction signing, RPC broadcast, fee sponsorship, live observer, custody, wallet activation or production deployment occurs. Existing Devnet behavior is unwired from these adapters. No ZERA qualification, registry addition, mint, distribution, staking, liquidity, routing or activation occurs. The 200,000,000 ZERA economic baseline is byte-for-byte unchanged.
