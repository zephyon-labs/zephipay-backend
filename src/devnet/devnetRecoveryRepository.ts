import type { PersistedDevnetPreparation } from "./devnetExecutionState";

export type DevnetRecoveryTaskKind="PREPARATION"|"RECONCILIATION";
export type DevnetRecoveryCandidate=Readonly<{
  executionId:string;paymentIntentId:string;actorSubject:string;providerIdempotencyKey:string;
  preparation?:PersistedDevnetPreparation;
}>;
export type DevnetRecoveryRecord=DevnetRecoveryCandidate&Readonly<{executionMode:"mock_beta"|"devnet_validation";selectedRail:"mock"|"solana";settlementNetwork:"simulated"|"solana-devnet";executionStatus:"READY"|"SUBMITTING"|"PROCESSING"|"UNKNOWN"|"SETTLED"|"FAILED"|"CANCELLED"}>;
export interface DevnetRecoveryRepository{
  claimPreparation(workerId:string,now:string,leaseExpiresAt:string,currentBlockHeight:string):Promise<DevnetRecoveryCandidate|undefined>;
  claimReconciliation(workerId:string,now:string,leaseExpiresAt:string):Promise<DevnetRecoveryCandidate|undefined>;
  release(executionId:string,taskKind:DevnetRecoveryTaskKind,workerId:string):Promise<void>;
}
