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
