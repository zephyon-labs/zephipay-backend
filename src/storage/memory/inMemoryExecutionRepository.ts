import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../payments/paymentTypes";
import { assertExecutionTransition, type CompleteOperationInput, type CreateExecutionInput, type ExecutionRepository } from "../../executions/executionRepository";
import type { ExecutionAttempt, ExecutionStatus, PaymentExecution } from "../../executions/executionTypes";

export class InMemoryExecutionRepository implements ExecutionRepository {
  private executions = new Map<string, PaymentExecution>(); private byIntent = new Map<string,string>();
  private attempts = new Map<string,ExecutionAttempt[]>(); private queue: Promise<void> = Promise.resolve();
  createOrGet(input: CreateExecutionInput) { return this.exclusive(() => {
    const id=this.byIntent.get(input.paymentIntentId); if(id) return {execution:this.clone(this.executions.get(id)!),created:false};
    const value: PaymentExecution=Object.freeze({executionId:input.executionId,paymentIntentId:input.paymentIntentId,actorSubject:input.actorSubject,status:"READY",version:0n,selectedRail:"mock",runtimeContractVersion:1,adapterVersion:1,providerIdempotencyKey:input.providerIdempotencyKey,attemptCount:0,observationSequence:0,createdAt:input.now,updatedAt:input.now});
    this.executions.set(value.executionId,value);this.byIntent.set(value.paymentIntentId,value.executionId);return {execution:this.clone(value),created:true}; }); }
  async findByPaymentIntent(id:string){const e=this.byIntent.get(id);return e?this.clone(this.executions.get(e)!):undefined;}
  claim(statuses:readonly ExecutionStatus[],workerId:string,now:string,leaseExpiresAt:string){return this.exclusive(()=>{
    const value=[...this.executions.values()].find(e=>statuses.includes(e.status)&&(!e.nextAttemptAt||e.nextAttemptAt<=now)&&(!e.leaseExpiresAt||e.leaseExpiresAt<=now)); if(!value)return undefined;
    const operation=value.status==="READY"?"SUBMIT" as const:"RECONCILE" as const; const status=value.status==="READY"?"SUBMITTING" as const:value.status;
    const updated=Object.freeze({...value,status,version:value.version+1n,attemptCount:value.attemptCount+1,startedAt:value.startedAt??now,leaseOwner:workerId,leaseExpiresAt,updatedAt:now});this.executions.set(value.executionId,updated);
    return {execution:this.clone(updated),attempt:Object.freeze({attemptId:randomUUID(),executionId:value.executionId,attemptNumber:updated.attemptCount,operation,startedAt:now})}; });}
  complete(input:CompleteOperationInput){return this.exclusive(()=>{const current=this.executions.get(input.executionId);if(!current)throw new Error("Execution not found.");if(current.version!==input.expectedVersion||current.leaseOwner!==input.leaseOwner)throw new Error("Execution version or lease conflict.");assertExecutionTransition(current.status,input.toStatus);
    if(current.providerReference&&input.providerReference&&current.providerReference!==input.providerReference)throw new Error("Provider reference is immutable.");
    const updated=Object.freeze({...current,status:input.toStatus,version:current.version+1n,providerReference:input.providerReference??current.providerReference,reconciliationReference:input.reconciliationReference??current.reconciliationReference,submittedAt:input.submittedAt??current.submittedAt,settledAt:input.settledAt??current.settledAt,failedAt:input.failedAt??current.failedAt,failureCode:input.failureCode??current.failureCode,failureCategory:input.failureCategory??current.failureCategory,failureRetryable:input.failureRetryable??current.failureRetryable,reviewReason:input.reviewReason??current.reviewReason,settlementEvidence:input.evidence?cloneJson(input.evidence):current.settlementEvidence,nextAttemptAt:input.nextAttemptAt,observationSequence:input.observationSequence??current.observationSequence,lastReconciledAt:input.operation==="RECONCILE"?input.completedAt:current.lastReconciledAt,leaseOwner:undefined,leaseExpiresAt:undefined,updatedAt:input.completedAt});this.executions.set(current.executionId,updated);
    const list=this.attempts.get(current.executionId)??[];list.push(Object.freeze({attemptId:input.attemptId,executionId:current.executionId,attemptNumber:current.attemptCount,operation:input.operation,startedAt:current.updatedAt,completedAt:input.completedAt,outcome:input.toStatus,failureCode:input.failureCode,sideEffect:input.sideEffect,recoveryAction:input.recoveryAction,evidence:input.evidence?cloneJson(input.evidence):undefined}));this.attempts.set(current.executionId,list);return this.clone(updated);});}
  async listAttempts(id:string){return (this.attempts.get(id)??[]).map(x=>Object.freeze({...x,evidence:x.evidence?cloneJson(x.evidence):undefined}));}
  private clone(e:PaymentExecution){return Object.freeze({...e,settlementEvidence:e.settlementEvidence?cloneJson(e.settlementEvidence):undefined});}
  private exclusive<T>(fn:()=>T|Promise<T>):Promise<T>{const run=this.queue.then(fn,fn);this.queue=run.then(()=>undefined,()=>undefined);return run;}
}
function cloneJson(value:JsonObject):JsonObject{return JSON.parse(JSON.stringify(value)) as JsonObject;}
