import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CompleteOperationInput, CreateExecutionInput, ExecutionRepository } from "../../executions/executionRepository";
import type { ExecutionReceipt } from "../../executions/executionReceiptTypes";
import type { ExecutionAttempt, ExecutionStatus, PaymentExecution } from "../../executions/executionTypes";

export class PostgresExecutionRepository implements ExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async createOrGet(input: CreateExecutionInput) { return this.tx(async (client) => {
    const result = await client.query(`INSERT INTO payment_executions(execution_id,payment_intent_id,actor_subject,provider_idempotency_key,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(payment_intent_id) DO NOTHING RETURNING *`,
    [input.executionId,input.paymentIntentId,input.actorSubject,input.providerIdempotencyKey,input.now]);
    if (result.rows[0]) {
      await appendEvent(client,input.executionId,"execution_created",null,"READY",input.now);
      return { execution: mapExecution(result.rows[0]), created: true };
    }
    const existing = await client.query("SELECT * FROM payment_executions WHERE payment_intent_id=$1 FOR UPDATE",[input.paymentIntentId]);
    return { execution: mapExecution(existing.rows[0]), created: false };
  }); }

  async findByPaymentIntent(id: string) { const result = await this.pool.query("SELECT * FROM payment_executions WHERE payment_intent_id=$1",[id]); return result.rows[0] ? mapExecution(result.rows[0]) : undefined; }
  async findReceiptByPaymentIntent(id: string) { const result = await this.pool.query("SELECT * FROM payment_execution_receipts WHERE payment_intent_id=$1",[id]); return result.rows[0] ? mapReceipt(result.rows[0]) : undefined; }

  async claim(statuses: readonly ExecutionStatus[], workerId: string, now: string, leaseExpiresAt: string) { return this.tx(async (client) => {
    const result = await client.query(`SELECT * FROM payment_executions WHERE status=ANY($1::payment_execution_status[])
      AND (next_attempt_at IS NULL OR next_attempt_at<=$2) AND (lease_expires_at IS NULL OR lease_expires_at<=$2)
      ORDER BY created_at,execution_id FOR UPDATE SKIP LOCKED LIMIT 1`,[statuses,now]);
    if (!result.rows[0]) return undefined;
    const current = mapExecution(result.rows[0]);
    const operation = current.status === "READY" ? "SUBMIT" as const : "RECONCILE" as const;
    const status = current.status === "READY" ? "SUBMITTING" : current.status;
    const updated = await client.query(`UPDATE payment_executions SET status=$2,version=version+1,attempt_count=attempt_count+1,
      started_at=COALESCE(started_at,$3),lease_owner=$4,lease_expires_at=$5,updated_at=$3 WHERE execution_id=$1 RETURNING *`,
    [current.executionId,status,now,workerId,leaseExpiresAt]);
    const execution = mapExecution(updated.rows[0]);
    await appendEvent(client,execution.executionId,operation === "SUBMIT" ? "submission_started" : "reconciliation_pending",current.status,status,now);
    return { execution, attempt: { attemptId: randomUUID(), executionId: execution.executionId, attemptNumber: execution.attemptCount, operation, startedAt: now } };
  }); }

  async complete(input: CompleteOperationInput) { return this.tx((client) => this.completeInTransaction(client,input)); }

  async completeSettlement(input: Readonly<{ completion: CompleteOperationInput; receipt: ExecutionReceipt }>) { return this.tx(async (client) => {
    if (input.completion.toStatus !== "SETTLED") throw new Error("Settlement completion must be SETTLED.");
    const existing = await client.query("SELECT * FROM payment_execution_receipts WHERE execution_id=$1 FOR SHARE",[input.completion.executionId]);
    if (existing.rows[0]) {
      const executionResult = await client.query("SELECT * FROM payment_executions WHERE execution_id=$1 FOR SHARE",[input.completion.executionId]);
      const execution = mapExecution(executionResult.rows[0]); const receipt = mapReceipt(existing.rows[0]);
      if (execution.status !== "SETTLED" || receipt.receiptId !== input.receipt.receiptId) throw new Error("Receipt idempotency conflict.");
      return { execution, receipt };
    }
    const execution = await this.completeInTransaction(client,input.completion);
    const receiptResult = await client.query(`INSERT INTO payment_execution_receipts(receipt_id,execution_id,payment_intent_id,actor_subject,
      runtime_transaction_id,rail,asset,amount_units,amount_decimals,sender_id,recipient_id,recipient_snapshot,memo,provider_reference,
      settled_at,evidence_type,evidence_version,evidence,schema_version,request_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,decode($20,'hex'),$21) RETURNING *`,
    [input.receipt.receiptId,input.receipt.executionId,input.receipt.paymentIntentId,input.receipt.actorSubject,input.receipt.runtimeTransactionId,
      input.receipt.rail,input.receipt.asset,input.receipt.amountUnits,input.receipt.amountDecimals ?? 6,input.receipt.senderId,input.receipt.recipientId,
      input.receipt.recipientSnapshot ? JSON.stringify(input.receipt.recipientSnapshot) : null,input.receipt.memo,input.receipt.providerReference ?? null,
      input.receipt.settledAt,input.receipt.evidenceType,input.receipt.evidenceVersion,JSON.stringify(input.receipt.evidence),input.receipt.schemaVersion,
      input.receipt.requestHash,input.receipt.createdAt]);
    await appendEvent(client,execution.executionId,"receipt_created","SETTLED","SETTLED",input.receipt.createdAt);
    return { execution, receipt: mapReceipt(receiptResult.rows[0]) };
  }); }

  async listAttempts(id: string): Promise<ExecutionAttempt[]> { const result = await this.pool.query("SELECT * FROM payment_execution_attempts WHERE execution_id=$1 ORDER BY attempt_number",[id]); return result.rows.map((row) => ({ attemptId:String(row.attempt_id),executionId:String(row.execution_id),attemptNumber:Number(row.attempt_number),operation:row.operation,startedAt:iso(row.started_at)!,completedAt:iso(row.completed_at),outcome:row.outcome??undefined,failureCode:row.failure_code??undefined,sideEffect:row.side_effect??undefined,recoveryAction:row.recovery_action??undefined,evidence:row.evidence??undefined })); }

  private async completeInTransaction(client: PoolClient, input: CompleteOperationInput): Promise<PaymentExecution> {
    const priorResult = await client.query("SELECT status FROM payment_executions WHERE execution_id=$1 FOR UPDATE",[input.executionId]);
    const priorStatus = priorResult.rows[0]?.status as ExecutionStatus | undefined;
    const result = await client.query(`UPDATE payment_executions SET status=$2,version=version+1,provider_reference=COALESCE($3,provider_reference),
      reconciliation_reference=COALESCE($4,reconciliation_reference),submitted_at=COALESCE($5,submitted_at),settled_at=COALESCE($6,settled_at),
      failed_at=COALESCE($7,failed_at),failure_code=COALESCE($8,failure_code),failure_category=COALESCE($9,failure_category),
      failure_retryable=COALESCE($10,failure_retryable),review_reason=COALESCE($11,review_reason),settlement_evidence=COALESCE($12,settlement_evidence),
      next_attempt_at=$13,observation_sequence=COALESCE($14,observation_sequence),last_reconciled_at=CASE WHEN $15='RECONCILE' THEN $16 ELSE last_reconciled_at END,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=$16 WHERE execution_id=$1 AND version=$17 AND lease_owner=$18 RETURNING *`,
    [input.executionId,input.toStatus,input.providerReference??null,input.reconciliationReference??null,input.submittedAt??null,input.settledAt??null,
      input.failedAt??null,input.failureCode??null,input.failureCategory??null,input.failureRetryable??null,input.reviewReason??null,
      input.evidence?JSON.stringify(input.evidence):null,input.nextAttemptAt??null,input.observationSequence??null,input.operation,input.completedAt,
      input.expectedVersion.toString(),input.leaseOwner]);
    if (!result.rows[0]) throw new Error("Execution version or lease conflict.");
    const execution = mapExecution(result.rows[0]);
    await client.query(`INSERT INTO payment_execution_attempts(attempt_id,execution_id,attempt_number,operation,started_at,completed_at,outcome,
      failure_code,side_effect,recovery_action,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.attemptId,input.executionId,execution.attemptCount,input.operation,execution.startedAt??input.completedAt,input.completedAt,input.toStatus,
      input.failureCode??null,input.sideEffect??null,input.recoveryAction??null,input.evidence?JSON.stringify(input.evidence):null]);
    await appendEvent(client,input.executionId,eventType(input),priorStatus??null,input.toStatus,input.completedAt);
    return execution;
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>) { const client=await this.pool.connect(); try { await client.query("BEGIN"); const value=await fn(client); await client.query("COMMIT"); return value; } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
}

async function appendEvent(client: PoolClient, executionId: string, eventTypeValue: string, fromStatus: ExecutionStatus | null, toStatus: ExecutionStatus, occurredAt: string) {
  await client.query(`INSERT INTO payment_execution_events(execution_id,sequence_number,event_type,from_status,to_status,occurred_at)
    SELECT $1,COALESCE(MAX(sequence_number),0)+1,$2,$3,$4,$5 FROM payment_execution_events WHERE execution_id=$1
    ON CONFLICT DO NOTHING`,[executionId,eventTypeValue,fromStatus,toStatus,occurredAt]);
}
function eventType(input: CompleteOperationInput): string { if(input.toStatus==="SETTLED")return "execution_settled"; if(input.operation==="SUBMIT")return input.toStatus==="PROCESSING"?"submission_accepted":input.toStatus==="UNKNOWN"?"submission_unknown":"submission_failed"; return input.toStatus==="PROCESSING"?"reconciliation_pending":input.toStatus==="UNKNOWN"?"submission_unknown":"reconciliation_failed"; }
function iso(value: unknown) { return value ? new Date(String(value)).toISOString() : undefined; }
function mapExecution(row: any): PaymentExecution { return Object.freeze({executionId:String(row.execution_id),paymentIntentId:String(row.payment_intent_id),actorSubject:String(row.actor_subject),status:row.status,version:BigInt(row.version),selectedRail:"mock",runtimeContractVersion:1,adapterVersion:1,providerIdempotencyKey:String(row.provider_idempotency_key),providerReference:row.provider_reference??undefined,reconciliationReference:row.reconciliation_reference??undefined,attemptCount:Number(row.attempt_count),observationSequence:Number(row.observation_sequence),nextAttemptAt:iso(row.next_attempt_at),lastReconciledAt:iso(row.last_reconciled_at),failureCode:row.failure_code??undefined,failureCategory:row.failure_category??undefined,failureRetryable:row.failure_retryable??undefined,reviewReason:row.review_reason??undefined,settlementEvidence:row.settlement_evidence??undefined,createdAt:iso(row.created_at)!,startedAt:iso(row.started_at),submittedAt:iso(row.submitted_at),settledAt:iso(row.settled_at),failedAt:iso(row.failed_at),cancelledAt:iso(row.cancelled_at),updatedAt:iso(row.updated_at)!,leaseOwner:row.lease_owner??undefined,leaseExpiresAt:iso(row.lease_expires_at)}); }
function mapReceipt(row: any): ExecutionReceipt { return Object.freeze({receiptId:String(row.receipt_id),paymentIntentId:String(row.payment_intent_id),executionId:String(row.execution_id),actorSubject:String(row.actor_subject),runtimeTransactionId:String(row.runtime_transaction_id),rail:"mock",asset:"USDC",amountUnits:String(row.amount_units),amountDecimals:Number(row.amount_decimals),senderId:String(row.sender_id),recipientId:String(row.recipient_id),recipientSnapshot:row.recipient_snapshot??undefined,memo:String(row.memo),providerReference:row.provider_reference??undefined,settledAt:iso(row.settled_at)!,evidenceType:String(row.evidence_type),evidenceVersion:Number(row.evidence_version),evidence:row.evidence,schemaVersion:1,requestHash:Buffer.from(row.request_hash).toString("hex"),createdAt:iso(row.created_at)!}); }
