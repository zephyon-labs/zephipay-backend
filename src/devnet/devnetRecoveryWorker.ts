import type { DevnetRecoveryCandidate, DevnetRecoveryRepository, DevnetRecoveryTaskKind } from "./devnetRecoveryRepository";

export type DevnetRecoveryPolicy=Readonly<{preparationEnabled?:boolean;reconciliationEnabled?:boolean}>;
export type DevnetRecoveryHandlers=Readonly<{
  currentBlockHeight():Promise<string>;
  prepare(candidate:DevnetRecoveryCandidate):Promise<boolean>;
  reconcile(candidate:DevnetRecoveryCandidate):Promise<boolean>;
}>;

/** Operational recovery only. This type intentionally has no submit method or submission dependency. */
export class DevnetRecoveryWorker{
  private stopping=false;
  private readonly preparationEnabled:boolean;
  private readonly reconciliationEnabled:boolean;
  constructor(private readonly repository:DevnetRecoveryRepository,private readonly handlers:DevnetRecoveryHandlers,private readonly workerId:string,policy:DevnetRecoveryPolicy={},private readonly clock=()=>new Date().toISOString(),private readonly leaseMs=30_000){this.preparationEnabled=policy.preparationEnabled===true;this.reconciliationEnabled=policy.reconciliationEnabled===true;if(!workerId||workerId.trim()!==workerId)throw new Error("Devnet recovery worker ID is invalid.");}
  stop(){this.stopping=true;}
  start(){this.stopping=false;}
  async iterate():Promise<boolean>{if(this.stopping)return false;let worked=false;if(this.preparationEnabled&&!this.stopping)worked=await this.process("PREPARATION")||worked;if(this.reconciliationEnabled&&!this.stopping)worked=await this.process("RECONCILIATION")||worked;return worked;}
  private async process(kind:DevnetRecoveryTaskKind):Promise<boolean>{const now=this.clock(),expires=new Date(Date.parse(now)+this.leaseMs).toISOString(),candidate=kind==="PREPARATION"?await this.repository.claimPreparation(this.workerId,now,expires,await this.handlers.currentBlockHeight()):await this.repository.claimReconciliation(this.workerId,now,expires);if(!candidate)return false;try{const handled=kind==="PREPARATION"?await this.handlers.prepare(candidate):await this.handlers.reconcile(candidate);return kind==="PREPARATION"&&handled;}finally{await this.repository.release(candidate.executionId,kind,this.workerId);}}
}
