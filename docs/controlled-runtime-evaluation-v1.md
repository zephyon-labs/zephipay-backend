# Controlled Runtime Evaluation / Recovery V1

This Backend-only, local review candidate continues the accepted Real Runtime Adapter
from protected PR #13, canonical `138a8bbbcdcc5bc4843c0f0128c58cdeaa883d93`.
It exposes that adapter in the existing explicitly composed controlled web application.
Protocol remains Git-pinned v0.5.0. Production readiness remains **false**.

## Private interface and composition

The existing signed Site/BFF handoff gains two additive POST actions:

- `/internal/controlled-confirmation/runtime-evaluate`
- `/internal/controlled-confirmation/runtime-recover`

The signed body contains only `paymentId` and the existing SDK-owned `session` context.
The browser does not select a canonical session, challenge, envelope digest, amount,
asset, destination, policy, evidence, limits, time or decision. Unexpected fields fail.
There is one immutable preparation/ceremony per payment in this version; no generation
selection, replacement or implicit renewal is added.

Compose `ControlledWebConfirmation` with its accepted TEST-only identity readiness,
pinned distinct Site/request and Backend/response keys, and an explicit `ports.runtime`
closure calling the issuer's `RuntimePolicyAdapter.controlled`. That closure provides
the issuer endpoint attestation; Site receives no operational database credentials.
The ordinary Backend still mounts an unconfigured, closed router. Existing controlled
confirmation compositions without the optional Runtime port also reject these actions.
No environment flag, application startup, live provider, deployment or execution service
is enabled here. The existing Site BFF/UI and all its actions remain unchanged.

The same pinned handoff authenticates context, both origins, issuer/client, action,
body, exact request, expiry and response. PostgreSQL enforces handoff freshness and
durable replay rejection before provider credentials are read. A retry signs a fresh
transport request. It cannot reuse the previous signature.

Identity independently verifies the access JWT and scope, then loads the immutable
ceremony and exact web-session ownership. Only this server-loaded challenge reference
is passed to the issuer along with the payment reference and verified authentication.
The issuer independently resolves preparation, canonical session, provider-session
binding and the exact guarded challenge consumption. Callback success alone cannot
supply that consumption. Auth0 state, SDK nonce, PKCE, callback and consent admission
are unchanged.

## Explicit TEST inventory and Runtime authority

Before preparation, an offline administrator must explicitly call the accepted
`registerRuntimeTestProfile` with the qualified Devnet TEST asset, explicit amount cap,
versions, validity window and verified deployment configuration. Put the returned
profile digest/version/window in the administrative preparation profile before creating
the envelope. There is no default registration or fallback. The accepted adapter loads
and authenticates that registered profile; an unknown profile prevents evaluation.
No live database registration is performed by this package.

The issuer passes its server-derived references to the existing `evaluate` method.
Its evidence loading, locks, PostgreSQL clock observations, opaque full-record evidence
qualification and Protocol `RuntimePolicyEvaluatorV1` evaluation/verification are
unchanged. It independently qualifies the destination against the immutable direct-wallet
preparation and locally derived token account. No policy decisions are duplicated in
Backend presentation code. No username resolver or destination ownership claim is added.

Migration 033 remains the sole full Runtime decision ledger. No schema or role grants
change. SQL guards, immutable evidence/context and the unique payment/envelope/decision
identities remain authoritative. The identity, app, signer, observer and reader LOGINs
still cannot read or insert this ledger. No legacy Runtime approval record is written.

## Bounded results and recovery

Every signed Runtime response contains exactly `paymentId`, `mode`, `productionReady`,
`executionAuthorized`, `state`, `historicalStatus`, `currentApproval`, `decisionId` and
`expiresAt`. Unavailable identifiers/times are null. It contains no full decision,
envelope, provider artifact, evidence, policy or bearer authority. Runtime responses
use a distinct response type and are bound to the exact request/payment.

| State | Historical status | Current approval | Meaning |
| --- | --- | --- | --- |
| NOT_EVALUATED | NONE | false | Confirmed payment has no ledger decision at this observation; recovery creates none |
| APPROVED | APPROVED | true | Accepted adapter freshly verified approval; final database observation is within the full decision window |
| REJECTED | REJECTED | false | Terminal result for this exact evaluation identity; no fallback or replacement |
| EXPIRED | APPROVED | false | Full decision expiry passed according to PostgreSQL |
| NO_LONGER_CURRENT | APPROVED | false | Historical decision remains, but fresh verification did not establish current approval |
| UNAVAILABLE | APPROVED | false | History is authenticated, but current verification failed; no claim that a new policy rejection occurred |

All rows retain `mode="non-value"`, `productionReady=false` and
`executionAuthorized=false`. APPROVED describes a database observation, never an
execution authorization or a guarantee about future eligibility. It is not sent, paid,
signed, submitted, settled or completed. No transaction exists in this path.

Recovery requires current independently verified authentication and immutable ownership,
even when the old canonical session has expired or been revoked. This permits an owner
to inspect history; it does not revive their canonical session or consent. Ordinary
confirmation session guards remain unchanged. Full current approval still requires the
accepted issuer/Protocol checks. An expired access credential, unknown owner, changed
session reference or invalid handoff cannot read history.

For an existing APPROVED decision, the accepted adapter reconstructs current evidence
and invokes full Protocol verification only when it exactly matches the original
snapshot and validity window. Account-version change, session/consent revocation or
policy replacement therefore invalidates current approval without changing history.
Registry loss may prevent verification entirely; the product returns UNAVAILABLE only
after another fresh authenticated ownership/ledger read. SQL/readiness/authentication
failures in that final read still refuse the request. The same failure before a first
decision propagates as a generic authorization failure, without creating a rejection.

The destination snapshot is immutable in this version; there is no separately mutable
live destination-qualification service. Tests cover substituted token-account evidence
and loss of its underlying asset qualification. A future mutable destination authority
must invalidate current verification; it is not invented here.

Concurrent evaluations share the accepted intent lock and unique ledger identity.
Double clicks, transport retries, a lost post-commit response, fresh Site SDK readers and
reconstructed Backend instances converge on the same stored decision. Status-only
requests never create a first decision. REJECTED remains terminal even if later policy
or registry state changes. A new economic attempt requires a separately designed flow.

## Validation and review boundary

Validation includes unit response-contract/closed-router tests; private HTTP tests using
real restricted PostgreSQL LOGINs, actual installed Auth0 SDK confirmation and the pinned
Protocol evaluator; the unchanged Site SDK through the private boundary; exact references,
authentication, replay, missing consent/profile, rejection, concurrency, reconstruction,
expiry, revocation, account/policy change and qualification loss. The full PostgreSQL run
includes existing authority, provider, confirmation, upgrade and Site regression cases.
Use the existing `CONTROLLED_SITE_SOURCE` option to include cross-repository tests.

The existing PostgreSQL expiry helper and all timing assertions remain unchanged.
The new reconstructed-recovery equality test first observes the original decision's
issued-at boundary through that same helper and margin. This establishes a valid positive
fixture despite host clock corrections; all approval/equality assertions are retained.
The full regression also exposed a pre-existing composition expiry test that waited
on Node time with 20 ms headroom. Its session/Runtime deadline wait now uses the same
PostgreSQL helper; the exact rejection and zero-reservation assertions are unchanged.
The existing reservation-concurrency assertion now retains rejection messages when its
one-winner expectation fails; no outcomes, limits or assertion expectations change.
RUNTIME-OBS-01 diagnostics record only clock/context bounds and bounded decision metadata
around fixture failure; they contain no credentials and do not retry or soften checks.

Only Backend changes. There is no breaking contract, migration, privilege expansion,
Site UI change, wallet/sponsor change or deployment. Future deployment still requires
migration 033 and updated role provisioning **before** updated Runtime authority processes
start, followed by a separately authorized release. Vercel Git stays disconnected and
Railway's automatic deployment trigger stays removed.

This package ends at confirmed payment plus current non-value Runtime approval. It has
no transaction/message/blockhash preparation, wallet or signer contact, sponsor
finalization, submission, broadcast or reconciliation port. No Mainnet contact, funds
movement or ZERA activation occurs. ZephiPay remains useful without ZERA; the 200M supply
and allocation baseline are untouched. Phase B stays local for independent review.
