import type { NetworkDomainV1, SponsorFinalizationTupleV1 } from "zephyon-protocol";

export type SignerState = "NOT_CONTACTED" | "CONTACT_COMMITTED" | "RESULT_UNKNOWN" | "REFUSED" | "RESULT_AVAILABLE";
export type DurableFinalization = Readonly<{
  sponsorFinalizationId: string;
  tuple: SponsorFinalizationTupleV1;
  tupleDigest: string;
  signerOperationId: string;
  signerState: SignerState;
  exposureState: "RESERVED" | "UNCERTAIN" | "RELEASED" | "CONSUMED";
  requested: { base: string; priority: string; rent: string };
  consumed?: { base: string; priority: string; rent: string; reference: string };
  artifactReference?: string;
  finalTransactionId?: string;
  version: string;
}>;

export type SignerRequest = Readonly<{
  operation: DurableFinalization;
  customerArtifact: Uint8Array;
}>;
export type SignerResponse = Readonly<{
  signerOperationId: string;
  tupleDigest: string;
  network: NetworkDomainV1;
  sponsorKeyVersion: string;
} & ({ state: "UNKNOWN" } | { state: "REFUSED"; reference: string } | { state: "SIGNED"; artifact: Uint8Array })>;

/** Server-owned authenticated adapter. Refusal MUST be durable, terminal and forbid any later signature for this ID. */
export interface TrustedSignerPort {
  finalize(request: SignerRequest): Promise<SignerResponse>;
  query(request: SignerRequest): Promise<SignerResponse>;
}

/** Future authoritative finalized-chain accounting, never a client report, wall-clock timeout or missing-history guess. */
export interface TrustedExposureObserver {
  observe(operation: DurableFinalization): Promise<Readonly<{
    state: "UNKNOWN";
  }> | Readonly<{
    state: "FINALIZED";
    finalizationId: string;
    transactionId: string;
    network: NetworkDomainV1;
    reference: string;
    base: string;
    priority: string;
    rent: string;
  }>>;
}
