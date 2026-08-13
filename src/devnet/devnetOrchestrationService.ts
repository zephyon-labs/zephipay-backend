import { randomUUID } from "node:crypto";
import {
  ReferenceSolanaDevnetTransactionPreparer, classifyDevnetBlockhash, signedTransactionDigest,
  type DevnetBlockhashSource, type DevnetTransactionSigner, type RailExecutionCommand,
  type ReferenceDevnetPreparationPolicy, type SolanaChainObservation, type SolanaDevnetPreparedTransaction,
} from "zephyon-protocol";
import type { DevnetExecutionStateRepository, PersistedDevnetPreparation } from "./devnetExecutionState";
import { Aes256GcmPreparedTransactionCipher } from "./preparedTransactionCipher";

export interface DevnetBlockHeightSource { getCurrentDevnetBlockHeight(): Promise<string>; }
export interface DevnetReconciliationProvider {
  readonly identity: Readonly<{ providerId: string; network: "devnet"; role: "reconciliation" }>;
  observeSignature(signature: string): Promise<SolanaChainObservation>;
}
export type DevnetCapabilityPolicy = Readonly<{ submissionEnabled?: boolean; reconciliationEnabled?: boolean }>;
export type DevnetPreparationIdentityInput = Readonly<{ preparationId: string; executionId: string; paymentIntentId: string; actorSubject: string; generation: number }>;

/** Isolated E2 orchestration. It deliberately has no submission-provider dependency or submission method. */
export class DevnetOrchestrationService {
  private readonly preparer: ReferenceSolanaDevnetTransactionPreparer;
  private readonly submissionEnabled: boolean;
  private readonly reconciliationEnabled: boolean;

  constructor(
    private readonly repository: DevnetExecutionStateRepository,
    private readonly cipher: Aes256GcmPreparedTransactionCipher,
    private readonly policy: ReferenceDevnetPreparationPolicy,
    blockhashSource: DevnetBlockhashSource,
    signer: DevnetTransactionSigner,
    private readonly blockHeightSource: DevnetBlockHeightSource,
    private readonly reconciliationProvider: DevnetReconciliationProvider,
    capabilities: DevnetCapabilityPolicy = {},
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly idFactory: () => string = randomUUID,
  ) {
    this.submissionEnabled = capabilities.submissionEnabled === true;
    this.reconciliationEnabled = capabilities.reconciliationEnabled === true;
    if (reconciliationProvider.identity.network !== "devnet" || reconciliationProvider.identity.role !== "reconciliation" || reconciliationProvider.identity.providerId !== policy.reconciliationProviderId) throw new Error("Configured reconciliation provider does not match authoritative Devnet policy.");
    if (policy.submissionProviderId === policy.reconciliationProviderId) throw new Error("Submission and reconciliation providers must be independent.");
    this.preparer = new ReferenceSolanaDevnetTransactionPreparer(policy, blockhashSource, signer);
  }

  capabilities() { return Object.freeze({ submissionEnabled: this.submissionEnabled, reconciliationEnabled: this.reconciliationEnabled }); }

  async prepare(identity: DevnetPreparationIdentityInput, command: RailExecutionCommand): Promise<PersistedDevnetPreparation> {
    this.assertIdentity(identity, command); const artifact=await this.preparer.prepare(command);
    return this.repository.persistPreparation(this.persistence(identity, artifact));
  }

  async loadRuntimePreparation(executionId:string,actorSubject:string):Promise<SolanaDevnetPreparedTransaction|undefined>{
    const stored=await this.repository.findPreparation(executionId,actorSubject);return stored?this.reconstruct(stored):undefined;
  }

  async refreshExpiredPreContact(executionId:string,actorSubject:string,nextPreparationId:string,command:RailExecutionCommand):Promise<PersistedDevnetPreparation>{
    const prior=await this.repository.findPreparation(executionId,actorSubject);if(!prior)throw new Error("Devnet preparation was not found for this owner.");
    if(prior.state==="ABANDONED_PRE_CONTACT")throw new Error("Abandoned Devnet preparation cannot be replaced again.");const height=await this.blockHeightSource.getCurrentDevnetBlockHeight();const disposition=classifyDevnetBlockhash(prior.state,prior.artifact.lastValidBlockHeight,height);
    if(disposition!=="SAFE_TO_PREPARE_FRESH")throw new Error(disposition==="RECONCILIATION_REQUIRED"?"Committed Devnet preparation is reconciliation-only and cannot be replaced.":"Devnet preparation blockhash remains valid.");
    const identity={preparationId:nextPreparationId,executionId,paymentIntentId:prior.paymentIntentId,actorSubject,generation:prior.generation+1};this.assertIdentity(identity,command);
    const artifact=await this.preparer.prepare(command);return this.repository.replaceExpiredPreparation({priorPreparationId:prior.preparationId,replacement:this.persistence(identity,artifact),abandonedAt:this.clock()});
  }

  async reconcile(executionId:string,actorSubject:string){
    if(!this.reconciliationEnabled)return Object.freeze({attempted:false as const,reason:"RECONCILIATION_DISABLED" as const});
    const preparation=await this.repository.findPreparation(executionId,actorSubject);const commitment=await this.repository.findCommitment(executionId,actorSubject);
    if(!preparation||!commitment||commitment.preparationId!==preparation.preparationId)throw new Error("Committed Devnet preparation was not found for this owner.");
    if(preparation.artifact.reconciliationProviderId!==this.reconciliationProvider.identity.providerId)throw new Error("Persisted reconciliation provider identity changed.");
    let value:SolanaChainObservation;try{value=await this.reconciliationProvider.observeSignature(commitment.signature);}catch{return Object.freeze({attempted:true as const,...await this.repository.recordReconciliationObservation({observationId:this.idFactory(),executionId,actorSubject,preparationId:preparation.preparationId,providerId:this.reconciliationProvider.identity.providerId,outcome:"UNKNOWN",observedAt:this.clock()})});}
    if(value.providerId!==undefined&&value.providerId!==this.reconciliationProvider.identity.providerId)throw new Error("Reconciliation observation provider identity mismatch.");const outcome=value.status.toUpperCase() as "MISSING"|"PENDING"|"SETTLED"|"FAILED";
    const persisted=await this.repository.recordReconciliationObservation({observationId:this.idFactory(),executionId,actorSubject,preparationId:preparation.preparationId,providerId:this.reconciliationProvider.identity.providerId,outcome,observedAt:value.observedAt,...("slot" in value&&value.slot?{slot:value.slot}:{}),...("confirmationStatus" in value&&value.confirmationStatus?{confirmationStatus:value.confirmationStatus}:{}),...(value.status==="failed"?{errorCode:value.errorCode}:{})});
    return Object.freeze({attempted:true as const,...persisted});
  }

  private persistence(identity:DevnetPreparationIdentityInput,artifact:SolanaDevnetPreparedTransaction){const encryptedSignedTransaction=this.cipher.encrypt(artifact.signedTransactionBase64,{executionId:identity.executionId,preparationId:identity.preparationId,keyVersion:this.cipher.keyVersion});const{signedTransactionBase64:_,...economic}=artifact;return Object.freeze({...identity,encryptedSignedTransaction,artifact:Object.freeze(economic),preparedAt:this.clock()});}
  private reconstruct(stored:PersistedDevnetPreparation):SolanaDevnetPreparedTransaction{const signedTransactionBase64=this.cipher.decrypt(stored.encryptedSignedTransaction,{executionId:stored.executionId,preparationId:stored.preparationId,keyVersion:stored.encryptedSignedTransaction.keyVersion});if(signedTransactionDigest(signedTransactionBase64)!==stored.artifact.signedTransactionDigest)throw new Error("Persisted signed transaction digest does not match authenticated bytes.");return Object.freeze({...stored.artifact,signedTransactionBase64});}
  private assertIdentity(identity:DevnetPreparationIdentityInput,command:RailExecutionCommand){if(identity.executionId!==command.executionId||identity.paymentIntentId!==command.paymentIntentId||command.rail!=="solana"||command.destination.type!=="wallet"||command.destination.network!=="solana-devnet"||command.amount.asset!==this.policy.asset||command.amount.decimals!==this.policy.decimals)throw new Error("Runtime command does not match server-authoritative Devnet execution identity or policy.");}
}
