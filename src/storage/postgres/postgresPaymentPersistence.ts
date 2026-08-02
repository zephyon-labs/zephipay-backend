import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { AllowlistEntry, CreateAllowlistEntryInput } from "../../allowlist/allowlistEntry";
import {
  eventTypeForTransition,
  normalizeTransitionEvidence,
  validatePaymentTransition,
  validateReceiptCompletionTransition,
} from "../../payments/paymentLifecycle";
import { validateRequestHash } from "../../payments/requestHash";
import type {
  JsonObject,
  PaymentEvent,
  PaymentEventType,
  PaymentLifecycleEvidence,
  PaymentRecord,
  PaymentStatus,
} from "../../payments/paymentTypes";
import type { PaymentReceipt } from "../../receipts/paymentReceipt";
import {
  cloneJsonObject,
  cloneJsonValue,
  cloneTerminalProof,
  terminalProofToJson,
} from "../jsonValues";
import type { AppendInformationalPaymentEventInput, IdempotencyClaim, PaymentPersistence } from "../storageContracts";
import { PaymentVersionConflictError } from "../storageContracts";

type DatabaseExecutor = Pick<Pool | PoolClient, "query">;

export class PostgresPaymentPersistence implements PaymentPersistence {
  constructor(private readonly pool: Pool) {}

  async createAllowlistEntry(input: CreateAllowlistEntryInput): Promise<AllowlistEntry> {
    const result = await this.pool.query(
      `INSERT INTO beta_allowlist (actor_subject, enabled, expires_at, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.actorSubject, input.enabled ?? true, input.expiresAt ?? null, input.note ?? null],
    );
    return mapAllowlist(result.rows[0]);
  }

  async findAllowlistEntry(actorSubject: string): Promise<AllowlistEntry | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM beta_allowlist WHERE actor_subject = $1",
      [actorSubject],
    );
    return result.rows[0] ? mapAllowlist(result.rows[0]) : undefined;
  }

  async claimIdempotencyKey(input: Parameters<PaymentPersistence["claimIdempotencyKey"]>[0]): Promise<IdempotencyClaim> {
    validateRequestHash(input.requestHash);
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO payments
           (id, actor_subject, idempotency_key, request_hash, network, rail,
            asset, mint_address, recipient_address, amount_raw, purpose)
         VALUES ($1,$2,$3,decode($4,'hex'),$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (actor_subject, idempotency_key) DO NOTHING
         RETURNING *`,
        [input.id, input.actorSubject, input.idempotencyKey, input.requestHash,
          input.network, input.rail, input.asset, input.mintAddress,
          input.recipientAddress, input.amountRaw.toString(), input.purpose],
      );
      if (inserted.rows[0]) {
        await appendEvent(client, {
          paymentId: input.id,
          eventType: "CREATED",
          toStatus: "AWAITING_CONFIRMATION",
        });
        return { outcome: "CLAIMED", payment: mapPayment(inserted.rows[0]) };
      }
      const existingResult = await client.query(
        `SELECT * FROM payments
         WHERE actor_subject=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.actorSubject, input.idempotencyKey],
      );
      const payment = mapPayment(existingResult.rows[0]);
      return {
        outcome: payment.requestHash === input.requestHash ? "EXISTING" : "HASH_CONFLICT",
        payment,
      };
    });
  }

  async findPayment(paymentId: string): Promise<PaymentRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM payments WHERE id=$1", [paymentId]);
    return result.rows[0] ? mapPayment(result.rows[0]) : undefined;
  }

  async listPaymentsRequiringReconciliation(limit: number): Promise<PaymentRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Limit must be positive.");
    const result = await this.pool.query(
      `SELECT * FROM payments WHERE status IN ('PROCESSING','UNKNOWN')
       ORDER BY COALESCE(last_checked_at, execution_started_at, created_at), id LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapPayment);
  }

  async transitionPayment(input: Parameters<PaymentPersistence["transitionPayment"]>[0]): Promise<PaymentRecord> {
    return this.transaction(async (client) => {
      const current = await lockPayment(client, input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      validatePaymentTransition(current.status, input.toStatus, input.evidence);
      const evidence = normalizeTransitionEvidence(input.toStatus, input.evidence);
      const updated = await updatePayment(client, current, input.toStatus, evidence);
      const eventType = eventTypeForTransition(current.status, input.toStatus);
      const details = input.toStatus === "FAILED"
        ? cloneJsonObject({
            ...(input.details ?? {}),
            terminalProof: terminalProofToJson(input.evidence.terminalProof),
          })
        : cloneJsonObject(input.details ?? {});
      await appendEvent(client, {
        paymentId: input.paymentId,
        eventType,
        fromStatus: current.status,
        toStatus: input.toStatus,
        requestId: input.requestId,
        details,
        occurredAt: input.occurredAt,
      });
      return updated;
    });
  }

  recordSignatureObservation(input: Parameters<PaymentPersistence["recordSignatureObservation"]>[0]): Promise<PaymentRecord> {
    return this.transaction(async (client) => {
      const current = await lockPayment(client, input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (current.status !== "PROCESSING" && current.status !== "UNKNOWN") {
        throw new Error("A signature may be observed only for PROCESSING or UNKNOWN payments.");
      }
      if (current.solanaSignature && current.solanaSignature !== input.solanaSignature) {
        throw new Error("An observed Solana signature cannot be replaced.");
      }
      const updated = await updatePayment(client, current, current.status, {
        solanaSignature: input.solanaSignature,
        submittedAt: input.submittedAt,
        submittedSlot: input.submittedSlot,
        recentBlockhash: input.recentBlockhash,
      });
      await appendEvent(client, {
        paymentId: input.paymentId,
        eventType: "SIGNATURE_OBSERVED",
        requestId: input.requestId,
        details: cloneJsonObject(input.details ?? {}),
        occurredAt: input.occurredAt,
      });
      return updated;
    });
  }

  recordSettlementCheck(input: Parameters<PaymentPersistence["recordSettlementCheck"]>[0]): Promise<PaymentRecord> {
    return this.transaction(async (client) => {
      const current = await lockPayment(client, input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (current.status !== "PROCESSING" && current.status !== "UNKNOWN") {
        throw new Error("Settlement checks apply only to PROCESSING or UNKNOWN payments.");
      }
      return updatePayment(client, current, current.status, {
        lastCheckedAt: input.lastCheckedAt,
      });
    });
  }

  recordSettlementConfirmation(input: Parameters<PaymentPersistence["recordSettlementConfirmation"]>[0]): Promise<PaymentRecord> {
    return this.transaction(async (client) => {
      const current = await lockPayment(client, input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (current.status !== "PROCESSING" && current.status !== "UNKNOWN") {
        throw new Error("Settlement confirmation applies only to PROCESSING or UNKNOWN payments.");
      }
      if (input.confirmedSlot < 0n) throw new Error("Confirmed slot cannot be negative.");
      if (current.solanaSignature && current.solanaSignature !== input.solanaSignature) {
        throw new Error("Settlement signature does not match the observed signature.");
      }
      const updated = await updatePayment(client, current, current.status, {
        solanaSignature: input.solanaSignature,
        confirmedSlot: input.confirmedSlot,
        confirmationStatus: "confirmed",
        lastCheckedAt: input.confirmedAt,
      });
      await appendEvent(client, {
        paymentId: input.paymentId,
        eventType: "SETTLEMENT_CONFIRMED",
        fromStatus: current.status,
        toStatus: current.status,
        requestId: input.requestId,
        details: cloneJsonObject({
          ...(input.details ?? {}),
          signature: input.solanaSignature,
          confirmedSlot: input.confirmedSlot.toString(),
        }),
        occurredAt: input.occurredAt,
      });
      return updated;
    });
  }

  appendInformationalEvent(input: AppendInformationalPaymentEventInput): Promise<PaymentEvent> {
    return this.transaction(async (client) => {
      const runtimeEventType: string = input.eventType;
      if (["SETTLEMENT_CONFIRMED", "SETTLEMENT_FAILED", "RECEIPT_VERIFIED"].includes(runtimeEventType)) {
        throw new Error(`${runtimeEventType} is reserved for authoritative lifecycle persistence.`);
      }
      await lockPayment(client, input.paymentId);
      return appendEvent(client, {
        ...input,
        details: cloneJsonObject(input.details ?? {}),
      });
    });
  }

  async listPaymentEvents(paymentId: string): Promise<PaymentEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM payment_events WHERE payment_id=$1 ORDER BY sequence_number",
      [paymentId],
    );
    return result.rows.map(mapEvent);
  }

  async findReceiptByPaymentId(paymentId: string): Promise<PaymentReceipt | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM payment_receipts WHERE payment_id=$1",
      [paymentId],
    );
    return result.rows[0] ? mapReceipt(result.rows[0]) : undefined;
  }

  async storeVerifiedReceipt(input: Parameters<PaymentPersistence["storeVerifiedReceipt"]>[0]): Promise<Readonly<{ payment: PaymentRecord; receipt: PaymentReceipt }>> {
    return this.transaction(async (client) => {
      const current = await lockPayment(client, input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      validateReceiptMatch(current, input.receipt);
      const evidence: PaymentLifecycleEvidence = {
        solanaSignature: input.receipt.solanaSignature,
        confirmedSlot: input.receipt.slot,
        receiptPda: input.receipt.receiptPda,
        completedAt: input.receipt.verifiedAt,
        confirmationStatus: "confirmed",
      };
      validateReceiptCompletionTransition(current.status, evidence);
      const receiptResult = await client.query(
        `INSERT INTO payment_receipts
           (id,payment_id,network,program_id,receipt_pda,solana_signature,slot,
            mint_address,recipient_address,amount_raw,onchain_reference,
            raw_receipt,verified_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,decode($11,'hex'),$12,$13,$14)
         RETURNING *`,
        [input.receipt.id, input.paymentId, input.receipt.network,
          input.receipt.programId, input.receipt.receiptPda,
          input.receipt.solanaSignature, input.receipt.slot.toString(),
          input.receipt.mintAddress, input.receipt.recipientAddress,
          input.receipt.amountRaw.toString(), input.receipt.onchainReference,
          JSON.stringify(cloneJsonObject(input.receipt.rawReceipt)), input.receipt.verifiedAt,
          input.receipt.createdAt ?? input.receipt.verifiedAt],
      );
      const payment = await updatePayment(client, current, "COMPLETED", evidence);
      await appendEvent(client, {
        ...input.event,
        paymentId: input.paymentId,
        eventType: "RECEIPT_VERIFIED",
        fromStatus: current.status,
        toStatus: "COMPLETED",
        details: cloneJsonObject(input.event.details ?? {}),
      });
      return { payment, receipt: mapReceipt(receiptResult.rows[0]) };
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockPayment(client: PoolClient, paymentId: string): Promise<PaymentRecord> {
  const result = await client.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [paymentId]);
  if (!result.rows[0]) throw new Error(`Payment ${paymentId} was not found.`);
  return mapPayment(result.rows[0]);
}

async function updatePayment(executor: DatabaseExecutor, current: PaymentRecord, status: PaymentStatus, evidence: PaymentLifecycleEvidence): Promise<PaymentRecord> {
  const result = await executor.query(
    `UPDATE payments SET status=$2, version=version+1, updated_at=now(),
       runtime_id=COALESCE($3,runtime_id), runtime_payment_id=COALESCE($4,runtime_payment_id),
       runtime_transaction_id=COALESCE($5,runtime_transaction_id),
       user_confirmed_at=COALESCE($6,user_confirmed_at), execution_started_at=COALESCE($7,execution_started_at),
       submitted_at=COALESCE($8,submitted_at), last_checked_at=COALESCE($9,last_checked_at),
       completed_at=COALESCE($10,completed_at), failed_at=COALESCE($11,failed_at),
       solana_signature=COALESCE($12,solana_signature), recent_blockhash=COALESCE($13,recent_blockhash),
       submitted_slot=COALESCE($14,submitted_slot), confirmed_slot=COALESCE($15,confirmed_slot),
       confirmation_status=COALESCE($16,confirmation_status), chain_error=COALESCE($17,chain_error),
       receipt_pda=COALESCE($18,receipt_pda), failure_code=COALESCE($19,failure_code),
       failure_reason=COALESCE($20,failure_reason),
       terminal_proof_kind=COALESCE($21,terminal_proof_kind),
       terminal_proof=COALESCE($22,terminal_proof)
     WHERE id=$1 AND version=$23 RETURNING *`,
    [current.id, status, evidence.runtimeId ?? null, evidence.runtimePaymentId ?? null,
      evidence.runtimeTransactionId ?? null, evidence.userConfirmedAt ?? null,
      evidence.executionStartedAt ?? null, evidence.submittedAt ?? null,
      evidence.lastCheckedAt ?? null, evidence.completedAt ?? null,
      evidence.failedAt ?? null, evidence.solanaSignature ?? null,
      evidence.recentBlockhash ?? null, evidence.submittedSlot?.toString() ?? null,
      evidence.confirmedSlot?.toString() ?? null, evidence.confirmationStatus ?? null,
      evidence.chainError === undefined ? null : JSON.stringify(cloneJsonValue(evidence.chainError)),
      evidence.receiptPda ?? null, evidence.failureCode ?? null,
      evidence.failureReason ?? null, evidence.terminalProof?.kind ?? null,
      evidence.terminalProof ? JSON.stringify(terminalProofToJson(evidence.terminalProof)) : null,
      current.version.toString()],
  );
  if (!result.rows[0]) throw new PaymentVersionConflictError(current.id);
  return mapPayment(result.rows[0]);
}

type InternalPaymentEventInput = Readonly<{
  paymentId: string;
  eventType: PaymentEventType;
  fromStatus?: PaymentStatus;
  toStatus?: PaymentStatus;
  runtimeEventId?: string;
  requestId?: string;
  details?: JsonObject;
  occurredAt?: string;
}>;

async function appendEvent(executor: DatabaseExecutor, input: InternalPaymentEventInput): Promise<PaymentEvent> {
  const result = await executor.query(
    `INSERT INTO payment_events
       (payment_id,sequence_number,event_type,from_status,to_status,
        runtime_event_id,request_id,details,occurred_at)
     SELECT $1,COALESCE(MAX(sequence_number),0)+1,$2,$3,$4,$5,$6,$7,
            COALESCE($8::timestamptz,now())
     FROM payment_events WHERE payment_id=$1 RETURNING *`,
    [input.paymentId, input.eventType, input.fromStatus ?? null,
      input.toStatus ?? null, input.runtimeEventId ?? null,
      input.requestId ?? null, JSON.stringify(input.details ?? {}),
      input.occurredAt ?? null],
  );
  return mapEvent(result.rows[0]);
}

function validateReceiptMatch(payment: PaymentRecord, receipt: Parameters<PaymentPersistence["storeVerifiedReceipt"]>[0]["receipt"]): void {
  if (receipt.paymentId !== payment.id || receipt.network !== payment.network ||
      receipt.mintAddress !== payment.mintAddress || receipt.recipientAddress !== payment.recipientAddress ||
      receipt.amountRaw !== payment.amountRaw) {
    throw new Error("Receipt settlement evidence does not match the payment.");
  }
  if (payment.solanaSignature && payment.solanaSignature !== receipt.solanaSignature) {
    throw new Error("Receipt signature does not match the observed payment signature.");
  }
  if (payment.receiptPda && payment.receiptPda !== receipt.receiptPda) {
    throw new Error("Receipt PDA does not match the observed payment receipt PDA.");
  }
  validateRequestHash(receipt.onchainReference);
}

function optionalString(value: unknown): string | undefined { return value == null ? undefined : String(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalIso(value: unknown): string | undefined { return value == null ? undefined : iso(value); }
function optionalBigint(value: unknown): bigint | undefined { return value == null ? undefined : BigInt(String(value)); }

function mapAllowlist(row: QueryResultRow): AllowlistEntry {
  return { actorSubject: String(row.actor_subject), enabled: Boolean(row.enabled), addedAt: iso(row.added_at), expiresAt: optionalIso(row.expires_at), revokedAt: optionalIso(row.revoked_at), note: optionalString(row.note) };
}

function mapPayment(row: QueryResultRow): PaymentRecord {
  return {
    id: String(row.id), actorSubject: String(row.actor_subject), idempotencyKey: String(row.idempotency_key),
    requestHash: Buffer.from(row.request_hash).toString("hex"), status: row.status,
    version: BigInt(String(row.version)), network: row.network, rail: row.rail, asset: row.asset,
    mintAddress: String(row.mint_address), recipientAddress: String(row.recipient_address), amountRaw: BigInt(String(row.amount_raw)),
    purpose: String(row.purpose), runtimeId: optionalString(row.runtime_id), runtimePaymentId: optionalString(row.runtime_payment_id),
    runtimeTransactionId: optionalString(row.runtime_transaction_id), userConfirmedAt: optionalIso(row.user_confirmed_at),
    executionStartedAt: optionalIso(row.execution_started_at), submittedAt: optionalIso(row.submitted_at),
    lastCheckedAt: optionalIso(row.last_checked_at), completedAt: optionalIso(row.completed_at), failedAt: optionalIso(row.failed_at),
    solanaSignature: optionalString(row.solana_signature), recentBlockhash: optionalString(row.recent_blockhash),
    submittedSlot: optionalBigint(row.submitted_slot), confirmedSlot: optionalBigint(row.confirmed_slot),
    confirmationStatus: optionalString(row.confirmation_status),
    chainError: row.chain_error === undefined || row.chain_error === null
      ? undefined
      : cloneJsonValue(row.chain_error),
    receiptPda: optionalString(row.receipt_pda), failureCode: optionalString(row.failure_code),
    failureReason: optionalString(row.failure_reason), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    terminalProof: row.terminal_proof
      ? cloneTerminalProof(row.terminal_proof)
      : undefined,
  };
}

function mapEvent(row: QueryResultRow): PaymentEvent {
  return { id: BigInt(String(row.id)), paymentId: String(row.payment_id), sequenceNumber: Number(row.sequence_number),
    eventType: row.event_type, fromStatus: row.from_status ?? undefined, toStatus: row.to_status ?? undefined,
    runtimeEventId: optionalString(row.runtime_event_id), requestId: optionalString(row.request_id),
    details: cloneJsonObject(row.details ?? {}), occurredAt: iso(row.occurred_at) };
}

function mapReceipt(row: QueryResultRow): PaymentReceipt {
  return { id: String(row.id), paymentId: String(row.payment_id), network: row.network, programId: String(row.program_id),
    receiptPda: String(row.receipt_pda), solanaSignature: String(row.solana_signature), slot: BigInt(String(row.slot)),
    mintAddress: String(row.mint_address), recipientAddress: String(row.recipient_address), amountRaw: BigInt(String(row.amount_raw)),
    onchainReference: Buffer.from(row.onchain_reference).toString("hex"), rawReceipt: cloneJsonObject(row.raw_receipt),
    verifiedAt: iso(row.verified_at), createdAt: iso(row.created_at) };
}
