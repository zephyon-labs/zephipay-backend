import type { JsonObject } from "../payments/paymentTypes";

export const EXECUTION_STATUSES = ["READY", "SUBMITTING", "PROCESSING", "UNKNOWN", "SETTLED", "FAILED", "CANCELLED"] as const;
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];
export type ExecutionOperation = "SUBMIT" | "RECONCILE";

export type PaymentExecution = Readonly<{
  executionId: string; paymentIntentId: string; actorSubject: string; status: ExecutionStatus;
  version: bigint; selectedRail: "mock"; runtimeContractVersion: 1; adapterVersion: 1;
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
  executionId: string; paymentIntentId: string; status: Lowercase<ExecutionStatus>; rail: "mock";
  createdAt: string; submittedAt?: string; settledAt?: string; failure?: Readonly<{ code: string; retryable: boolean }>;
  processingContinues: boolean;
}>;

export function toPublicExecution(value: PaymentExecution): PublicPaymentExecution {
  return Object.freeze({ executionId: value.executionId, paymentIntentId: value.paymentIntentId,
    status: value.status.toLowerCase() as Lowercase<ExecutionStatus>, rail: "mock", createdAt: value.createdAt,
    ...(value.submittedAt ? { submittedAt: value.submittedAt } : {}), ...(value.settledAt ? { settledAt: value.settledAt } : {}),
    ...(value.failureCode ? { failure: { code: value.failureCode, retryable: value.failureRetryable === true } } : {}),
    processingContinues: ["READY", "SUBMITTING", "PROCESSING", "UNKNOWN"].includes(value.status) });
}
