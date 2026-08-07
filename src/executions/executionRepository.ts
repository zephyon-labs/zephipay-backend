import type { JsonObject } from "../payments/paymentTypes";
import type { ExecutionAttempt, ExecutionOperation, ExecutionStatus, PaymentExecution } from "./executionTypes";

export type CreateExecutionInput = Readonly<{ executionId: string; paymentIntentId: string; actorSubject: string; providerIdempotencyKey: string; now: string }>;
export type CompleteOperationInput = Readonly<{
  executionId: string; expectedVersion: bigint; leaseOwner: string; attemptId: string; operation: ExecutionOperation;
  toStatus: ExecutionStatus; completedAt: string; providerReference?: string; reconciliationReference?: string;
  submittedAt?: string; settledAt?: string; failedAt?: string; failureCode?: string; failureCategory?: string;
  failureRetryable?: boolean; reviewReason?: string; evidence?: JsonObject; recoveryAction?: string;
  sideEffect?: "impossible" | "may_have_occurred" | "occurred"; nextAttemptAt?: string; observationSequence?: number;
}>;

export interface ExecutionRepository {
  createOrGet(input: CreateExecutionInput): Promise<Readonly<{ execution: PaymentExecution; created: boolean }>>;
  findByPaymentIntent(paymentIntentId: string): Promise<PaymentExecution | undefined>;
  claim(statuses: readonly ExecutionStatus[], workerId: string, now: string, leaseExpiresAt: string): Promise<Readonly<{ execution: PaymentExecution; attempt: ExecutionAttempt }> | undefined>;
  complete(input: CompleteOperationInput): Promise<PaymentExecution>;
  listAttempts(executionId: string): Promise<ExecutionAttempt[]>;
}

export const ALLOWED_EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = Object.freeze({
  READY: ["SUBMITTING", "CANCELLED"], SUBMITTING: ["PROCESSING", "UNKNOWN", "FAILED"],
  PROCESSING: ["SETTLED", "UNKNOWN", "FAILED"], UNKNOWN: ["PROCESSING", "SETTLED", "FAILED"],
  SETTLED: [], FAILED: [], CANCELLED: [],
});

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (from === to) return; // Operational lease/observation update; not an economic transition.
  if (!ALLOWED_EXECUTION_TRANSITIONS[from].includes(to)) throw new Error(`Invalid execution transition ${from} -> ${to}.`);
}
