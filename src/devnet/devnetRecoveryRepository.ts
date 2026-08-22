import type { DevnetReconciliationPersistenceFence, PersistedDevnetPreparation } from "./devnetExecutionState";

export type DevnetRecoveryTaskKind="PREPARATION"|"RECONCILIATION";
export type DevnetRecoveryLease=Readonly<{taskKind:DevnetRecoveryTaskKind;leaseOwner:string;claimedAt:string;leaseExpiresAt:string}>;
export type DevnetRecoveryLeaseControl=Readonly<{fence:DevnetReconciliationPersistenceFence;renew():Promise<boolean>}>;
export type DevnetRecoveryCandidate=Readonly<{
  executionId:string;paymentIntentId:string;actorSubject:string;providerIdempotencyKey:string;
  preparation?:PersistedDevnetPreparation;
  recoveryLease?:DevnetRecoveryLease;
}>;
export type DevnetRecoveryRecord=DevnetRecoveryCandidate&Readonly<{executionMode:"mock_beta"|"devnet_validation";selectedRail:"mock"|"solana";settlementNetwork:"simulated"|"solana-devnet";executionStatus:"READY"|"SUBMITTING"|"PROCESSING"|"UNKNOWN"|"SETTLED"|"FAILED"|"CANCELLED"}>;
export type DevnetRecoveryBacklog=Readonly<{unresolvedCount:number;oldestCommittedAt?:string;oldestUnresolvedAgeMs?:number}>;
export interface DevnetRecoveryRepository{
  claimPreparation(workerId:string,now:string,leaseExpiresAt:string,currentBlockHeight:string):Promise<DevnetRecoveryCandidate|undefined>;
  claimReconciliation(workerId:string,now:string,leaseExpiresAt:string):Promise<DevnetRecoveryCandidate|undefined>;
  claimReconciliationExecution(executionId:string,workerId:string,now:string,leaseExpiresAt:string):Promise<DevnetRecoveryCandidate|undefined>;
  renew(executionId:string,taskKind:DevnetRecoveryTaskKind,workerId:string,claimedAt:string,now:string,leaseExpiresAt:string):Promise<boolean>;
  inspectUnresolvedBacklog(now:string):Promise<DevnetRecoveryBacklog>;
  release(executionId:string,taskKind:DevnetRecoveryTaskKind,workerId:string,claimedAt:string):Promise<void>;
}
