import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Keypair, Message, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { bindSponsorFinalizationV1, authorizationBindingDigestV1, createAttemptFenceV1, cancelAttemptV1, replaceCancelledAttemptV1, createEconomicIntentEnvelopeV1, offlineSponsoredMessageV1 } from "zephyon-protocol";
import { normalizeCurrentDevnetIntentV1 } from "../src/economic/devnetCompatibility";
import { newSponsorFinalizationClaimV1, resolveSponsorFinalizationClaimV1, SponsorFinalizationOperationV1 } from "../src/economic/sponsorFinalizationContract";
import { devnetPreparationPolicy, hashDevnetPolicy } from "../src/devnet/devnetPreparationPolicy";
import { usdcAmountToRaw, parseUsdcAmount } from "../src/payments/paymentIntentValidation";
import type { PaymentRecord } from "../src/payments/paymentTypes";
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json", "utf8"));
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const signer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const policy = devnetPreparationPolicy({ mint: fixture.qualifiedAsset.mint, decimals: 6, sourceTokenAccount: getAssociatedTokenAddressSync(new PublicKey(fixture.qualifiedAsset.mint), signer.publicKey).toBase58(), signerKeyId: "devnet-key", signerKeyVersion: "v1", signerPublicKey: signer.publicKey.toBase58(), submissionProviderId: "provider:submit", reconciliationProviderId: "provider:observe" });
function payment(amount = "1.234567"): PaymentRecord { return { id: "payment:one", actorSubject: "account:alice", idempotencyKey: "legacy:key", requestHash: "ab".repeat(32), status: "PROCESSING", version: 2n, network: "solana-devnet", rail: "solana", asset: "USDC", mintAddress: policy.mint, recipientAddress: fixture.envelope.recipient.wallet, amountRaw: usdcAmountToRaw(amount), purpose: null, recipientType: "DIRECT_WALLET", userConfirmedAt: "2026-09-30T12:00:00.000Z", createdAt: "2026-09-30T11:59:00.000Z", updatedAt: "2026-09-30T12:00:00.000Z" } as PaymentRecord; }
function tuple() {
    const e = createEconomicIntentEnvelopeV1(fixture.envelope, fixture.qualifiedAsset), envelopeDigest = authorizationBindingDigestV1(e, e.amount.asset), tx = Transaction.populate(Message.from(offlineSponsoredMessageV1(e, fixture.recentBlockhash)));
    tx.partialSign(signer);
    return bindSponsorFinalizationV1({ envelope: e, consent: { schema: "zephyon.economic-consent/v1", consentId: "consent:one", principalId: e.principal.id, envelopeDigest, confirmedAt: e.createdAt }, decision: { schema: "zephyon.runtime-binding/v1", reference: e.runtime, envelopeDigest, result: "approved" }, now: e.createdAt, userSignedTransaction: tx.serialize({ requireAllSignatures: false }), recentBlockhash: fixture.recentBlockhash, reservedExposureId: "exposure:one" });
}
for (const text of ["0.000001", "1.234567", "1", "9223372036854.775807"]) {
    test(`Devnet compatibility preserves existing six-decimal semantics: ${text}`, () => {
        assert.equal(parseUsdcAmount(text), text);
        const before = payment(text), normalized = normalizeCurrentDevnetIntentV1(before, policy, fixture.qualifiedAsset);
        assert.equal(normalized.amount.atomicUnits, before.amountRaw.toString());
        assert.equal(normalized.amount.asset.decimals, 6);
        assert.equal(normalized.sourceAuthority.signer, normalized.feeAuthority.signer);
        assert.notEqual(normalized.sourceAuthority, normalized.feeAuthority);
        assert.equal(normalized.preparationPolicyHash, hashDevnetPolicy(policy));
        assert.equal(normalized.customerSignature, "NOT_PRESENT");
        assert.equal(normalized.productionRuntimeEvidence, "NOT_ESTABLISHED");
        assert.equal(normalized.recipient.ownership, "UNVERIFIED");
        assert.equal(normalized.confirmation.requestHash, before.requestHash);
        assert.equal(before.amountRaw, usdcAmountToRaw(text));
        assert.equal(before.status, "PROCESSING");
    });
}
for (const change of ["mint", "precision", "program", "network"]) {
    test(`Devnet adapter cannot activate ${change} changes`, () => { const a = copy(fixture.qualifiedAsset); if (change === "mint")
        a.mint = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58(); if (change === "precision")
        a.decimals = 9; if (change === "program")
        a.tokenProgram = TOKEN_2022_PROGRAM_ID.toBase58(); if (change === "network")
        a.network.environment = "mainnet"; assert.throws(() => normalizeCurrentDevnetIntentV1(payment(), policy, a)); });
}
test("adapter is not a constructor of customer consent, genesis attestation, or production authorization", () => {
    const p = payment(), result = normalizeCurrentDevnetIntentV1(p, policy, fixture.qualifiedAsset);
    assert.equal(result.schema, "zephyon.devnet-compatibility/v1");
    assert.equal(result.confirmation.kind, "LEGACY_TEST_INVENTORY_CONFIRMATION");
    assert.equal(result.amount.asset.network.genesisHash, fixture.qualifiedAsset.network.genesisHash);
    assert.equal((result as any).runtimeDecision, undefined);
    assert.equal((result as any).sponsorFinalizationId, undefined);
    assert.throws(() => normalizeCurrentDevnetIntentV1({ ...p, mintAddress: Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58() }, policy, fixture.qualifiedAsset));
});
test("SDK package exposes new contracts while retaining legacy Runtime exports", () => {
    const sdk = require("zephyon-protocol");
    for (const name of ["createEconomicIntentEnvelopeV1", "createCanonicalExecutionContext", "ReferenceSolanaDevnetTransactionPreparer", "RuntimeExecutionFacade"])
        assert.equal(typeof sdk[name], "function", name);
    assert.equal(Object.keys(sdk).some(k => /zera.*mint|zera.*route/i.test(k)), false);
});
test("exact finalization replay returns same operation without new signing authority", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), current = createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest), created = resolveSponsorFinalizationClaimV1({ current, claim });
    assert.match(claim.sponsorFinalizationId, /^[0-9a-f-]{36}$/);
    assert.equal(created.disposition, "CREATED");
    const replay = resolveSponsorFinalizationClaimV1({ current: created.fence, claim, byId: created.operation, byGeneration: created.operation });
    assert.equal(replay.disposition, "REPLAY");
    assert.equal(replay.operation, created.operation);
    assert.throws(() => cancelAttemptV1(created.fence));
});
test("same ID with conflicting immutable tuple fails for every finalization binding", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), created = resolveSponsorFinalizationClaimV1({ current: createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest), claim });
    const mutations = [(x: any) => x.messageDigest = "ef".repeat(32), (x: any) => x.customerSignatureDigest = "ef".repeat(32), (x: any) => x.sponsorKeyVersion = "v2", (x: any) => x.envelopeDigest = "ef".repeat(32), (x: any) => x.consentId = "consent:other", (x: any) => x.reservedExposureId = "exposure:other", (x: any) => x.runtime.policyVersion = "v2", (x: any) => x.attempt.intentVersion = "2", (x: any) => x.network.genesisHash = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58()];
    for (const change of mutations) {
        const altered = copy(t);
        change(altered);
        assert.throws(() => resolveSponsorFinalizationClaimV1({ current: created.fence, claim: { ...claim, tuple: altered }, byId: created.operation, byGeneration: created.operation }));
    }
});
test("competing identical operation converges; competing different tuple conflicts", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), created = resolveSponsorFinalizationClaimV1({ current: createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest), claim }), competitor = newSponsorFinalizationClaimV1(t);
    assert.notEqual(competitor.sponsorFinalizationId, claim.sponsorFinalizationId);
    const result = resolveSponsorFinalizationClaimV1({ current: created.fence, claim: competitor, byGeneration: created.operation });
    assert.equal(result.disposition, "CONVERGED");
    assert.equal(result.operation.sponsorFinalizationId, claim.sponsorFinalizationId);
    assert.throws(() => resolveSponsorFinalizationClaimV1({ current: created.fence, claim: newSponsorFinalizationClaimV1({ ...t, consentId: "different" }), byGeneration: created.operation }));
});
test("signer response loss preserves same ID, tuple and unresolved result", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), created = resolveSponsorFinalizationClaimV1({ current: createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest), claim });
    const unknown: SponsorFinalizationOperationV1 = Object.freeze({ ...created.operation, result: Object.freeze({ state: "RESULT_UNKNOWN" }) });
    const recovered = resolveSponsorFinalizationClaimV1({ current: created.fence, claim, byId: unknown, byGeneration: unknown });
    assert.equal(recovered.operation, unknown);
    assert.equal(recovered.disposition, "REPLAY");
    assert.equal(recovered.operation.result.state, "RESULT_UNKNOWN");
});
test("A lost callback, A cancellation, B creation, late A cannot claim finalization", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), cancelled = cancelAttemptV1(createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest));
    const next = replaceCancelledAttemptV1(cancelled, { ...t.attempt, attemptId: "attempt:b", generation: "2", fenceToken: "fence:b" }, "ef".repeat(32), "01".repeat(32));
    assert.throws(() => resolveSponsorFinalizationClaimV1({ current: cancelled, claim }));
    assert.throws(() => resolveSponsorFinalizationClaimV1({ current: next, claim }));
});
test("reordered current fence object cannot change exact replay identity", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), created = resolveSponsorFinalizationClaimV1({ current: createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest), claim });
    const attempt = Object.fromEntries(Object.entries(created.fence.attempt).reverse()) as typeof t.attempt;
    assert.equal(resolveSponsorFinalizationClaimV1({ current: { ...created.fence, attempt }, claim, byId: created.operation, byGeneration: created.operation }).operation, created.operation);
});
test("contradictory ID and generation lookup evidence fails closed", () => {
    const t = tuple(), claim = newSponsorFinalizationClaimV1(t), created = resolveSponsorFinalizationClaimV1({ current: createAttemptFenceV1(t.attempt, t.messageDigest, t.envelopeDigest), claim });
    assert.throws(() => resolveSponsorFinalizationClaimV1({ current: created.fence, claim, byId: created.operation, byGeneration: { ...created.operation, tuple: { ...t, reservedExposureId: "exposure:corrupt" } } }));
});
