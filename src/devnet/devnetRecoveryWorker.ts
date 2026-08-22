import type { DevnetRecoveryCandidate, DevnetRecoveryLeaseControl, DevnetRecoveryRepository, DevnetRecoveryTaskKind } from "./devnetRecoveryRepository";

export type DevnetRecoveryPolicy=Readonly<{preparationEnabled?:boolean;reconciliationEnabled?:boolean}>;
export const DEVNET_RECOVERY_BACKLOG_WARNING_MS=5*60_000;
export type DevnetRecoveryOperationalEvent=Readonly<{
  event:"iteration"|"heartbeat";
  outcome:"work"|"idle"|"failure";
  phase:"preparation"|"reconciliation"|"iteration";
  backlog?:"empty"|"present"|"warning"|"unavailable";
  unresolvedCount?:number;
  oldestUnresolvedAgeMs?:number;
}>;
export type DevnetRecoveryHandlers=Readonly<{
  currentBlockHeight():Promise<string>;
  prepare(candidate:DevnetRecoveryCandidate):Promise<boolean>;
  reconcile(candidate:DevnetRecoveryCandidate,lease:DevnetRecoveryLeaseControl):Promise<boolean>;
}>;

/** Operational recovery only. This type intentionally has no submit method or submission dependency. */
export class DevnetRecoveryWorker{
  private stopping=false;
  private readonly preparationEnabled:boolean;
  private readonly reconciliationEnabled:boolean;
  constructor(private readonly repository:DevnetRecoveryRepository,private readonly handlers:DevnetRecoveryHandlers,private readonly workerId:string,policy:DevnetRecoveryPolicy={},private readonly clock=()=>new Date().toISOString(),private readonly leaseMs=30_000,private readonly observer:(event:DevnetRecoveryOperationalEvent)=>void=()=>undefined){this.preparationEnabled=policy.preparationEnabled===true;this.reconciliationEnabled=policy.reconciliationEnabled===true;if(!workerId||workerId.trim()!==workerId)throw new Error("Devnet recovery worker ID is invalid.");}
  stop(){this.stopping=true;}
  start(){this.stopping=false;}
  async iterate():Promise<boolean>{if(this.stopping)return false;let phase:"preparation"|"reconciliation"|"iteration"="iteration";try{let worked=false;if(this.preparationEnabled&&!this.stopping){phase="preparation";worked=await this.process("PREPARATION")||worked;}if(this.reconciliationEnabled&&!this.stopping){phase="reconciliation";worked=await this.process("RECONCILIATION")||worked;}const outcome=worked?"work":"idle";this.observe({event:"iteration",outcome,phase:"iteration"});await this.heartbeat(outcome);return worked;}catch(error){this.observe({event:"iteration",outcome:"failure",phase});await this.heartbeat("failure");throw error;}}
  private async process(kind:DevnetRecoveryTaskKind):Promise<boolean>{const now=this.clock(),expires=new Date(Date.parse(now)+this.leaseMs).toISOString(),candidate=kind==="PREPARATION"?await this.repository.claimPreparation(this.workerId,now,expires,await this.handlers.currentBlockHeight()):await this.repository.claimReconciliation(this.workerId,now,expires);if(!candidate)return false;const claimed=candidate.recoveryLease;if(!claimed||claimed.taskKind!==kind||claimed.leaseOwner!==this.workerId)throw new Error("Devnet recovery claim did not return its lease fence.");const lease:DevnetRecoveryLeaseControl=Object.freeze({fence:Object.freeze({leaseOwner:claimed.leaseOwner,leaseClaimedAt:claimed.claimedAt}),renew:async()=>{const renewalAt=this.clock(),renewedUntil=new Date(Date.parse(renewalAt)+this.leaseMs).toISOString();return this.repository.renew(candidate.executionId,kind,this.workerId,claimed.claimedAt,renewalAt,renewedUntil);}});try{if(kind==="PREPARATION")await this.handlers.prepare(candidate);else await this.handlers.reconcile(candidate,lease);return true;}finally{await this.repository.release(candidate.executionId,kind,this.workerId,claimed.claimedAt);}}
  private async heartbeat(outcome:"work"|"idle"|"failure"){try{const backlog=await this.repository.inspectUnresolvedBacklog(this.clock()),state=backlog.unresolvedCount===0?"empty":(backlog.oldestUnresolvedAgeMs??0)>=DEVNET_RECOVERY_BACKLOG_WARNING_MS?"warning":"present";this.observe({event:"heartbeat",outcome,phase:"iteration",backlog:state,unresolvedCount:backlog.unresolvedCount,...(backlog.oldestUnresolvedAgeMs===undefined?{}:{oldestUnresolvedAgeMs:backlog.oldestUnresolvedAgeMs})});}catch{this.observe({event:"heartbeat",outcome,phase:"iteration",backlog:"unavailable"});}}
  private observe(event:DevnetRecoveryOperationalEvent){try{this.observer(Object.freeze({...event}));}catch{/* Observability cannot stop recovery. */}}
}
