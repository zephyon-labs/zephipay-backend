# Payment envelope preparation V1 — local Backend candidate

Base: `8f9dc3d5e81705e7ec56c25b41f7ab6d9dca590e`, Protocol v0.4.0 unchanged.
This candidate implements metadata preparation and confirmation consumption of that
metadata. It does not yet connect the Site SDK host to Backend identity authority.
It is not an end-to-end web-flow completion or production activation.

## Canonical contract and supported input

`PaymentEnvelopePreparation.prepare` selects an existing payment by UUID. Its
other arguments are trusted server context: an authenticated Auth0 capability,
a server-resolved provider-session reference, and the existing signed deployment
endpoint attestation. They are not browser-supplied economic fields. The service
runs under the app LOGIN; it cannot issue confirmation or create identity proofs.

The implementation reuses Protocol `createEconomicIntentEnvelopeV1` and
`authorizationBindingDigestV1`, the existing qualified asset registry,
`lockEconomicSession`, and `normalizeCurrentDevnetIntentV1`. It does not duplicate
asset, amount, canonical serialization, or digest rules.

The initial supported profile is the existing **direct-wallet Devnet test
inventory** model, with `devnet-server` source and fee authority,
`devnet-unverified` destination, and `devnet-test-only` Runtime reference. An
administrator must explicitly install the TEST-only preparation metadata for the
canonical principal. No profile, qualified network, wallet ownership, source key,
or fee policy is inferred from a browser request or silently supplied by defaults.
No private signing key is required or stored by preparation.

Payment-identity/synthetic recipients and external-wallet customer authority are
not reclassified as this profile. They fail closed. Supporting those routes needs
the appropriate authoritative destination/source bindings; this candidate does
not manufacture them from an account session. The public Send routes are unchanged.

For generation 1, the canonical intent ID is `zephipay:payment:<payment UUID>`.
Protocol's positive intent version is the ordinary payment's zero-based version
plus one; both values remain correlated by the immutable payment snapshot. A
server-generated attempt ID, fence token, decision reference and nonce are created
once. Creation time comes from PostgreSQL. Expiry is bounded by the configured
maximum (at most 600 seconds), canonical session, authentication and Runtime
reference validity. Creation requires an unconfirmed, unstarted version-0 payment.

Recipient wallet, atomic amount, mint and purpose reference come from the payment;
source, qualified asset, fee bounds and Runtime reference metadata come from
administrative state. The opaque purpose reference identifies the frozen payment
record, including its private purpose text. No private purpose text is placed in
the Protocol envelope.

The SDK's documented hash-cycle contract allocates a decision reference/evidence
summary before freezing the envelope. That metadata is **not Runtime approval**.
No `economic_runtime_evidence` row is created. A later trusted Runtime adapter must
evaluate and attest this exact envelope and reference, or require a new reviewed
intent; it cannot replace the reference after consent.

## Persistence, immutability and recovery

Additive migration 031 creates:

- `economic_envelopes`: the canonical Protocol object, digest, attempt identity and
  lifecycle state, before any message/blockhash exists. Historical attempts are
  backfilled without changing their economic meaning or confirmation evidence.
- `economic_payment_preparations`: one immutable payment/session/envelope
  association with the original payment/version/request-hash/economic snapshot.
- `economic_payment_preparation_profiles`: administrative TEST-only source/fee/
  asset/reference configuration; no operational write grant.
- `economic_envelope_context`: the existing confirmation-facing identity/state
  projection without requiring a transaction row.

The existing intent head remains the serialization point. Initial creation,
concurrent duplicates, service reconstruction and a lost response recover one
binding. A different session cannot claim it. Replays preserve the original
expiry, even when expired; they do not mint a replacement ceremony or consent.
Eligibility for a new challenge is separately checked by the existing guards.
Generation replacement before transaction registration is not implemented here.

Payment fields and version cannot change once the binding exists. Consequently a
payment selected into this controlled non-value path cannot be advanced by the
ordinary confirm-and-execute continuation. Payments not selected for preparation
retain their existing lifecycle. A future execution adapter must explicitly
integrate the frozen identity and lifecycle; deleting the association or dropping
its guard is not a migration strategy.

Historical `economic_attempts` retain required message digest, blockhash, exposure
identity, state and finalization guards. Their registration method is unchanged
and is never called by preparation. A registration trigger requires exact equality
with an already prepared envelope at that intent/generation. There is no nullable
message shortcut, dummy message identity, signer contact or finalization creation.
A second payment cannot reuse the envelope.

Existing attempt cancellation/finalization synchronizes state into the canonical
row under the same head lock. Confirmation locks that row after the head. This
retains stale-snapshot rejection under REPEATABLE READ, including a transaction
that waited while cancellation committed. Operational roles cannot directly edit
canonical state or envelope fields.

## Confirmation, later Runtime and transaction stages

Confirmation loads the stored canonical envelope; it never reconstructs economics
from the payment or current profile. Migration 029's identity/policy/proof/admission
checks remain, with the envelope lookup moved to the new canonical parent and an
additional exact preparation-session check. Migrations 001–030 are unchanged.
Consent and Runtime evidence reference that parent so they can precede transaction
construction. Finalization still references a full transaction attempt.

The intended lifecycle is:

1. Existing payment record, then metadata-only preparation.
2. Exact-envelope challenge, accepted SDK ceremony, explicit guarded confirmation.
3. Later trusted Runtime evaluation of that same envelope (not implemented here).
4. Later transaction preparation adding blockhash/message facts without changing
   the confirmed economics (not implemented here).
5. Existing guarded sponsor finalization, then separately authorized submission
   and reconciliation (not activated here).

The real-SDK integration test follows steps 1–2 using an actual ordinary payment
record and the existing identity/issuer separation. Callback alone creates no
consent. Explicit admission creates one consent; recovery reads it. The test
asserts no transaction-attempt, Runtime approval, finalization, signer contact or
settlement evidence exists. Negative registration tests submit deliberately
conflicting SQL inputs and verify rejection; they do not construct transactions.

## ACL and deployment boundaries

Provisioning retains administrative ownership of new economic objects, revokes
PUBLIC access, and extends the reviewed allowlist explicitly. App gets payment
read/row-lock access, profile read access and bounded preparation inserts. The
payment table retains its existing owner. Identity, issuer, signer, observer and
reader gain no preparation write authority. Existing identity-proof and issuer
admission separation remains enforced. Restricted LOGIN tests exercise actual
credentials and forbidden direct writes.

Affected repositories: Backend for preparation/persistence/confirmation lookup;
Site for the separate Activity test repair and the still-pending web integration.
Protocol and current public payment API contracts are unchanged. Migration 031
and its role provisioning must precede this Backend version. A later Site web
integration must follow the compatible Backend. No deployment is authorized or
performed by this package.

## Remaining web integration boundary

Site owns the real Auth0 SDK session, `onCallback`, encrypted transaction cookies,
login-gesture ordering and logout barriers. The accepted Backend adapter owns
canonical DB association and requires a trusted SDK host in the identity
compartment. Its current executable host is an in-process test fixture.

The integration choice raised for the user is to keep SDK hosting in Site and add
an authenticated private host handoff, or move controlled SDK hosting into the
Backend identity service. A bearer token or browser `validated` flag cannot
substitute for that trusted host. No public route or Site UI has been wired to a
stand-in. No cookie keys, provider secrets, live tenant facts or deployment
attestations have been copied or fabricated. Production readiness remains false
while those facts are UNATTESTED.

## Local validation

Backend lint, build, 607 unit tests, migration validation (001–031), and diff
checks passed. A fresh disposable PostgreSQL database passed the complete
regression: **507 tests, zero failures, zero skips**. This includes the 13 new
preparation cases, existing confirmation/real-SDK cases, restricted LOGIN and
finalization tests, and historical migration upgrade coverage. An initial draft
failed the existing REPEATABLE READ cancellation race; canonical-row state
synchronization fixed it without changing the rejection assertion. All 30
historical migrations, Protocol dependency/lockfile, finalization repository and
ordinary public payment entry points are byte-for-byte unchanged.

Site's separate stale Activity harness repair passed lint, Next route type
generation, standalone `tsc --noEmit --incremental false`, 287 tests and build.
No controlled Site confirmation UX is implemented or claimed as validated.

## Controlled web continuation

The Site-hosted SDK and bounded private handoff continuation is described in [controlled-web-confirmation-v1.md](controlled-web-confirmation-v1.md). That TEST-only composition integrates this unchanged preparation contract; earlier pending-web notes above describe the preserved checkpoint, not an activation claim. Production readiness remains false.
