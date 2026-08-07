import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../payments/paymentTypes";
import { assertExecutionTransition, type CompleteOperationInput, type CreateExecutionInput, type ExecutionRepository } from "../../executions/executionRepository";
import type { ExecutionReceipt } from "../../executions/executionReceiptTypes";
import type { ExecutionAttempt, ExecutionEvent, ExecutionStatus, PaymentExecution } from "../../executions/executionTypes";

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly executions = new Map<string, PaymentExecution>();
  private readonly byIntent = new Map<string, string>();
  private readonly attempts = new Map<string, ExecutionAttempt[]>();
  private readonly events = new Map<string, ExecutionEvent[]>();
  private readonly receipts = new Map<string, ExecutionReceipt>();
  private queue: Promise<void> = Promise.resolve();
  private nextEventId = 1n;

  createOrGet(input: CreateExecutionInput) { return this.exclusive(() => {
    const existingId = this.byIntent.get(input.paymentIntentId);
    if (existingId) return { execution: this.clone(this.executions.get(existingId)!), created: false };
    const value: PaymentExecution = Object.freeze({ executionId: input.executionId, paymentIntentId: input.paymentIntentId,
      actorSubject: input.actorSubject, status: "READY", version: 0n, selectedRail: "mock", runtimeContractVersion: 1,
      adapterVersion: 1, providerIdempotencyKey: input.providerIdempotencyKey, attemptCount: 0, observationSequence: 0,
      createdAt: input.now, updatedAt: input.now });
    this.executions.set(value.executionId, value); this.byIntent.set(value.paymentIntentId, value.executionId);
    this.appendEvent(value.executionId, "execution_created", undefined, "READY", input.now);
    return { execution: this.clone(value), created: true };
  }); }

  async findByPaymentIntent(id: string) { const executionId = this.byIntent.get(id); return executionId ? this.clone(this.executions.get(executionId)!) : undefined; }
  async findReceiptByPaymentIntent(id: string) { const value = this.receipts.get(id); return value ? cloneReceipt(value) : undefined; }

  claim(statuses: readonly ExecutionStatus[], workerId: string, now: string, leaseExpiresAt: string) { return this.exclusive(() => {
    const current = [...this.executions.values()].find((e) => statuses.includes(e.status) && (!e.nextAttemptAt || e.nextAttemptAt <= now) && (!e.leaseExpiresAt || e.leaseExpiresAt <= now));
    if (!current) return undefined;
    const operation = current.status === "READY" ? "SUBMIT" as const : "RECONCILE" as const;
    const status = current.status === "READY" ? "SUBMITTING" as const : current.status;
    const updated = Object.freeze({ ...current, status, version: current.version + 1n, attemptCount: current.attemptCount + 1,
      startedAt: current.startedAt ?? now, leaseOwner: workerId, leaseExpiresAt, updatedAt: now });
    this.executions.set(current.executionId, updated);
    this.appendEvent(current.executionId, operation === "SUBMIT" ? "submission_started" : "reconciliation_pending", current.status, status, now);
    return { execution: this.clone(updated), attempt: Object.freeze({ attemptId: randomUUID(), executionId: current.executionId,
      attemptNumber: updated.attemptCount, operation, startedAt: now }) };
  }); }

  complete(input: CompleteOperationInput) { return this.exclusive(() => this.completeUnsafe(input)); }

  completeSettlement(input: Readonly<{ completion: CompleteOperationInput; receipt: ExecutionReceipt }>) {
    return this.exclusive(() => {
      if (input.completion.toStatus !== "SETTLED") throw new Error("Settlement completion must be SETTLED.");
      const existing = this.receipts.get(input.receipt.paymentIntentId);
      if (existing) {
        const execution = this.executions.get(input.completion.executionId);
        if (!execution || execution.status !== "SETTLED" || existing.receiptId !== input.receipt.receiptId) throw new Error("Receipt idempotency conflict.");
        return { execution: this.clone(execution), receipt: cloneReceipt(existing) };
      }
      const current = this.executions.get(input.completion.executionId);
      if (!current || current.paymentIntentId !== input.receipt.paymentIntentId || current.actorSubject !== input.receipt.actorSubject) throw new Error("Receipt ownership mismatch.");
      const execution = this.completeUnsafe(input.completion);
      this.receipts.set(input.receipt.paymentIntentId, cloneReceipt(input.receipt));
      this.appendEvent(execution.executionId, "receipt_created", "SETTLED", "SETTLED", input.receipt.createdAt);
      return { execution, receipt: cloneReceipt(input.receipt) };
    });
  }

  async listAttempts(id: string) { return (this.attempts.get(id) ?? []).map((x) => Object.freeze({ ...x, evidence: x.evidence ? cloneJson(x.evidence) : undefined })); }
  async listEvents(id: string) { return (this.events.get(id) ?? []).map((x) => Object.freeze({ ...x, details: cloneJson(x.details) })); }

  private completeUnsafe(input: CompleteOperationInput): PaymentExecution {
    const current = this.executions.get(input.executionId);
    if (!current) throw new Error("Execution not found.");
    if (current.version !== input.expectedVersion || current.leaseOwner !== input.leaseOwner) throw new Error("Execution version or lease conflict.");
    assertExecutionTransition(current.status, input.toStatus);
    if (current.providerReference && input.providerReference && current.providerReference !== input.providerReference) throw new Error("Provider reference is immutable.");
    const updated = Object.freeze({ ...current, status: input.toStatus, version: current.version + 1n,
      providerReference: input.providerReference ?? current.providerReference, reconciliationReference: input.reconciliationReference ?? current.reconciliationReference,
      submittedAt: input.submittedAt ?? current.submittedAt, settledAt: input.settledAt ?? current.settledAt,
      failedAt: input.failedAt ?? current.failedAt, failureCode: input.failureCode ?? current.failureCode,
      failureCategory: input.failureCategory ?? current.failureCategory, failureRetryable: input.failureRetryable ?? current.failureRetryable,
      reviewReason: input.reviewReason ?? current.reviewReason, settlementEvidence: input.evidence ? cloneJson(input.evidence) : current.settlementEvidence,
      nextAttemptAt: input.nextAttemptAt, observationSequence: input.observationSequence ?? current.observationSequence,
      lastReconciledAt: input.operation === "RECONCILE" ? input.completedAt : current.lastReconciledAt,
      leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: input.completedAt });
    this.executions.set(current.executionId, updated);
    const list = this.attempts.get(current.executionId) ?? [];
    list.push(Object.freeze({ attemptId: input.attemptId, executionId: current.executionId, attemptNumber: current.attemptCount,
      operation: input.operation, startedAt: current.updatedAt, completedAt: input.completedAt, outcome: input.toStatus,
      failureCode: input.failureCode, sideEffect: input.sideEffect, recoveryAction: input.recoveryAction,
      evidence: input.evidence ? cloneJson(input.evidence) : undefined }));
    this.attempts.set(current.executionId, list);
    this.appendEvent(current.executionId, eventType(input), current.status, input.toStatus, input.completedAt);
    return this.clone(updated);
  }

  private appendEvent(executionId: string, type: string, fromStatus: ExecutionStatus | undefined, toStatus: ExecutionStatus, occurredAt: string) {
    const list = this.events.get(executionId) ?? [];
    if (["execution_created", "execution_settled", "receipt_created"].includes(type) && list.some((event) => event.eventType === type)) return;
    list.push(Object.freeze({ id: this.nextEventId++, executionId, sequenceNumber: list.length + 1, eventType: type,
      fromStatus, toStatus, details: Object.freeze({}), occurredAt }));
    this.events.set(executionId, list);
  }
  private clone(value: PaymentExecution) { return Object.freeze({ ...value, settlementEvidence: value.settlementEvidence ? cloneJson(value.settlementEvidence) : undefined }); }
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> { const run = this.queue.then(fn, fn); this.queue = run.then(() => undefined, () => undefined); return run; }
}

function eventType(input: CompleteOperationInput): string {
  if (input.toStatus === "SETTLED") return "execution_settled";
  if (input.operation === "SUBMIT") return input.toStatus === "PROCESSING" ? "submission_accepted" : input.toStatus === "UNKNOWN" ? "submission_unknown" : "submission_failed";
  return input.toStatus === "PROCESSING" ? "reconciliation_pending" : input.toStatus === "UNKNOWN" ? "submission_unknown" : "reconciliation_failed";
}
function cloneJson(value: JsonObject): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function cloneReceipt(value: ExecutionReceipt): ExecutionReceipt { return Object.freeze({ ...value, recipientSnapshot: value.recipientSnapshot ? Object.freeze({ ...value.recipientSnapshot }) : undefined, evidence: cloneJson(value.evidence) }); }
