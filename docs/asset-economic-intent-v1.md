# Asset Identity and Economic Intent V1 — Backend integration

Status: unmerged audit candidate. Backend base:
`dc0caa951da973adb52ea4fa36612a763ebad74a`.
Protocol base after audited architecture closure:
`82862e2b28c15e05d95026b391df82092ce89805`.

## Ownership and operational boundary

The SDK owns canonical identities, atomic amounts, envelope serialization/digests,
consent/Runtime references, signature inspection, offline profile checks and pure
attempt transitions. Backend imports these definitions instead of copying policy.
Backend owns current-record adaptation and the future persistence contract.

No route, request validation, existing worker, persistence implementation, migration,
allowlist, source key, mint configuration, receipt, activity projection or deployment
is changed. The new modules are not imported into the application composition.
Current Devnet remains server-funded/server-signed, six-decimal Circle Devnet USDC.
No wallet provider, Mainnet endpoint, live key, ZERA route or asset router is added.

## Current Devnet compatibility projection

`normalizeCurrentDevnetIntentV1` projects an existing direct-wallet PaymentRecord
and validated preparation policy into explicit asset/authority metadata. It requires
the current Circle Devnet mint, Classic SPL program and six decimals. Amount is the
existing stored atomic integer, without rescaling or changing legacy parsing limits.

The trusted asset definition must contain qualified genesis evidence established by
infrastructure; the adapter does not discover genesis or trust a client cluster label.
Tests use a deliberately synthetic genesis. No production identity is inferred from
those fixtures. Existing path behavior is untouched because this optional adapter is
not called by routes or workers.

The projection retains separate source and fee roles even though their current
operational public key is identical. It records the existing request hash, policy
hash, original destination and confirmation semantics. Destination ownership stays
UNVERIFIED; customer signature stays NOT_PRESENT; production Runtime evidence stays
NOT_ESTABLISHED. It never manufactures a production envelope or customer consent
from the Devnet session/confirmation. Private purpose text is not copied into a
potential public commitment. Existing receipts and API projections remain unchanged.

## P3-01 finalization identity/persistence contract

`newSponsorFinalizationClaimV1` generates a UUIDv4 on the server and copies a strictly
validated immutable SDK tuple. The ID cannot be supplied by the customer as signing
authority. UUID generation here creates no key, account, provider request or signature.

`resolveSponsorFinalizationClaimV1` is a pure contract decision, not a durable store:

- Same ID and tuple: replay the same operation/result.
- Same ID with changed tuple: conflict.
- Competing ID with identical tuple at the same intent/generation: converge on the
  existing ID; do not allocate another signer operation.
- Competing tuple, stale or cancelled generation: conflict.
- RESULT_UNKNOWN: preserve the existing identity and retrieve that operation.

A later persistence implementation must enforce both ID uniqueness and unique
`(intentId,generation)` atomically with current-generation fencing, cancellation,
exposure reservation and operation creation. Do not omit generation checks because
a signature verifies. The pure function must run against locked/serialized current
records, not an old client/worker snapshot. Stale A remains invalid after cancellation
and replacement B, even if the exact signed A artifact arrives later.

COMMITTED and RESULT_UNKNOWN never authorize a new ID on timeout. Returned complete
artifacts must match the immutable tuple/message, expected signature slots and stored
operation before durable result publication. Query/recovery is not a second signing
request. Creation's one-time operational grant must be return-only; lease expiry
must never regenerate it. No implementation of that atomic repository or production
signer is included. No PostgreSQL schema changed; offline fixtures are not concurrency
proofs for a real database or signing provider.

## Audit-local SDK dependency and reproducibility

Protocol's additive candidate version is 0.4.0. Neither candidate is pushed or
published before audit. Backend consumes `file:vendor/zephyon-protocol-0.4.0.tgz`,
with npm lock integrity and a source/package SHA-256 manifest. This is a deliberately
local audit artifact, not a production release pin or permission to deploy.

To regenerate from the inspected Protocol candidate:

```sh
node scripts/prepare-asset-intent-sdk.mjs /absolute/path/to/protocol-candidate
```

The script builds and packs only the SDK allowlisted output, records Protocol base,
source digest and tarball digest, then updates the local dependency/lock. No publish,
Git push, tag or deployment occurs. Source digest includes sorted relative paths,
NUL, byte length, NUL and file bytes for src, build/package metadata and packaged
documentation. Review the source patch together with this generated artifact.

Fresh `npm ci` needs no unpublished Git commit and reproduces the exact audited
package. Before eventual protected release, approve/tag the SDK, then deliberately
replace this audit-local dependency with the approved immutable release pin and
revalidate Backend. Do not silently publish or deploy the local snapshot.

## Consumer and migration matrix

| Consumer | Status | Required work |
|---|---|---|
| Protocol/Runtime old exports and Mock/Devnet semantics | unchanged | New V1 exports are additive |
| Backend current payment/intent APIs and allowlisting | unchanged | No user-facing migration |
| Backend explicit Devnet projection | adapter required | New optional pure adapter, unused by routes |
| Backend SDK consumption | adapter required | Audit-local 0.4.0; approved release pin after audit |
| Existing preparation/submission/reconciliation/receipts | unchanged | Existing durable records stay readable |
| Site receipt/activity/status contracts | unchanged | No Site edits |
| Legacy Frontend | legacy/no new development | No new payment integration |
| Future source proof / sponsor persistence / Mainnet | future migration | Separate audited implementation and activation |
| Future web/iOS/Android signing | future migration | Same economic contract; qualified transport adapters |
| Creator/provider/agent extensions | future migration | Optional purpose/mandate references; no delegated execution |
| ZERA | unchanged | No mint/allowlist/default/route; independent later qualification |

Android qualification must require optional/deprecated MWA 2.0 sign-only support,
not merely signAndSend. iOS remains UNVERIFIED / CONDITIONALLY FEASIBLE. The SDK
contains a qualification-record validator, not installed or selected providers.

## Validation and release gates

Baseline before SDK replacement: 362 Backend tests passed. New adapter tests preserve
six-decimal values including minimum/max legacy amounts and reject alternate mint,
program, precision or network support. Finalization tests cover replay, conflict,
convergence, response loss, cancellation and stale callbacks. All tests are offline.

Run `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run migrate:validate`,
then `git diff --check`. Relevant intent, API, durable execution, reconciliation,
recovery and receipt tests are included in npm test. No persistence/schema behavior
changed, so PostgreSQL integration is not required for this package; it will be
mandatory for the later atomic repository implementation.

Deployment order after separate approval remains Protocol release -> Backend
compatible update/validation -> clients where needed. No simultaneous deployment
assumption, endpoint cutover or destruction of old reconciliation handlers.

Final local results: locked `npm ci`, lint and build passed; **379 tests passed**,
including 17 new compatibility/finalization tests and all 362 baseline tests.
Migration validation passed for 22 unchanged ordered migrations. Whitespace checks
passed. Dependency-audit findings were already present before the SDK substitution;
no unrelated dependency remediation is included. Neither feature branch is pushed.
