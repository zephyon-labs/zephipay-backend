import type { JsonObject } from "../payments/paymentTypes";

export const EXECUTION_STATUSES = ["READY", "SUBMITTING", "PROCESSING", "UNKNOWN", "SETTLED", "FAILED", "CANCELLED"] as const;
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];
export type ExecutionOperation = "SUBMIT" | "RECONCILE";

export type PaymentExecution = Readonly<{
  executionId: string; paymentIntentId: string; actorSubject: string; status: ExecutionStatus;
  version: bigint; selectedRail: "mock" | "solana"; runtimeContractVersion: 1; adapterVersion: 1;
  providerIdempotencyKey: string; providerReference?: string; reconciliationReference?: string;
  attemptCount: number; observationSequence: number; nextAttemptAt?: string; lastReconciledAt?: string;
  failureCode?: string; failureCategory?: string; failureRetryable?: boolean; reviewReason?: string;
  settlementEvidence?: JsonObject; createdAt: string; startedAt?: string; submittedAt?: string;
  settledAt?: string; failedAt?: string; cancelledAt?: string; updatedAt: string;
  leaseOwner?: string; leaseExpiresAt?: string;
}>;

export type ExecutionAttempt = Readonly<{
  attemptId: string; executionId: string; attemptNumber: number; operation: ExecutionOperation;
  startedAt: string; completedAt?: string; outcome?: string; failureCode?: string;
  sideEffect?: "impossible" | "may_have_occurred" | "occurred"; recoveryAction?: string;
  evidence?: JsonObject;
}>;

export type ExecutionEvent = Readonly<{
  id: bigint; executionId: string; sequenceNumber: number; eventType: string;
  fromStatus?: ExecutionStatus; toStatus?: ExecutionStatus; details: JsonObject; occurredAt: string;
}>;

export type PublicPaymentExecution = Readonly<{
  executionId: string; paymentIntentId: string; status: "ready" | "processing" | "pending" | "settled" | "failed" | "cancelled";
  rail: Readonly<{ id: "mock"; label: "Mock Rail" } | { id: "solana"; label: "Solana Devnet" }>; createdAt: string; submittedAt?: string; settledAt?: string; failedAt?: string;
  receiptAvailable: boolean; receiptId?: string; failure?: Readonly<{ code: string; message: string }>;
  retryAllowed: boolean; stillProcessing: boolean; reconciliationPending: boolean;
}>;

export function toPublicExecution(value: PaymentExecution, receiptId?: string): PublicPaymentExecution {
  const status = value.status === "READY" ? "ready" : ["SUBMITTING","PROCESSING"].includes(value.status) ? "processing"
    : value.status === "UNKNOWN" ? "pending" : value.status.toLowerCase() as "settled" | "failed" | "cancelled";
  return Object.freeze({ executionId: value.executionId, paymentIntentId: value.paymentIntentId,
    status, rail: value.selectedRail === "solana" ? Object.freeze({ id: "solana" as const, label: "Solana Devnet" as const }) : Object.freeze({ id: "mock" as const, label: "Mock Rail" as const }), createdAt: value.createdAt,
    ...(value.submittedAt ? { submittedAt: value.submittedAt } : {}), ...(value.settledAt ? { settledAt: value.settledAt } : {}),
    ...(value.failedAt ? { failedAt: value.failedAt } : {}), receiptAvailable: receiptId !== undefined,
    ...(receiptId ? { receiptId } : {}), ...(value.status === "FAILED" ? { failure: safeFailure(value.failureCode) } : {}),
    retryAllowed: false, stillProcessing: ["SUBMITTING","PROCESSING","UNKNOWN"].includes(value.status),
    reconciliationPending: value.status === "UNKNOWN" });
}

function safeFailure(code?: string): Readonly<{ code: string; message: string }> {
  if (code === "REJECTED") return Object.freeze({ code: "PAYMENT_DECLINED", message: "The payment could not be completed." });
  return Object.freeze({ code: "EXECUTION_FAILED", message: "The payment could not be completed." });
}
