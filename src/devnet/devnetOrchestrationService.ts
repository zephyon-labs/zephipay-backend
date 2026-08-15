import { randomUUID } from "node:crypto";
import {
  ProviderIndependentSolanaDevnetTransport, RailProviderOperationError, ReferenceSolanaDevnetTransactionPreparer, authorizeCommittedDevnetSubmission, classifyDevnetBlockhash, parseExecutionId, parseProviderIdempotencyKey, signedTransactionDigest,
  type DevnetBlockhashSource, type DevnetTransactionSigner, type RailExecutionCommand,
  type ReferenceDevnetPreparationPolicy, type SolanaChainObservation, type SolanaDevnetPreparedTransaction, type SolanaSubmissionRpc,
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
  private readonly transport:ProviderIndependentSolanaDevnetTransport;

  constructor(
    private readonly repository: DevnetExecutionStateRepository,
    private readonly cipher: Aes256GcmPreparedTransactionCipher,
    private readonly policy: ReferenceDevnetPreparationPolicy,
    blockhashSource: DevnetBlockhashSource,
    signer: DevnetTransactionSigner,
    private readonly blockHeightSource: DevnetBlockHeightSource,
    private readonly reconciliationProvider: DevnetReconciliationProvider,
    private readonly submissionProvider: SolanaSubmissionRpc,
    capabilities: DevnetCapabilityPolicy = {},
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly idFactory: () => string = randomUUID,
  ) {
    this.submissionEnabled = capabilities.submissionEnabled === true;
    this.reconciliationEnabled = capabilities.reconciliationEnabled === true;
    if (reconciliationProvider.identity.network !== "devnet" || reconciliationProvider.identity.role !== "reconciliation" || reconciliationProvider.identity.providerId !== policy.reconciliationProviderId) throw new Error("Configured reconciliation provider does not match authoritative Devnet policy.");
    if(submissionProvider.identity.network!=="devnet"||submissionProvider.identity.role!=="submission"||submissionProvider.identity.providerId!==policy.submissionProviderId)throw new Error("Configured submission provider does not match authoritative Devnet policy.");
    if (policy.submissionProviderId === policy.reconciliationProviderId) throw new Error("Submission and reconciliation providers must be independent.");
    this.preparer = new ReferenceSolanaDevnetTransactionPreparer(policy, blockhashSource, signer);
    this.transport=new ProviderIndependentSolanaDevnetTransport(this.preparer,submissionProvider,reconciliationProvider);
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
    if(prior.state==="ABANDONED_PRE_CONTACT")throw new Error("Abandoned Devnet preparation cannot be replaced again.");if(prior.state!=="PREPARED_NOT_CONTACTED")throw new Error("Committed Devnet preparation is reconciliation-only and cannot be replaced.");const height=await this.blockHeightSource.getCurrentDevnetBlockHeight();const disposition=classifyDevnetBlockhash(prior.state,prior.artifact.lastValidBlockHeight,height);
    if(disposition!=="SAFE_TO_PREPARE_FRESH")throw new Error(disposition==="RECONCILIATION_REQUIRED"?"Committed Devnet preparation is reconciliation-only and cannot be replaced.":"Devnet preparation blockhash remains valid.");
    const identity={preparationId:nextPreparationId,executionId,paymentIntentId:prior.paymentIntentId,actorSubject,generation:prior.generation+1};this.assertIdentity(identity,command);
    const artifact=await this.preparer.prepare(command);return this.repository.replaceExpiredPreparation({priorPreparationId:prior.preparationId,replacement:this.persistence(identity,artifact),abandonedAt:this.clock()});
  }

  async submitPrepared(input:Readonly<{executionId:string;actorSubject:string;commitmentId:string;providerIdempotencyKey:string}>){
    const preparation=await this.repository.findPreparation(input.executionId,input.actorSubject);if(!preparation)throw new Error("Devnet preparation was not found for this owner.");
    if(!this.submissionEnabled)return Object.freeze({attempted:false as const,reason:"SUBMISSION_DISABLED" as const,preparation});
    if(preparation.state!=="PREPARED_NOT_CONTACTED")return Object.freeze({attempted:false as const,reason:"RECONCILIATION_ONLY" as const,preparation});
    const committed=await this.repository.commitSubmission({executionId:input.executionId,actorSubject:input.actorSubject,preparationId:preparation.preparationId,commitmentId:input.commitmentId,committedAt:this.clock()});
    if(!committed.submissionAuthorized)return Object.freeze({attempted:false as const,reason:"RECONCILIATION_ONLY" as const,preparation:committed.preparation});
    let runtime:SolanaDevnetPreparedTransaction;try{runtime=this.reconstruct(committed.preparation);}catch{return Object.freeze({attempted:false as const,reason:"VALIDATION_FAILED" as const,...await this.repository.recordSubmissionObservation({observationId:this.idFactory(),executionId:input.executionId,actorSubject:input.actorSubject,preparationId:preparation.preparationId,commitmentId:committed.commitment.commitmentId,providerId:this.submissionProvider.identity.providerId,signature:committed.commitment.signature,outcome:"VALIDATION_FAILED",contactCertainty:"NOT_STARTED",observedAt:this.clock(),providerErrorCode:"PERSISTED_ARTIFACT_INVALID"})});}
    const prepared=authorizeCommittedDevnetSubmission(Object.freeze({schemaVersion:1,contractVersion:1,rail:"solana",executionId:parseExecutionId(input.executionId),providerIdempotencyKey:parseProviderIdempotencyKey(input.providerIdempotencyKey),payload:Object.freeze({...runtime})}),Object.freeze({state:"SUBMISSION_COMMITTED_RECONCILE_ONLY",commitmentId:committed.commitment.commitmentId,executionId:committed.commitment.executionId,signature:committed.commitment.signature,signedTransactionDigest:committed.commitment.signedTransactionDigest,committedAt:committed.commitment.committedAt}));
    try{const result=await this.transport.submitTransaction(prepared);const persisted=await this.repository.recordSubmissionObservation({observationId:this.idFactory(),executionId:input.executionId,actorSubject:input.actorSubject,preparationId:preparation.preparationId,commitmentId:committed.commitment.commitmentId,providerId:this.submissionProvider.identity.providerId,signature:committed.commitment.signature,outcome:result.outcome==="settled"?"SETTLED":"ACCEPTED",contactCertainty:"ACCEPTED",observedAt:result.outcome==="settled"?result.settledAt:result.submittedAt,...(result.outcome==="settled"?{slot:result.slot,confirmationStatus:result.confirmationStatus}:{})});return Object.freeze({attempted:true as const,...persisted});}
    catch(error){const providerCode=conclusiveProviderCode(error),rejected=providerCode!==undefined;return Object.freeze({attempted:true as const,...await this.repository.recordSubmissionObservation({observationId:this.idFactory(),executionId:input.executionId,actorSubject:input.actorSubject,preparationId:preparation.preparationId,commitmentId:committed.commitment.commitmentId,providerId:this.submissionProvider.identity.providerId,signature:committed.commitment.signature,outcome:rejected?"REJECTED":"UNKNOWN",contactCertainty:"MAY_HAVE_OCCURRED",observedAt:this.clock(),providerErrorCode:providerCode??"SUBMISSION_RESPONSE_UNAVAILABLE"})});}
  }

  async reconcile(executionId:string,actorSubject:string){
    if(!this.reconciliationEnabled)return Object.freeze({attempted:false as const,reason:"RECONCILIATION_DISABLED" as const});
    const preparation=await this.repository.findPreparation(executionId,actorSubject);const commitment=await this.repository.findCommitment(executionId,actorSubject);
    if(!preparation||!commitment||commitment.preparationId!==preparation.preparationId)throw new Error("Committed Devnet preparation was not found for this owner.");
    if(preparation.artifact.reconciliationProviderId!==this.reconciliationProvider.identity.providerId)throw new Error("Persisted reconciliation provider identity changed.");
    let value:SolanaChainObservation;try{value=await this.reconciliationProvider.observeSignature(commitment.signature);}catch(error){return this.persistReconciliation(preparation,{executionId,actorSubject,preparationId:preparation.preparationId,providerId:this.reconciliationProvider.identity.providerId,outcome:"UNKNOWN",observedAt:this.clock(),errorCode:reconciliationErrorCode(error)});}
    if(value.providerId!==undefined&&value.providerId!==this.reconciliationProvider.identity.providerId)throw new Error("Reconciliation observation provider identity mismatch.");const outcome=value.status.toUpperCase() as "MISSING"|"PENDING"|"SETTLED"|"FAILED";
    return this.persistReconciliation(preparation,{executionId,actorSubject,preparationId:preparation.preparationId,providerId:this.reconciliationProvider.identity.providerId,outcome,observedAt:value.observedAt,...("slot" in value&&value.slot?{slot:value.slot}:{}),...("confirmationStatus" in value&&value.confirmationStatus?{confirmationStatus:value.confirmationStatus}:{}),...(value.status==="failed"?{errorCode:value.errorCode}:{})});
  }

  private async persistReconciliation(preparation:PersistedDevnetPreparation,input:Omit<Parameters<DevnetExecutionStateRepository["recordReconciliationObservation"]>[0],"observationId">){
    const observations=await this.repository.listReconciliationObservations(input.executionId,input.actorSubject),prior=observations[observations.length-1];
    if(prior&&sameReconciliation(prior,input))return Object.freeze({attempted:true as const,persisted:false as const,preparation,observation:prior});
    return Object.freeze({attempted:true as const,persisted:true as const,...await this.repository.recordReconciliationObservation({...input,observationId:this.idFactory()})});
  }

  private persistence(identity:DevnetPreparationIdentityInput,artifact:SolanaDevnetPreparedTransaction){const encryptedSignedTransaction=this.cipher.encrypt(artifact.signedTransactionBase64,{executionId:identity.executionId,preparationId:identity.preparationId,keyVersion:this.cipher.keyVersion});const{signedTransactionBase64:_,...economic}=artifact;return Object.freeze({...identity,encryptedSignedTransaction,artifact:Object.freeze(economic),preparedAt:this.clock()});}
  private reconstruct(stored:PersistedDevnetPreparation):SolanaDevnetPreparedTransaction{const signedTransactionBase64=this.cipher.decrypt(stored.encryptedSignedTransaction,{executionId:stored.executionId,preparationId:stored.preparationId,keyVersion:stored.encryptedSignedTransaction.keyVersion});if(signedTransactionDigest(signedTransactionBase64)!==stored.artifact.signedTransactionDigest)throw new Error("Persisted signed transaction digest does not match authenticated bytes.");return Object.freeze({...stored.artifact,signedTransactionBase64});}
  private assertIdentity(identity:DevnetPreparationIdentityInput,command:RailExecutionCommand){if(identity.executionId!==command.executionId||identity.paymentIntentId!==command.paymentIntentId||command.rail!=="solana"||command.destination.type!=="wallet"||command.destination.network!=="solana-devnet"||command.amount.asset!==this.policy.asset||command.amount.decimals!==this.policy.decimals)throw new Error("Runtime command does not match server-authoritative Devnet execution identity or policy.");}
}
function conclusiveProviderCode(error:unknown){if(!(error instanceof RailProviderOperationError))return undefined;if(error.message==="Devnet RPC provider.")return"CONCLUSIVE_PROVIDER_REJECTION";const match=/^Devnet RPC provider: ([A-Z0-9_.:-]{1,64})\.$/.exec(error.message);return match?.[1];}
function reconciliationErrorCode(error:unknown){if(typeof error==="object"&&error!==null){const value=error as{code?:unknown;providerErrorCode?:unknown};if(typeof value.providerErrorCode==="string"&&/^[A-Z0-9_.:-]{1,64}$/.test(value.providerErrorCode))return value.providerErrorCode;if(typeof value.code==="string"&&/^[A-Z0-9_]{1,48}$/.test(value.code))return`RPC_${value.code}`;}return"RPC_UNKNOWN";}
function sameReconciliation(prior:Readonly<{providerId:string;outcome:string;slot?:string;confirmationStatus?:string;errorCode?:string}>,next:Readonly<{providerId:string;outcome:string;slot?:string;confirmationStatus?:string;errorCode?:string}>){return prior.providerId===next.providerId&&prior.outcome===next.outcome&&prior.slot===next.slot&&prior.confirmationStatus===next.confirmationStatus&&prior.errorCode===next.errorCode;}
