import { randomUUID } from "node:crypto";
import type { SolanaChainObservation } from "zephyon-protocol";
import { type DevnetExecutionStateRepository, type DevnetReconciliationPersistenceFence, type PersistedDevnetPreparation } from "./devnetExecutionState";

export type DevnetHistorySignatureObservation=SolanaChainObservation&Readonly<{signature:string;historySearched:true;providerId:string;contextSlot:string;confirmationStatus?:string}>;
export type DevnetReconciliationLeaseControl=Readonly<{fence:DevnetReconciliationPersistenceFence;renew():Promise<boolean>}>;

export interface DevnetReconciliationProvider {
  readonly identity: Readonly<{ providerId: string; network: "devnet"; role: "reconciliation" }>;
  observeSignature(signature: string): Promise<DevnetHistorySignatureObservation>;
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

  async reconcile(executionId: string, actorSubject: string, lease:DevnetReconciliationLeaseControl) {
    const preparation = await this.repository.findPreparation(executionId, actorSubject);
    const commitment = await this.repository.findCommitment(executionId, actorSubject);
    if (!preparation || !commitment || commitment.preparationId !== preparation.preparationId) throw new Error("Committed Devnet preparation was not found for this owner.");
    if (preparation.artifact.reconciliationProviderId !== this.provider.identity.providerId || preparation.artifact.submissionProviderId === this.provider.identity.providerId) throw new Error("Persisted reconciliation provider identity changed or is not separated from submission.");
    if(preparation.state==="SETTLED"||preparation.state==="FAILED"){const observations=await this.repository.listReconciliationObservations(executionId,actorSubject),prior=observations[observations.length-1];if(!prior)throw new Error("Terminal Devnet reconciliation evidence is missing.");return Object.freeze({attempted:false as const,persisted:false as const,preparation,observation:prior});}
    let observation:DevnetHistorySignatureObservation;
    await renewLease(lease);try{observation=await this.provider.observeSignature(commitment.signature);}catch(error){return this.unknown(preparation,executionId,actorSubject,commitment.signature,reconciliationErrorCode(error),lease);}
    if(!validSignatureIdentity(observation,commitment.signature,this.provider.identity.providerId))return this.unknown(preparation,executionId,actorSubject,commitment.signature,"RPC_PROVIDER_MISMATCH",lease);
    if(!validSignatureSemantics(observation))return this.unknown(preparation,executionId,actorSubject,commitment.signature,"RPC_INVALID_RESPONSE",lease);
    if(observation.status==="missing")return this.unknown(preparation,executionId,actorSubject,commitment.signature,"SIGNATURE_STATUS_MISSING",lease);
    return this.persist(preparation,this.observationInput(observation,executionId,actorSubject,preparation.preparationId),lease);
  }

  private unknown(preparation:PersistedDevnetPreparation,executionId:string,actorSubject:string,signature:string,errorCode:string,lease:DevnetReconciliationLeaseControl){return this.persist(preparation,{executionId,actorSubject,preparationId:preparation.preparationId,providerId:this.provider.identity.providerId,signature,outcome:"UNKNOWN",observedAt:this.clock(),errorCode},lease);}

  private observationInput(value:DevnetHistorySignatureObservation,executionId:string,actorSubject:string,preparationId:string){return{executionId,actorSubject,preparationId,providerId:this.provider.identity.providerId,signature:value.signature,outcome:value.status.toUpperCase() as "PENDING"|"SETTLED"|"FAILED",observedAt:value.observedAt,...("slot" in value&&value.slot?{slot:value.slot}:{}),...("confirmationStatus" in value&&value.confirmationStatus?{confirmationStatus:value.confirmationStatus}:{}),...(value.status==="failed"?{errorCode:value.errorCode}:{})};}

  private async persist(preparation: PersistedDevnetPreparation, input: Omit<Parameters<DevnetExecutionStateRepository["recordReconciliationObservation"]>[0], "observationId"|"recoveryFence">, lease:DevnetReconciliationLeaseControl) {
    await renewLease(lease);
    const observations = await this.repository.listReconciliationObservations(input.executionId, input.actorSubject);
    const prior = observations[observations.length - 1];
    if (prior && sameReconciliation(prior, input)) return Object.freeze({ attempted: true as const, persisted: false as const, preparation, observation: prior });
    return Object.freeze({ attempted: true as const, persisted: true as const, ...await this.repository.recordReconciliationObservation({ ...input, observationId: this.idFactory(),recoveryFence:lease.fence }) });
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

function sameReconciliation(prior: Readonly<{ providerId: string; signature?:string; outcome: string; slot?: string; confirmationStatus?: string; errorCode?: string }>, next: Readonly<{ providerId: string; signature:string; outcome: string; slot?: string; confirmationStatus?: string; errorCode?: string }>) {
  return prior.providerId === next.providerId && prior.signature===next.signature&&prior.outcome === next.outcome && prior.slot === next.slot && prior.confirmationStatus === next.confirmationStatus && prior.errorCode === next.errorCode;
}
function validSignatureIdentity(value:DevnetHistorySignatureObservation,signature:string,providerId:string){return value.signature===signature&&value.historySearched===true&&value.providerId===providerId;}
function validSignatureSemantics(value:DevnetHistorySignatureObservation){if(!/^(0|[1-9]\d*)$/.test(value.contextSlot)||!Number.isFinite(Date.parse(value.observedAt)))return false;if(value.status==="missing")return true;if(!("slot"in value)||typeof value.slot!=="string"||!/^(0|[1-9]\d*)$/.test(value.slot)||BigInt(value.slot)>BigInt(value.contextSlot))return false;if(value.status==="pending")return value.confirmationStatus==="processed"||value.confirmationStatus==="confirmed";if(value.status==="settled")return value.confirmationStatus==="finalized";return value.status==="failed"&&value.confirmationStatus==="finalized"&&value.errorCode==="PROVIDER_REPORTED_FAILURE";}
async function renewLease(lease:DevnetReconciliationLeaseControl){if(!lease||!(await lease.renew()))throw new Error("Devnet recovery lease authority was lost.");}
