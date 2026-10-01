import { randomUUID } from "node:crypto";
import { AttemptFenceV1, SponsorFinalizationTupleV1, commitFinalizationFenceV1, createAttemptIdentityV1, createSponsorFinalizationTupleV1, sponsorTupleDigestV1 } from "zephyon-protocol";
export type SponsorFinalizationOperationV1 = Readonly<{
    sponsorFinalizationId: string;
    tuple: SponsorFinalizationTupleV1;
    tupleDigest: string;
    result: Readonly<{
        state: "COMMITTED" | "RESULT_UNKNOWN";
    }> | Readonly<{
        state: "RESULT_AVAILABLE";
        artifactReference: string;
        finalTransactionId: string;
    }>;
}>;
export type SponsorFinalizationClaimV1 = Readonly<{
    sponsorFinalizationId: string;
    tuple: SponsorFinalizationTupleV1;
}>;
/** Server-only identity generation; clients must never select finalization IDs. Does not contact a signer. */
export function newSponsorFinalizationClaimV1(tuple: SponsorFinalizationTupleV1): SponsorFinalizationClaimV1 {
    return Object.freeze({ sponsorFinalizationId: randomUUID(), tuple: createSponsorFinalizationTupleV1(tuple) });
}
function validId(value: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new Error("Invalid server finalization ID."); }
function scope(tuple: SponsorFinalizationTupleV1): string { return JSON.stringify([tuple.attempt.intentId, tuple.attempt.generation]); }
/**
 * Pure claim decision. NOT a repository or signer. A future repository MUST load both
 * unique indexes and current fence in ONE serializable transaction, reserve exposure,
 * CAS cancellation/finalization and persist this result before contacting the signer.
 */
export function resolveSponsorFinalizationClaimV1(input: Readonly<{
    current: AttemptFenceV1;
    claim: SponsorFinalizationClaimV1;
    byId?: SponsorFinalizationOperationV1;
    byGeneration?: SponsorFinalizationOperationV1;
}>): Readonly<{
    disposition: "CREATED" | "REPLAY" | "CONVERGED";
    operation: SponsorFinalizationOperationV1;
    fence: AttemptFenceV1;
}> {
    const { current, claim, byId, byGeneration } = input;
    validId(claim.sponsorFinalizationId);
    const tuple = createSponsorFinalizationTupleV1(claim.tuple), hash = sponsorTupleDigestV1(tuple);
    if (byId && (byId.sponsorFinalizationId !== claim.sponsorFinalizationId || byId.tupleDigest !== hash || sponsorTupleDigestV1(byId.tuple) !== hash))
        throw new Error("Finalization ID conflict.");
    if (byGeneration && (scope(byGeneration.tuple) !== scope(tuple) || byGeneration.tupleDigest !== hash || sponsorTupleDigestV1(byGeneration.tuple) !== hash))
        throw new Error("Generation index tuple conflict.");
    const existing = byId ?? byGeneration;
    if (existing) {
        if (scope(existing.tuple) !== scope(tuple) || existing.tupleDigest !== hash || sponsorTupleDigestV1(existing.tuple) !== hash || (byId && byGeneration && byId.sponsorFinalizationId !== byGeneration.sponsorFinalizationId))
            throw new Error("Competing finalization tuple conflict.");
        if (current.state !== "FINALIZATION_COMMITTED" || current.sponsorFinalizationId !== existing.sponsorFinalizationId || current.messageDigest !== tuple.messageDigest || current.envelopeDigest !== tuple.envelopeDigest || JSON.stringify(createAttemptIdentityV1(current.attempt)) !== JSON.stringify(tuple.attempt))
            throw new Error("Finalization fence conflict.");
        return Object.freeze({ disposition: byId ? "REPLAY" : "CONVERGED", operation: existing, fence: current });
    }
    const fence = commitFinalizationFenceV1(current, tuple, claim.sponsorFinalizationId);
    const operation: SponsorFinalizationOperationV1 = Object.freeze({ sponsorFinalizationId: claim.sponsorFinalizationId, tuple, tupleDigest: hash, result: Object.freeze({ state: "COMMITTED" }) });
    return Object.freeze({ disposition: "CREATED", operation, fence });
}
/** Persistence interface only; no implementation, migration, key or signing service is introduced. */
export interface SponsorFinalizationRepositoryV1 {
    claim(claim: SponsorFinalizationClaimV1): Promise<Readonly<{
        operation: SponsorFinalizationOperationV1;
        created: boolean;
    }>>;
    find(sponsorFinalizationId: string): Promise<SponsorFinalizationOperationV1 | undefined>;
    // Unknown responses retain the original ID/tuple/exposure; recovery is query-only.
    recordUnknown(sponsorFinalizationId: string, tupleDigest: string): Promise<SponsorFinalizationOperationV1>;
}
