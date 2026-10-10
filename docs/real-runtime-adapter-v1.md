# Real Runtime Adapter V1 — non-value review candidate

The Backend consumes `github:zephyon-labs/zephyon-protocol#v0.5.0`, resolved in the lockfile to
`f565e55dce6b6b44cd5d1810902f8806cdb477dd`. Protocol PR #6 merged the accepted
`d660da0f83af5dbfec9abe0eb4ad2c5f70923c0d` tree without semantic changes. The established
GitHub release channel is used; no npm registry publication is required or claimed.

The published `zephyon-protocol-0.5.0.tgz` SHA-256 is
`de401113895bc9eff0e2ff60e92a99ec3c8b7d38e63028c2b96f5ca36a11e68e`.
All 798 installed package files were compared byte for byte with that artifact. The release
retains all 454 prior declarations and 163 prior Runtime exports, with 23 declarations and
8 exports added. Other Backend dependency versions are unchanged.

## Composition and boundary

`RuntimePolicyAdapter` is an unmounted, trusted in-process issuer adapter. Compose it with
the existing `ProviderDeploymentReadiness`, the actual restricted issuer LOGIN, verified
Auth0 authentication, and authenticated deployment/endpoint configuration. The accepted
SDK server session supplies the provider-session reference, as in payment preparation.
Browser input, access-token claims and callback success cannot supply policy or evidence.
No public route, private network service, application startup, production provider or Site
contract is activated by this package.

The caller supplies only payment, canonical session, exact envelope and guarded consent
references. Preparation and confirmation remain the existing accepted implementations.
The integration test runs actual installed Auth0 SDK transaction validation, the guarded
identity-proof/issuer admission, then this real Protocol evaluator with database evidence.
The Auth0 provider and endpoint attestation in those tests remain explicit offline fixtures;
this is not a claim of live provider or deployment attestation.

`registerRuntimeTestProfile` is an offline administrator seam, not a request handler. It
qualifies the configured asset and calls the Protocol-supplied
`createControlledDevnetTestPolicyV1` with an explicit amount cap, dates, versions and pinned
deployment fingerprint. Fixed source identifiers describe actual Backend record sources.
Register that profile and place its digest/version/window in administrative preparation
inventory **before** preparing or confirming an envelope. An incompatible already-prepared
envelope fails closed; the adapter never changes its economics or policy reference.

## Authority and evidence

The adapter reads the existing immutable `economic_envelopes` object and verifies its SDK
authorization digest. It does not recreate payment economics. The prepared payment's
session and owner must match the verified identity and durable SDK session binding.

| Evidence | Authoritative source | Qualification |
| --- | --- | --- |
| Exact consent | `economic_consent_evidence` plus guarded `economic_confirmation_consumptions` and challenge | Same principal, envelope, session, issuer, audience, provider subject, configuration and environment; required authentication scope; existing guarded admission provenance |
| Eligibility | Canonical account/session, current intent head, deployment/provider revision, administrator-selected TEST policy head | Current disposition and original validity; session revocation is explicit revoked evidence; account/policy/head ineligibility is unsatisfied evidence |
| Destination | Immutable, SQL-guarded payment preparation and original payment snapshot | Direct wallet and an independently derived associated token account from the frozen payment mint/wallet; no username or beneficiary-ownership claim |

The same intent lock serializes evaluation and recovery. Account, session, policy head,
provider revision, consent and asset/network registry locks protect authority while evaluating.
All evaluation times come from PostgreSQL `clock_timestamp()`. No KYC, risk, compliance,
ZTS or unavailable provider evidence is fabricated.

The SDK ingestion capability's callback authenticates the **entire normalized record**
against the internally loaded authoritative snapshot. Neither a qualifier nor an evidence
record is a caller argument. A serialized evidence set never retains capability authority.
Protocol alone evaluates the TEST policy and chooses APPROVED/REJECTED and bounded reasons.
Malformed references, absent guarded consent, unknown configuration, missing identity or
registry revocation fail closed before evaluation; they do not invent a canonical decision.

## Persistence, replay and freshness

Migration 033 adds administrator-owned TEST profile inventory/current heads and the
append-only `economic_policy_decisions` ledger. Migrations 001–032 remain unchanged.
The ledger stores the complete SDK decision, original evidence snapshots and original
evaluation context, linked to the exact envelope, prepared payment, consent, canonical
session and profile. A unique envelope/payment/decision identity and the existing intent
lock prevent concurrent contradictory decisions. No UPDATE or DELETE is permitted.

The issuer has read access to that inventory and column-bounded decision insertion.
Identity, app, signer, observer and reader credentials cannot create Runtime decisions.
Only the administrator can change the selected policy. SQL checks canonical bindings and
approval eligibility with a fresh database clock at insertion, after waits. This is
admission-time eligibility, not a promise about physical commit or later response time.

Recovery returns the original decision. It rebuilds evidence from current authority and
uses `RuntimePolicyEvaluatorV1.verifyDecision` with the original context only when the
complete current evidence still matches, the profile/configuration is current, and the
full decision's expiry has not passed. It never substitutes the longer Runtime-reference
expiry or issues a fresh decision under the same envelope. Policy change or revocation
leaves historical APPROVED intact while reporting `currentApproval: false`; configuration
or registry qualification failure may instead refuse recovery. A historical REJECTED
decision remains REJECTED. New economics/policy require a separately designed new attempt.

Every response has `mode: "non-value"` and `executionAuthorized: false`.
`currentApproval` describes the checked database observation; it is not a bearer approval
or a promise of eligibility at a future instant. The adapter discards the SDK's legacy
approval binding after verification and never writes `economic_runtime_evidence`.
This ledger cannot authorize existing sponsor finalization or signer contact. Any later
execution package must independently consume the full decision with current authority
and expiry checks; that wiring is outside this package.

## Validation and release order

The required review gates are Backend lint/typecheck/build, unit tests, the real
consent-to-Runtime PostgreSQL cases, bounded database-clock expiry repeats, actual LOGIN
ACL tests, migration/upgrade checks, full PostgreSQL regression and `git diff --check`.
The focused cases cover concurrent/lost-response recovery, cap rejection, request/evidence
injection, wrong references, substituted token accounts despite exact consent, pre-evaluation revocation, post-decision revocation/policy
change, expiry while waiting for a lock, and asset revocation. The expiry helper observes
PostgreSQL directly and requires its existing 1,500 ms safety margin; assertions are not
relaxed. Full regression includes the existing actual Site SDK fixture when
`CONTROLLED_SITE_SOURCE` points to canonical Site.

Only Backend consumes this additive package. Existing HTTP/Site contracts, Auth0 ceremony,
ordinary Devnet execution, wallet/sponsor and observer behavior are unchanged. Future
deployment would require the released Protocol dependency, migration 033 and explicit ACL
provisioning before Backend activation, plus separate release authorization. No deployment
is part of this review candidate. The feature commit stays local until independent review.

Vercel Git must remain disconnected; Railway's automatic deployment trigger must remain
removed. No transaction construction, blockhash acquisition, wallet/sponsor signature,
submission, broadcast, reconciliation, Mainnet contact, funds movement or ZERA activation
occurs here. ZephiPay remains useful without ZERA and the fixed 200M baseline is untouched.
