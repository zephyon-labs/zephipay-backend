# Trusted economic evidence and durable sponsor finalization V1

This package is a disconnected Backend foundation for independent audit. It does not activate a wallet route, signer, Mainnet RPC, transaction broadcast, production Runtime decision adapter, sponsorship, or ZERA. Existing Devnet USDC routes and execution remain unchanged. All identity, amount, envelope, canonical hash, message-profile and signature semantics come from Protocol 0.4.0.

## Scope and composition

Backend owns trusted configuration, ingestion, database records, locking, reservations and operational recovery. No new shared contract is required in Protocol. Site, legacy Frontend and ZERA are untouched. The only active payment asset represented by the supplied configuration builder is current Devnet USDC, six decimals; native SOL is separately qualified for the fee role. The builder requires an explicitly supplied full genesis identity and has no default genesis or RPC call. Tests use the existing synthetic genesis and dummy keys, not network attestation.

The composition root, configured identity verifier, trusted Runtime issuer, signer/observer adapters and PostgreSQL writer credentials are authority roots. Request bodies, frontend metadata, wallet metadata, SDK-shaped objects and strings identifying issuers are not authority roots. A process holding these database credentials can write server records; this package is not a sandbox against a compromised Backend process or database administrator. Do not expose administration or repository instances to public request dispatch.

Production composition must provide adapters itself. No module in this directory is imported by an existing route, `app`, `server`, Runtime composition, or Devnet execution component. There is no default approving Runtime adapter, signer implementation, accounting observer, production budget or production network configuration. Deterministic Solana signing and local JWT signing exist only in isolated tests.

## Registry authority and revocation

`TrustedRegistryAdministration.install` accepts server-controlled configuration. Durable network records bind family, environment and full genesis; genesis is unique across labels, preventing Devnet/Mainnet/local aliases. Asset records bind that network, exact kind, program/mint or native identity, decimals, payment/fee role, version, effective time and irreversible revocation. Parsing a candidate never inserts or qualifies it. `qualifyAsset` reads the stored definition and retains shared database locks through the eligibility transaction.

Configuration identities and versions are immutable. An exact install is idempotent; altered definitions or revoked records cannot be silently overwritten/re-enabled. This minimal V1 has no asset administration API, automatic registry refresh or requalification workflow. A future versioned replacement process needs separate design; generic identity representability is not asset approval. ZERA has no entry, default or activation.

Revocation takes an exclusive lock on the same record used by eligibility. An authority commit and revocation have a defined database order. Effective times fail closed. Recovery of an operation already committed to signer contact remains possible after registry/evidence revocation; it grants no new contact authorization.

## Authenticated consent

`createEconomicEvidenceIngestion` returns an **unmounted** consent router. It always runs the existing configured RS256 JWT verification pipeline, including issuer, audience and scope checks. Its body is only `{ "envelopeDigest": "..." }`; it cannot receive a trusted principal, consent object or approval result. The authenticated issuer/subject must resolve an existing active canonical account that owns the persisted envelope. This seam does not provision identities or establish wallet ownership.

The server generates a consent UUID and records issuer, audience, the fixed `zephipay-economic-consent-v1` context, canonical subject, envelope digest, database confirmation time, expiry, verified JWT issue time, token SHA-256 fingerprint and optional verified provider session reference. Expiry is bounded by both the token and envelope. JWT `iat` is token issuance evidence, not a claim of recent interactive reauthentication. Bearer tokens are not persisted. Consent is accepted through the verifier and persisted process, not trusted because its fields match the SDK shape.

The existing verifier validates the provider token; this package does not add provider logout introspection or a new session authority. Stored consent can be revoked explicitly, and active account state is checked at claim and first contact. A later route integration must map its account/session security lifecycle onto this revocation seam and define any interactive reauthentication requirement. It must not treat the recorded provider `sid` alone as proof of a live local account session.

## Runtime evidence

The only issuance method takes a stored envelope digest and invokes a fixed, server-configured `TrustedRuntimeIssuer`. There is no public endpoint that accepts an `approved` object. The adapter must call an identified in-process Runtime/policy issuer or authenticate its private transport; arbitrary caller-selected providers are forbidden. This package intentionally supplies no live adapter.

The returned bounded raw JSON must bind the configured issuer, exact network, decision ID, approved outcome, policy version, evidence digest, envelope digest, validity and scope. Policy versions are explicitly configured. Identity reuse with altered data conflicts. The resulting durable record, not the adapter response supplied by a later caller, is the eligibility evidence. Production context rejects `devnet-test-only` even for a Devnet-shaped envelope. Missing, expired, revoked, wrong-context or mismatched evidence fails before a first reservation/contact. Only Protocol performs canonical economic authorization and exact binding validation.

## Raw input boundary

New raw consent and Runtime-response boundaries use `parseEconomicJson`: UTF-8 validation, a 32 KiB bound, depth bound, recursive duplicate-name detection (including escaped aliases), then JSON parsing. The consent router must be mounted **before** any permissive `express.json()` middleware for its path. If a previous parser has consumed the body, this router rejects the parsed object; it does not accept a fallback object. Future wallet/callback transports must use the same raw boundary before SDK parsing. There is no global parser rewrite.

## Persistence and atomicity

Migration `023_trusted_economic_finalization.sql` adds dedicated tables without editing earlier migrations. `economic_attempt_heads` provides the per-intent serialization lock. Attempts store immutable envelope/message/attempt/fence identities and a stable requested exposure ID. `registerAttempt` is a server preparation seam and qualifies assets, checks the canonical account, and applies Protocol's replacement rules. It is not a public envelope-acceptance API.

`economic_finalizations` is the single canonical operation/result row. Its primary finalization UUID and unique `(intent_id, generation)` select the same row; signer-operation UUID and exposure UUID are also unique. It persists the immutable Protocol tuple and digest, consent/Runtime/registry references, bounded customer artifact, signer identity/version, requested fees, exposure state, signer state, completed artifact/reference, transaction ID, timestamps and version.

Finalization claims serialize on the intent head. A first claim verifies the customer-only signature and exact message profile, current generation/fence, locked registry/evidence, and configured sponsor budget. It atomically reserves exposure, inserts the canonical operation, and commits `FINALIZATION_COMMITTED`. Exact replay returns the existing operation. Competing IDs with the same tuple converge; changed tuples or ID reuse across intents fail. Wall-clock authorization is checked again after lock contention before commitment.

Cancellation locks the same intent head. If cancellation commits first, that attempt can never become signer eligible. Only a durable cancellation allows the next fresh generation with a nondecreasing intent version. If finalization commits first, cancellation returns `FINALIZATION_WON`, and replacement remains frozen. A late cancelled callback is retained in append-only `economic_callback_evidence`, including its bounded artifact and validation classification; it cannot update the fence. Operational events contain only references/digests, not those bytes.

Database constraints/triggers enforce alternate-key uniqueness, immutable identities, one-way evidence revocation, legal signer/fence transitions, terminal result/accounting immutability, forward/reverse finalization-fence consistency and sponsor capacity. The exposure trigger also binds reservation amounts, configured assets, sponsor/network, consent and Runtime references to the same envelope. Cryptographic artifact validation remains in the imported SDK; SQL is not a substitute for it.

## Signer contact and recovery

| State | Authority and recovery |
| --- | --- |
| `NOT_CONTACTED` | Durable finalization exists; no signer authorization has been issued. First contact must recheck current account, registry, consent and Runtime evidence. |
| `CONTACT_COMMITTED` | One ephemeral initial-call grant was returned after database commit. The fixed signer-operation ID, tuple, message and key version cannot change. |
| `RESULT_UNKNOWN` | Contact may have occurred. Query the same operation; retain all exposure. |
| `REFUSED` | Configured signer has durably refused this operation and guarantees it cannot later sign. Release the reservation once. |
| `RESULT_AVAILABLE` | Exact fully signed artifact verified and stored. This proves signing, not broadcast or settlement. Exposure remains uncertain until authoritative accounting. |

`recover` accepts an operation ID only. Its signer dependency is fixed at server construction; callers cannot pass a signer or result. Initial contact commits before invoking `finalize`. All later calls use `query` with the same operation and exact original customer artifact. If the process dies after commitment but before actual contact, recovery still queries; absence at the signer is **UNKNOWN**, not refusal and not permission to retry signing. An ambiguous database commit similarly grants no replacement authority. This chooses safety over automatic liveness.

The trusted adapter contract must guarantee terminal refusal, durable idempotent identity, authenticated response provenance and query support. These are future signer-integration requirements, not claims of a live integration in this package. No generic-sign API, key management, KMS/HSM, funding or real transaction signing is implemented.

Completed results must match signer-operation ID, tuple digest, key version and network. Protocol verifies exact message digest, original customer signature digest, signer ordering, expected sponsor signature and fee-payer first-signature transaction ID. The message memo binds the envelope digest, which includes network/genesis; a Solana transaction's raw bytes alone are not independent genesis attestation. Known results cannot be overwritten by a different artifact or refusal, and late UNKNOWN cannot downgrade a terminal result. Conflicts fail and produce a structured audit event.

## Exposure accounting

Budgets are explicit server configuration in atomic native units: independent base-fee, priority-fee and rent limits plus concurrent-outstanding limit. There are no production budget values or automatic replenishment. Budgets bind exact network/genesis, sponsor public key and key version. Operations acquire the budget row lock before reserving or changing accounting. Outstanding reservations plus consumed cost count against the immutable budget, preventing double spending and implicit reset on settlement.

`economic_exposure_projection` distinguishes:

- **Requested:** envelope maxima with no economic reservation, including a separately visible cancelled attempt.
- **Reserved:** full requested maxima after finalization commitment.
- **Uncertain:** full reservation remains after contact or known signing until final effect is established.
- **Released:** terminal refusal releases the full reservation; authoritative realization releases only the unused difference.
- **Consumed:** exact realized amounts backed by the fixed trusted observer's finalized transaction/network evidence.

`settleExposure` calls a server-configured `TrustedExposureObserver`; it does not accept client claims. It binds finalization ID, final transaction ID, network and evidence reference. Realized values must be nonnegative and within the reserved bounds. An UNKNOWN response, timeout, absent provider response, missing transaction history or signature availability never releases capacity. A completed artifact alone is not accounting evidence. No live observer/RPC is supplied.

## Audit and recovery operations

Append-only `economic_authority_events` identifies initiation, canonical intent/generation/finalization, consent/decision references, configuration changes, cancellation outcomes, reservation, contact, result uncertainty, verified result, accounting and conflict. Follow references to the immutable operation for signer key/version and exact tuple. Events exclude raw bearer tokens, full envelopes, transaction bytes and private keys. Restricted evidence/artifact tables retain the bounded bytes needed for recovery. Database access controls, backup protection and artifact confidentiality remain deployment responsibilities.

`listRecoveryIds` is bounded and selects unfinished signing operations. Known signed operations awaiting chain accounting are discoverable by `exposure_state='UNCERTAIN' AND signer_state='RESULT_AVAILABLE'`. There is no background worker or automatic scheduling/activation. Failed audit writes abort the corresponding authority transaction. Rejected claims record evidence in a separate transaction after the attempted authority mutation rolls back.

## Validation and integration limits

Run `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run migrate:validate`, and `git diff --check`. On a disposable PostgreSQL 16 database, use the normal `DATABASE_URL=... npm run migrate`, then `TEST_DATABASE_URL=... npm run test:postgres:economic` or the full sequential `npm run test:postgres`. These tests truncate their disposable fixtures. Never use an operational database. CI's existing required `verify` job now defines its own disposable PostgreSQL service, clean-applies migrations and runs the PostgreSQL suite.

Coverage includes authenticated JWT rejection, duplicate members, forged evidence, exact qualification, wrong scope/genesis, expiry/revocation, same-ID and same-generation races, cancellation/replacement, every exposure limit, one-shot contact, lost responses, pre-contact/post-contact/post-result restart, rollback fault injection, immutable results and finalized accounting. The pre-existing Devnet integration and reliability suites remain part of the normal PostgreSQL command.

Next integration still requires independent audit, a protected closure, and a separate design for the trusted Runtime adapter, real signer durability/refusal guarantees, account/session revocation wiring, source/destination authority integration, operational budget lifecycle and expiry handling for committed-but-never-contacted operations. Those operations remain frozen/reserved if fresh eligibility fails; this package does not invent a timeout release or replacement procedure. No such future decision may be inferred from this foundation.
