import type { SolanaDevnetPreparedTransaction } from "zephyon-protocol";

export const DEVNET_LIFECYCLE_STATES = [
  "PREPARED_NOT_CONTACTED",
  "SUBMISSION_COMMITTED_RECONCILE_ONLY",
  "ACCEPTED_PENDING",
  "UNKNOWN_RECONCILIATION_REQUIRED",
  "SETTLED",
  "FAILED",
  "ABANDONED_PRE_CONTACT",
] as const;
export type DevnetLifecycleState = typeof DEVNET_LIFECYCLE_STATES[number];

export type EncryptedSignedTransaction = Readonly<{
  algorithm: "aes-256-gcm";
  keyVersion: string;
  initializationVector: Buffer;
  authenticationTag: Buffer;
  ciphertext: Buffer;
}>;

export type DevnetPreparationIdentity = Readonly<{
  preparationId: string;
  executionId: string;
  paymentIntentId: string;
  actorSubject: string;
  generation: number;
}>;

export type PersistedDevnetPreparation = DevnetPreparationIdentity & Readonly<{
  state: DevnetLifecycleState;
  encryptedSignedTransaction: EncryptedSignedTransaction;
  artifact: Omit<SolanaDevnetPreparedTransaction, "signedTransactionBase64">;
  preparedAt: string;
  abandonedAt?: string;
  committedAt?: string;
}>;

export type PersistDevnetPreparationInput = DevnetPreparationIdentity & Readonly<{
  encryptedSignedTransaction: EncryptedSignedTransaction;
  artifact: Omit<SolanaDevnetPreparedTransaction, "signedTransactionBase64">;
  preparedAt: string;
}>;

export type DevnetSubmissionCommitmentRecord = Readonly<{
  commitmentId: string;
  executionId: string;
  preparationId: string;
  signature: string;
  signedTransactionDigest: string;
  committedAt: string;
}>;

export const DEVNET_RECONCILIATION_OUTCOMES = ["MISSING", "PENDING", "SETTLED", "FAILED", "UNKNOWN"] as const;
export type DevnetReconciliationOutcome = typeof DEVNET_RECONCILIATION_OUTCOMES[number];
export type DevnetReconciliationPersistenceFence=Readonly<{leaseOwner:string;leaseClaimedAt:string}>;
export type DevnetReconciliationObservation = Readonly<{
  observationId: string; executionId: string; preparationId: string; sequence: number;
  providerId: string; signature?:string; outcome: DevnetReconciliationOutcome; observedAt: string;
  slot?: string; confirmationStatus?: string; errorCode?: string;
}>;
export type DevnetSubmissionOutcome = "ACCEPTED"|"SETTLED"|"REJECTED"|"UNKNOWN"|"VALIDATION_FAILED";
export type DevnetProviderContactCertainty = "NOT_STARTED"|"MAY_HAVE_OCCURRED"|"ACCEPTED";
export type DevnetSubmissionObservation = Readonly<{
  observationId:string;executionId:string;preparationId:string;commitmentId:string;providerId:string;
  signature:string;outcome:DevnetSubmissionOutcome;contactCertainty:DevnetProviderContactCertainty;observedAt:string;
  providerErrorCode?:string;slot?:string;confirmationStatus?:string;
}>;

/** submissionAuthorized is deliberately return-only and is never a persisted field. */
export type CommitDevnetSubmissionResult = Readonly<{
  preparation: PersistedDevnetPreparation;
  commitment: DevnetSubmissionCommitmentRecord;
  submissionAuthorized: boolean;
}>;

export interface DevnetExecutionStateRepository {
  persistPreparation(input: PersistDevnetPreparationInput): Promise<PersistedDevnetPreparation>;
  replaceExpiredPreparation(input: Readonly<{ priorPreparationId: string; replacement: PersistDevnetPreparationInput; abandonedAt: string }>): Promise<PersistedDevnetPreparation>;
  commitSubmission(input: Readonly<{ executionId: string; actorSubject: string; preparationId: string; commitmentId: string; committedAt: string }>): Promise<CommitDevnetSubmissionResult>;
  findPreparation(executionId: string, actorSubject: string): Promise<PersistedDevnetPreparation | undefined>;
  findCommitment(executionId: string, actorSubject: string): Promise<DevnetSubmissionCommitmentRecord | undefined>;
  recordReconciliationObservation(input: Readonly<{ executionId: string; actorSubject: string; preparationId: string; observationId: string; providerId: string; signature:string; outcome: DevnetReconciliationOutcome; observedAt: string; slot?: string; confirmationStatus?: string; errorCode?: string; recoveryFence:DevnetReconciliationPersistenceFence }>): Promise<Readonly<{ preparation: PersistedDevnetPreparation; observation: DevnetReconciliationObservation }>>;
  listReconciliationObservations(executionId: string, actorSubject: string): Promise<DevnetReconciliationObservation[]>;
  recordSubmissionObservation(input: Readonly<{ observationId:string;executionId:string;actorSubject:string;preparationId:string;commitmentId:string;providerId:string;signature:string;outcome:DevnetSubmissionOutcome;contactCertainty:DevnetProviderContactCertainty;observedAt:string;providerErrorCode?:string;slot?:string;confirmationStatus?:string }>): Promise<Readonly<{preparation:PersistedDevnetPreparation;observation:DevnetSubmissionObservation}>>;
  listSubmissionObservations(executionId:string,actorSubject:string):Promise<DevnetSubmissionObservation[]>;
  listPreparationEligible(): Promise<PersistedDevnetPreparation[]>;
  listReconciliationEligible(): Promise<PersistedDevnetPreparation[]>;
}

export function assertProviderIdentities(submissionProviderId: unknown, reconciliationProviderId: unknown): void {
  for (const [role, value] of [["submission", submissionProviderId], ["reconciliation", reconciliationProviderId]] as const) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${role} provider ID must be a non-empty trimmed string.`);
  }
  if (submissionProviderId === reconciliationProviderId) throw new Error("Submission and reconciliation providers must be distinct.");
}

export function assertPreparedArtifact(input: PersistDevnetPreparationInput): void {
  const value = input.artifact;
  assertProviderIdentities(value.submissionProviderId, value.reconciliationProviderId);
  if (value.cluster !== "solana-devnet" || input.generation < 1 || !Number.isInteger(input.generation)) throw new Error("Invalid Devnet preparation identity.");
  if (!value.signature || !/^[a-f0-9]{64}$/.test(value.signedTransactionDigest) || !value.sourceTokenAccount || !value.mint || !value.destination || !/^[1-9]\d*$/.test(value.rawAmount)) throw new Error("Incomplete Devnet prepared artifact.");
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255 || !/^(0|[1-9]\d*)$/.test(value.lastValidBlockHeight)) throw new Error("Invalid Devnet amount or blockhash metadata.");
  if (!value.recentBlockhash || !value.signerKeyId || !value.signerKeyVersion || !value.signerPublicKey || !/^[a-f0-9]{64}$/.test(value.policyHash)) throw new Error("Incomplete Devnet signer or policy metadata.");
  const encrypted = input.encryptedSignedTransaction;
  if (encrypted.algorithm !== "aes-256-gcm" || !encrypted.keyVersion || encrypted.keyVersion.trim() !== encrypted.keyVersion || encrypted.initializationVector.length !== 12 || encrypted.authenticationTag.length !== 16 || encrypted.ciphertext.length === 0) throw new Error("Invalid encrypted signed transaction envelope.");
}

export function reconciliationLifecycle(current: DevnetLifecycleState, outcome: DevnetReconciliationOutcome): DevnetLifecycleState {
  if (["PREPARED_NOT_CONTACTED", "ABANDONED_PRE_CONTACT"].includes(current)) throw new Error("Reconciliation requires a durable submission commitment.");
  if (["SETTLED", "FAILED"].includes(current)) throw new Error("Terminal Devnet settlement truth cannot be changed by a later observation.");
  if (outcome === "SETTLED") return "SETTLED";
  if (outcome === "FAILED") return "FAILED";
  if (outcome === "PENDING") return "ACCEPTED_PENDING";
  return "UNKNOWN_RECONCILIATION_REQUIRED";
}

export function assertReconciliationEvidence(input: Readonly<{ providerId: string; signature:string; outcome: DevnetReconciliationOutcome; observedAt?:string; slot?: string; confirmationStatus?: string; errorCode?:string;recoveryFence:DevnetReconciliationPersistenceFence }>): void {
  if (!input.providerId || input.providerId.trim() !== input.providerId || input.providerId.length > 128) throw new Error("Reconciliation provider ID is invalid.");
  if (!input.signature || input.signature.trim() !== input.signature || input.signature.length > 256) throw new Error("Reconciliation signature evidence is invalid.");
  if (!validTime(input.observedAt)) throw new Error("Reconciliation observation time is invalid.");
  if (input.slot !== undefined && !/^(0|[1-9]\d*)$/.test(input.slot)) throw new Error("Reconciliation slot is invalid.");
  if (input.confirmationStatus !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(input.confirmationStatus)) throw new Error("Reconciliation confirmation status is invalid.");
  if ((input.outcome === "FAILED" && input.errorCode === undefined) || (input.errorCode !== undefined && input.outcome !== "FAILED" && input.outcome !== "UNKNOWN") || (input.errorCode !== undefined && !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.errorCode))) throw new Error("Reconciliation failure evidence is invalid.");
  if(input.outcome==="FAILED"&&input.errorCode!=="PROVIDER_REPORTED_FAILURE")throw new Error("Reconciliation terminal failure code is not authoritative chain evidence.");
  if((input.outcome==="SETTLED"||input.outcome==="FAILED")&&(input.confirmationStatus!=="finalized"||input.slot===undefined))throw new Error("Terminal reconciliation requires finalized exact-signature evidence.");
  if(input.outcome!=="SETTLED"&&input.outcome!=="FAILED"&&input.confirmationStatus==="finalized")throw new Error("Finalized reconciliation evidence must be represented as terminal truth.");
  if(!input.recoveryFence||!input.recoveryFence.leaseOwner||input.recoveryFence.leaseOwner.trim()!==input.recoveryFence.leaseOwner||input.recoveryFence.leaseOwner.length>128||!validTime(input.recoveryFence.leaseClaimedAt))throw new Error("Reconciliation persistence requires fenced recovery lease authority.");
}

export function submissionLifecycle(current:DevnetLifecycleState,outcome:DevnetSubmissionOutcome):DevnetLifecycleState{
  if(current==="PREPARED_NOT_CONTACTED"||current==="ABANDONED_PRE_CONTACT")throw new Error("Submission evidence requires the durable reconciliation-only commitment.");
  if(current==="SETTLED"||current==="FAILED")throw new Error("Terminal Devnet settlement truth cannot be changed by submission evidence.");
  if(outcome==="SETTLED")return"SETTLED";if(outcome==="REJECTED")return"FAILED";if(outcome==="ACCEPTED")return"ACCEPTED_PENDING";
  return current==="ACCEPTED_PENDING"?current:"UNKNOWN_RECONCILIATION_REQUIRED";
}
export function assertSubmissionEvidence(input:Readonly<{providerId:string;signature:string;outcome:DevnetSubmissionOutcome;contactCertainty:DevnetProviderContactCertainty;providerErrorCode?:string;slot?:string;confirmationStatus?:string}>):void{
  if(!input.providerId||input.providerId.trim()!==input.providerId||input.providerId.length>128||!input.signature||input.signature.trim()!==input.signature)throw new Error("Submission provider evidence identity is invalid.");
  if(input.providerErrorCode!==undefined&&!/^[A-Za-z0-9_.:-]{1,64}$/.test(input.providerErrorCode))throw new Error("Submission provider error code is invalid.");
  if(input.slot!==undefined&&!/^(0|[1-9]\d*)$/.test(input.slot))throw new Error("Submission slot is invalid.");if(input.confirmationStatus!==undefined&&!/^[A-Za-z0-9_-]{1,32}$/.test(input.confirmationStatus))throw new Error("Submission confirmation status is invalid.");
  if((input.outcome==="VALIDATION_FAILED")!==(input.contactCertainty==="NOT_STARTED")||(input.outcome==="ACCEPTED"||input.outcome==="SETTLED")!==(input.contactCertainty==="ACCEPTED"))throw new Error("Submission outcome contact certainty is contradictory.");
}
function validTime(value:unknown){return typeof value==="string"&&Number.isFinite(Date.parse(value));}
