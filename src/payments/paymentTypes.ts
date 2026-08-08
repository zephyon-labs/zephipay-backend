export const PAYMENT_STATUSES = [
  "AWAITING_CONFIRMATION",
  "PROCESSING",
  "UNKNOWN",
  "COMPLETED",
  "FAILED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_EVENT_TYPES = [
  "CREATED",
  "USER_CONFIRMED",
  "RUNTIME_APPROVED",
  "SUBMISSION_STARTED",
  "SIGNATURE_OBSERVED",
  "SETTLEMENT_UNKNOWN",
  "SETTLEMENT_CONFIRMED",
  "SETTLEMENT_FAILED",
  "RECEIPT_VERIFIED",
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export const INFORMATIONAL_PAYMENT_EVENT_TYPES = [
  "CREATED",
  "USER_CONFIRMED",
  "RUNTIME_APPROVED",
  "SUBMISSION_STARTED",
  "SIGNATURE_OBSERVED",
  "SETTLEMENT_UNKNOWN",
] as const satisfies readonly PaymentEventType[];

export type InformationalPaymentEventType =
  (typeof INFORMATIONAL_PAYMENT_EVENT_TYPES)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export const PAYMENT_RECIPIENT_TYPES = ["DIRECT_WALLET", "PAYMENT_IDENTITY"] as const;
export type PaymentRecipientType = (typeof PAYMENT_RECIPIENT_TYPES)[number];
export const TRUST_CONFIRMATION_OUTCOMES = ["NOT_REQUIRED", "ACKNOWLEDGED", "BLOCKED"] as const;
export type TrustConfirmationOutcome = (typeof TRUST_CONFIRMATION_OUTCOMES)[number];

export type PaymentIdentitySnapshot = Readonly<{
  accountId: string;
  username: string;
  displayName: string;
  accountType: "PERSONAL" | "CREATOR" | "BUSINESS" | "AI_AGENT";
  verificationState: "UNVERIFIED" | "PENDING" | "VERIFIED";
  payabilityState: "AVAILABLE";
  capturedAt: string;
  schemaVersion: 1;
  identitySource?: "RECIPIENT_DIRECTORY" | "SYNTHETIC_BETA";
  resolutionSource: "RECIPIENT_DIRECTORY" | "SYNTHETIC_BETA";
  trustOutcome: Exclude<TrustConfirmationOutcome, "BLOCKED">;
}>;

export type PreSubmissionRejectionProof = Readonly<{
  kind: "PRE_SUBMISSION_REJECTION";
  code: string;
  reason: string;
}>;

export type SolanaTransactionErrorProof = Readonly<{
  kind: "SOLANA_TRANSACTION_ERROR";
  signature: string;
  slot?: string;
  chainError: JsonValue;
}>;

export type ExpiredUnsignedTransactionProof = Readonly<{
  kind: "EXPIRED_UNSIGNED_TRANSACTION";
  recentBlockhash: string;
  lastValidBlockHeight: string;
  transactionWasSigned: false;
  submissionWasAttempted: false;
}>;

export type PaymentTerminalProof =
  | PreSubmissionRejectionProof
  | SolanaTransactionErrorProof
  | ExpiredUnsignedTransactionProof;

export type PaymentRecord = Readonly<{
  id: string;
  actorSubject: string;
  idempotencyKey: string;
  requestHash: string;
  status: PaymentStatus;
  version: bigint;
  network: "solana-devnet";
  rail: "solana";
  asset: "USDC";
  mintAddress: string;
  recipientAddress: string;
  amountRaw: bigint;
  purpose: string | null;
  recipientType: PaymentRecipientType;
  recipientAccountId?: string;
  recipientSyntheticId?: string;
  recipientSnapshot?: PaymentIdentitySnapshot;
  recipientSnapshotVersion?: 1;
  trustConfirmationOutcome?: Exclude<TrustConfirmationOutcome, "BLOCKED">;
  runtimeId?: string;
  runtimePaymentId?: string;
  runtimeTransactionId?: string;
  userConfirmedAt?: string;
  executionStartedAt?: string;
  submittedAt?: string;
  lastCheckedAt?: string;
  completedAt?: string;
  failedAt?: string;
  solanaSignature?: string;
  recentBlockhash?: string;
  submittedSlot?: bigint;
  confirmedSlot?: bigint;
  confirmationStatus?: string;
  chainError?: JsonValue;
  receiptPda?: string;
  failureCode?: string;
  failureReason?: string;
  terminalProof?: PaymentTerminalProof;
  createdAt: string;
  updatedAt: string;
}>;

export type PaymentEvent = Readonly<{
  id: bigint;
  paymentId: string;
  sequenceNumber: number;
  eventType: PaymentEventType;
  fromStatus?: PaymentStatus;
  toStatus?: PaymentStatus;
  runtimeEventId?: string;
  requestId?: string;
  details: JsonObject;
  occurredAt: string;
}>;

export type CreatePaymentInput = Pick<
  PaymentRecord,
  | "id"
  | "actorSubject"
  | "idempotencyKey"
  | "requestHash"
  | "network"
  | "rail"
  | "asset"
  | "mintAddress"
  | "recipientAddress"
  | "amountRaw"
  | "purpose"
> & Partial<Pick<PaymentRecord,
  "recipientType" | "recipientAccountId" | "recipientSyntheticId" | "recipientSnapshot" |
  "recipientSnapshotVersion" | "trustConfirmationOutcome"
>>;

export type PaymentLifecycleEvidence = Readonly<{
  runtimeId?: string;
  runtimePaymentId?: string;
  runtimeTransactionId?: string;
  userConfirmedAt?: string;
  executionStartedAt?: string;
  submittedAt?: string;
  lastCheckedAt?: string;
  completedAt?: string;
  failedAt?: string;
  solanaSignature?: string;
  recentBlockhash?: string;
  submittedSlot?: bigint;
  confirmedSlot?: bigint;
  confirmationStatus?: string;
  chainError?: JsonValue;
  receiptPda?: string;
  failureCode?: string;
  failureReason?: string;
  terminalProof?: PaymentTerminalProof;
}>;

export type PaymentFailureEvidence = PaymentLifecycleEvidence & Readonly<{
  failedAt: string;
  failureCode: string;
  terminalProof: PaymentTerminalProof;
}>;
