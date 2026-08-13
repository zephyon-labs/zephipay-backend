import type { DevnetRecoveryCandidate, DevnetRecoveryRecord, DevnetRecoveryRepository, DevnetRecoveryTaskKind } from "../../devnet/devnetRecoveryRepository";

export class InMemoryDevnetRecoveryRepository implements DevnetRecoveryRepository{
  private readonly records:DevnetRecoveryRecord[]=[];
  private readonly leases=new Map<string,{owner:string;expiresAt:string}>();
  private queue:Promise<void>=Promise.resolve();
  add(record:DevnetRecoveryRecord){this.records.push(Object.freeze({...record}));}
  claimPreparation(workerId:string,now:string,leaseExpiresAt:string,currentBlockHeight:string){if(!/^(0|[1-9]\d*)$/.test(currentBlockHeight))return Promise.reject(new Error("Current Devnet block height is invalid."));return this.claim("PREPARATION",workerId,now,leaseExpiresAt,currentBlockHeight);}
  claimReconciliation(workerId:string,now:string,leaseExpiresAt:string){return this.claim("RECONCILIATION",workerId,now,leaseExpiresAt);}
  release(executionId:string,kind:DevnetRecoveryTaskKind,workerId:string){return this.exclusive(()=>{const key=this.key(executionId,kind),lease=this.leases.get(key);if(lease?.owner===workerId)this.leases.delete(key);});}
  private claim(kind:DevnetRecoveryTaskKind,workerId:string,now:string,leaseExpiresAt:string,currentBlockHeight?:string){return this.exclusive(()=>{const record=this.records.filter(value=>this.eligible(value,kind,currentBlockHeight)).sort((a,b)=>a.executionId.localeCompare(b.executionId)).find(value=>{const lease=this.leases.get(this.key(value.executionId,kind));return !lease||lease.expiresAt<=now;});if(!record)return undefined;this.leases.set(this.key(record.executionId,kind),{owner:workerId,expiresAt:leaseExpiresAt});return clone(record);});}
  private eligible(value:DevnetRecoveryRecord,kind:DevnetRecoveryTaskKind,currentBlockHeight?:string){if(value.executionMode!=="devnet_validation"||value.selectedRail!=="solana"||value.settlementNetwork!=="solana-devnet"||["SETTLED","FAILED","CANCELLED"].includes(value.executionStatus))return false;const state=value.preparation?.state;return kind==="PREPARATION"?(state===undefined||(state==="PREPARED_NOT_CONTACTED"&&BigInt(currentBlockHeight!)>BigInt(value.preparation!.artifact.lastValidBlockHeight))):state!==undefined&&["SUBMISSION_COMMITTED_RECONCILE_ONLY","ACCEPTED_PENDING","UNKNOWN_RECONCILIATION_REQUIRED"].includes(state);}
  private key(executionId:string,kind:DevnetRecoveryTaskKind){return`${executionId}\0${kind}`;}
  private exclusive<T>(fn:()=>T|Promise<T>):Promise<T>{const run=this.queue.then(fn,fn);this.queue=run.then(()=>undefined,()=>undefined);return run;}
}
function clone(value:DevnetRecoveryRecord):DevnetRecoveryCandidate{return Object.freeze({executionId:value.executionId,paymentIntentId:value.paymentIntentId,actorSubject:value.actorSubject,providerIdempotencyKey:value.providerIdempotencyKey,...(value.preparation?{preparation:value.preparation}:{})});}
