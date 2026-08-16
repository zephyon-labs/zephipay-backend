import { randomUUID } from "node:crypto";
import type { SolanaChainObservation } from "zephyon-protocol";
import type { DevnetExecutionStateRepository, PersistedDevnetPreparation } from "./devnetExecutionState";

export interface DevnetReconciliationProvider {
  readonly identity: Readonly<{ providerId: string; network: "devnet"; role: "reconciliation" }>;
  observeSignature(signature: string): Promise<SolanaChainObservation>;
}

/** Reconciles committed executions from durable state. It cannot prepare, sign, decrypt, or submit. */
export class DevnetReconciliationService {
  constructor(
    private readonly repository: DevnetExecutionStateRepository,
    private readonly provider: DevnetReconciliationProvider,
    expectedProviderId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly idFactory: () => string = randomUUID,
  ) {
    if (provider.identity.network !== "devnet" || provider.identity.role !== "reconciliation" || provider.identity.providerId !== expectedProviderId) {
      throw new Error("Configured reconciliation provider does not match authoritative Devnet policy.");
    }
  }

  async reconcile(executionId: string, actorSubject: string) {
    const preparation = await this.repository.findPreparation(executionId, actorSubject);
    const commitment = await this.repository.findCommitment(executionId, actorSubject);
    if (!preparation || !commitment || commitment.preparationId !== preparation.preparationId) throw new Error("Committed Devnet preparation was not found for this owner.");
    if (preparation.artifact.reconciliationProviderId !== this.provider.identity.providerId) throw new Error("Persisted reconciliation provider identity changed.");
    let value: SolanaChainObservation;
    try {
      value = await this.provider.observeSignature(commitment.signature);
    } catch (error) {
      return this.persist(preparation, { executionId, actorSubject, preparationId: preparation.preparationId, providerId: this.provider.identity.providerId, outcome: "UNKNOWN", observedAt: this.clock(), errorCode: reconciliationErrorCode(error) });
    }
    if (value.providerId !== undefined && value.providerId !== this.provider.identity.providerId) throw new Error("Reconciliation observation provider identity mismatch.");
    const outcome = value.status.toUpperCase() as "MISSING" | "PENDING" | "SETTLED" | "FAILED";
    return this.persist(preparation, { executionId, actorSubject, preparationId: preparation.preparationId, providerId: this.provider.identity.providerId, outcome, observedAt: value.observedAt, ...("slot" in value && value.slot ? { slot: value.slot } : {}), ...("confirmationStatus" in value && value.confirmationStatus ? { confirmationStatus: value.confirmationStatus } : {}), ...(value.status === "failed" ? { errorCode: value.errorCode } : {}) });
  }

  private async persist(preparation: PersistedDevnetPreparation, input: Omit<Parameters<DevnetExecutionStateRepository["recordReconciliationObservation"]>[0], "observationId">) {
    const observations = await this.repository.listReconciliationObservations(input.executionId, input.actorSubject);
    const prior = observations[observations.length - 1];
    if (prior && sameReconciliation(prior, input)) return Object.freeze({ attempted: true as const, persisted: false as const, preparation, observation: prior });
    return Object.freeze({ attempted: true as const, persisted: true as const, ...await this.repository.recordReconciliationObservation({ ...input, observationId: this.idFactory() }) });
  }
}

function reconciliationErrorCode(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; providerErrorCode?: unknown };
    if (typeof value.providerErrorCode === "string" && /^[A-Z0-9_.:-]{1,64}$/.test(value.providerErrorCode)) return value.providerErrorCode;
    if (typeof value.code === "string" && /^[A-Z0-9_]{1,48}$/.test(value.code)) return `RPC_${value.code}`;
  }
  return "RPC_UNKNOWN";
}

function sameReconciliation(prior: Readonly<{ providerId: string; outcome: string; slot?: string; confirmationStatus?: string; errorCode?: string }>, next: Readonly<{ providerId: string; outcome: string; slot?: string; confirmationStatus?: string; errorCode?: string }>) {
  return prior.providerId === next.providerId && prior.outcome === next.outcome && prior.slot === next.slot && prior.confirmationStatus === next.confirmationStatus && prior.errorCode === next.errorCode;
}
