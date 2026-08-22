import type { CommitDevnetSubmissionResult, DevnetExecutionStateRepository, DevnetReconciliationObservation, DevnetSubmissionCommitmentRecord, DevnetSubmissionObservation, PersistDevnetPreparationInput, PersistedDevnetPreparation } from "../../devnet/devnetExecutionState";
import { assertPreparedArtifact, assertReconciliationEvidence, assertSubmissionEvidence, reconciliationLifecycle, submissionLifecycle } from "../../devnet/devnetExecutionState";

export class InMemoryDevnetExecutionStateRepository implements DevnetExecutionStateRepository {
  private readonly preparations = new Map<string, PersistedDevnetPreparation>();
  private readonly commitments = new Map<string, DevnetSubmissionCommitmentRecord>();
  private readonly observations = new Map<string, DevnetReconciliationObservation[]>();
  private readonly submissionObservations = new Map<string, DevnetSubmissionObservation[]>();
  private queue: Promise<void> = Promise.resolve();

  persistPreparation(input: PersistDevnetPreparationInput) { return this.exclusive(() => {
    assertPreparedArtifact(input); this.assertUnique(input);
    const active = this.active(input.executionId); if (active) throw new Error("Execution already has an active Devnet preparation.");
    const value = freezePreparation({ ...input, state: "PREPARED_NOT_CONTACTED" });
    this.preparations.set(input.preparationId, value); return clonePreparation(value);
  }); }

  replaceExpiredPreparation(input: Readonly<{ priorPreparationId: string; replacement: PersistDevnetPreparationInput; abandonedAt: string }>) { return this.exclusive(() => {
    assertPreparedArtifact(input.replacement);
    const prior = this.preparations.get(input.priorPreparationId);
    if (!prior || prior.executionId !== input.replacement.executionId || prior.actorSubject !== input.replacement.actorSubject) throw new Error("Prior preparation was not found for this owner.");
    if (prior.state !== "PREPARED_NOT_CONTACTED" || this.commitments.has(prior.executionId)) throw new Error("Committed Devnet preparation is reconciliation-only and cannot be replaced.");
    if (input.replacement.generation !== prior.generation + 1) throw new Error("Replacement preparation generation must increment exactly once.");
    this.assertUnique(input.replacement);
    this.preparations.set(prior.preparationId, freezePreparation({ ...prior, state: "ABANDONED_PRE_CONTACT", abandonedAt: input.abandonedAt }));
    const replacement = freezePreparation({ ...input.replacement, state: "PREPARED_NOT_CONTACTED" });
    this.preparations.set(replacement.preparationId, replacement); return clonePreparation(replacement);
  }); }

  commitSubmission(input: Readonly<{ executionId: string; actorSubject: string; preparationId: string; commitmentId: string; committedAt: string }>) { return this.exclusive<CommitDevnetSubmissionResult>(() => {
    const existing = this.commitments.get(input.executionId);
    if (existing) {
      if (existing.preparationId !== input.preparationId || existing.commitmentId !== input.commitmentId) throw new Error("Devnet submission commitment conflict.");
      return Object.freeze({ preparation: clonePreparation(this.preparations.get(existing.preparationId)!), commitment: Object.freeze({ ...existing }), submissionAuthorized: false });
    }
    const preparation = this.preparations.get(input.preparationId);
    if (!preparation || preparation.executionId !== input.executionId || preparation.actorSubject !== input.actorSubject) throw new Error("Prepared artifact was not found for this owner.");
    if (preparation.state !== "PREPARED_NOT_CONTACTED") throw new Error("Only a never-contacted preparation may be committed.");
    const commitment = Object.freeze({ commitmentId: input.commitmentId, executionId: input.executionId, preparationId: input.preparationId, signature: preparation.artifact.signature, signedTransactionDigest: preparation.artifact.signedTransactionDigest, committedAt: input.committedAt });
    const committed = freezePreparation({ ...preparation, state: "SUBMISSION_COMMITTED_RECONCILE_ONLY", committedAt: input.committedAt });
    this.commitments.set(input.executionId, commitment); this.preparations.set(input.preparationId, committed);
    return Object.freeze({ preparation: clonePreparation(committed), commitment, submissionAuthorized: true });
  }); }

  async findPreparation(executionId: string, actorSubject: string) { const value=this.active(executionId); return value?.actorSubject===actorSubject ? clonePreparation(value) : undefined; }
  async findCommitment(executionId: string, actorSubject: string) { const preparation=this.active(executionId),value=this.commitments.get(executionId); return preparation?.actorSubject===actorSubject&&value ? Object.freeze({...value}) : undefined; }
  recordReconciliationObservation(input:Parameters<DevnetExecutionStateRepository["recordReconciliationObservation"]>[0]) { return this.exclusive(() => {
    assertReconciliationEvidence(input); const preparation=this.preparations.get(input.preparationId);
    if(!preparation||preparation.executionId!==input.executionId||preparation.actorSubject!==input.actorSubject)throw new Error("Prepared artifact was not found for this owner.");
    if(input.providerId!==preparation.artifact.reconciliationProviderId)throw new Error("Reconciliation provider does not match immutable preparation policy.");const commitment=this.commitments.get(input.executionId);if(!commitment||input.signature!==preparation.artifact.signature||input.signature!==commitment.signature)throw new Error("Reconciliation signature does not match the immutable commitment.");
    const list=this.observations.get(input.executionId)??[],latest=list[list.length-1];if(latest&&(["SETTLED","FAILED"].includes(preparation.state)||sameReconciliationObservation(latest,input)))return Object.freeze({preparation:clonePreparation(preparation),observation:Object.freeze({...latest})});const state=reconciliationLifecycle(preparation.state,input.outcome);
    if(list.some(value=>value.observationId===input.observationId))throw new Error("Reconciliation observation ID already exists.");
    const{recoveryFence:_,...evidence}=input,observation=Object.freeze({...evidence,sequence:list.length+1});list.push(observation);this.observations.set(input.executionId,list);
    const updated=freezePreparation({...preparation,state});this.preparations.set(preparation.preparationId,updated);return Object.freeze({preparation:clonePreparation(updated),observation});
  }); }
  async listReconciliationObservations(executionId:string,actorSubject:string){const preparation=this.active(executionId);return preparation?.actorSubject===actorSubject?(this.observations.get(executionId)??[]).map(value=>Object.freeze({...value})):[];}
  recordSubmissionObservation(input:Parameters<DevnetExecutionStateRepository["recordSubmissionObservation"]>[0]){return this.exclusive(()=>{assertSubmissionEvidence(input);const preparation=this.preparations.get(input.preparationId),commitment=this.commitments.get(input.executionId);if(!preparation||preparation.executionId!==input.executionId||preparation.actorSubject!==input.actorSubject||!commitment||commitment.commitmentId!==input.commitmentId)throw new Error("Committed preparation was not found for this owner.");if(input.providerId!==preparation.artifact.submissionProviderId||input.signature!==commitment.signature)throw new Error("Submission evidence does not match immutable commitment policy.");const state=submissionLifecycle(preparation.state,input.outcome),list=this.submissionObservations.get(input.executionId)??[];if(list.some(value=>value.observationId===input.observationId))throw new Error("Submission observation ID already exists.");const{actorSubject:_,...evidence}=input,observation=Object.freeze(evidence);list.push(observation);this.submissionObservations.set(input.executionId,list);const updated=freezePreparation({...preparation,state});this.preparations.set(preparation.preparationId,updated);return Object.freeze({preparation:clonePreparation(updated),observation});});}
  async listSubmissionObservations(executionId:string,actorSubject:string){const preparation=this.active(executionId);return preparation?.actorSubject===actorSubject?(this.submissionObservations.get(executionId)??[]).map(value=>Object.freeze({...value})):[];}
  async listPreparationEligible() { return [...this.preparations.values()].filter((value)=>value.state==="PREPARED_NOT_CONTACTED").map(clonePreparation); }
  async listReconciliationEligible() { return [...this.preparations.values()].filter((value)=>["SUBMISSION_COMMITTED_RECONCILE_ONLY","ACCEPTED_PENDING","UNKNOWN_RECONCILIATION_REQUIRED"].includes(value.state)).map(clonePreparation); }

  private active(executionId:string){return [...this.preparations.values()].find((value)=>value.executionId===executionId&&value.state!=="ABANDONED_PRE_CONTACT");}
  private assertUnique(input:PersistDevnetPreparationInput){for(const value of this.preparations.values()){if(value.preparationId===input.preparationId)throw new Error("Preparation ID already exists.");if(value.artifact.signature===input.artifact.signature)throw new Error("Devnet transaction signature already exists.");if(value.artifact.signedTransactionDigest===input.artifact.signedTransactionDigest)throw new Error("Devnet signed-byte digest already exists.");}}
  private exclusive<T>(fn:()=>T|Promise<T>):Promise<T>{const run=this.queue.then(fn,fn);this.queue=run.then(()=>undefined,()=>undefined);return run;}
}

function freezePreparation(value:any):PersistedDevnetPreparation{return Object.freeze({...value,encryptedSignedTransaction:Object.freeze({...value.encryptedSignedTransaction,initializationVector:Buffer.from(value.encryptedSignedTransaction.initializationVector),authenticationTag:Buffer.from(value.encryptedSignedTransaction.authenticationTag),ciphertext:Buffer.from(value.encryptedSignedTransaction.ciphertext)}),artifact:Object.freeze({...value.artifact})});}
function clonePreparation(value:PersistedDevnetPreparation):PersistedDevnetPreparation{return freezePreparation(value);}
function sameReconciliationObservation(prior:Readonly<{providerId:string;signature?:string;outcome:string;slot?:string;confirmationStatus?:string;errorCode?:string}>,next:Readonly<{providerId:string;signature:string;outcome:string;slot?:string;confirmationStatus?:string;errorCode?:string}>){return prior.providerId===next.providerId&&prior.signature===next.signature&&prior.outcome===next.outcome&&prior.slot===next.slot&&prior.confirmationStatus===next.confirmationStatus&&prior.errorCode===next.errorCode;}
