import type { Pool, QueryResultRow } from "pg";

import type { GrowthEventRepository } from "./growthRepository";

export type PaymentSettlementGrowthProjectionResult = Readonly<{
  paymentIntentId: string;
  receiptId: string;
  senderCreated: boolean;
  recipientCreated: boolean;
  synthetic: boolean;
}>;

export class PaymentSettlementGrowthProjector {
  constructor(
    private readonly pool: Pool,
    private readonly growth: GrowthEventRepository,
  ) {}

  async projectPayment(
    paymentIntentId: string,
  ): Promise<PaymentSettlementGrowthProjectionResult | undefined> {
    const result = await this.pool.query(
      `SELECT
         r.receipt_id,
         r.payment_intent_id,
         r.execution_id,
         r.asset,
         r.amount_units,
         r.amount_decimals,
         r.rail,
         r.settled_at,

         sender.account_id AS sender_account_id,

         p.recipient_account_id,
         p.recipient_synthetic_id,

         EXISTS (
           SELECT 1
           FROM synthetic_test_actors synthetic_sender
           WHERE synthetic_sender.account_id = sender.account_id
         ) AS sender_is_synthetic_test,

         EXISTS (
           SELECT 1
           FROM synthetic_test_actors synthetic_recipient
           WHERE synthetic_recipient.account_id = p.recipient_account_id
         ) AS recipient_is_synthetic_test

       FROM payment_execution_receipts r

       JOIN payment_executions e
         ON e.execution_id = r.execution_id
        AND e.payment_intent_id = r.payment_intent_id
        AND e.status = 'SETTLED'

       JOIN payments p
         ON p.id = r.payment_intent_id

       JOIN accounts sender
         ON sender.actor_subject = r.actor_subject

       WHERE r.payment_intent_id = $1`,
      [paymentIntentId],
    );

    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    return this.projectRow(row);
  }

  async projectPending(
    limit = 100,
  ): Promise<PaymentSettlementGrowthProjectionResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Growth projection limit must be between 1 and 500.");
    }

    const result = await this.pool.query(
      `SELECT
         r.receipt_id,
         r.payment_intent_id,
         r.execution_id,
         r.asset,
         r.amount_units,
         r.amount_decimals,
         r.rail,
         r.settled_at,

         sender.account_id AS sender_account_id,

         p.recipient_account_id,
         p.recipient_synthetic_id,

         EXISTS (
           SELECT 1
           FROM synthetic_test_actors synthetic_sender
           WHERE synthetic_sender.account_id = sender.account_id
         ) AS sender_is_synthetic_test,

         EXISTS (
           SELECT 1
           FROM synthetic_test_actors synthetic_recipient
           WHERE synthetic_recipient.account_id = p.recipient_account_id
         ) AS recipient_is_synthetic_test

       FROM payment_execution_receipts r

       JOIN payment_executions e
         ON e.execution_id = r.execution_id
        AND e.payment_intent_id = r.payment_intent_id
        AND e.status = 'SETTLED'

       JOIN payments p
         ON p.id = r.payment_intent_id

       JOIN accounts sender
         ON sender.actor_subject = r.actor_subject

       WHERE NOT EXISTS (
         SELECT 1
         FROM growth_events g
         WHERE g.source_domain = 'PAYMENT'
           AND g.source_id = r.payment_intent_id::text
           AND g.source_event_id = r.receipt_id
           AND g.event_type = 'PAYMENT_SETTLED_SENT'
           AND g.actor_account_id = sender.account_id
       )

       ORDER BY r.settled_at, r.receipt_id
       LIMIT $1`,
      [limit],
    );

    const projected: PaymentSettlementGrowthProjectionResult[] = [];

    for (const row of result.rows) {
      projected.push(await this.projectRow(row));
    }

    return projected;
  }

  private async projectRow(
    row: QueryResultRow,
  ): Promise<PaymentSettlementGrowthProjectionResult> {
    const paymentIntentId = String(row.payment_intent_id);
    const receiptId = String(row.receipt_id);
    const senderAccountId = String(row.sender_account_id);

    const recipientAccountId =
      row.recipient_account_id === null
        ? undefined
        : String(row.recipient_account_id);

    const synthetic =
      Boolean(row.sender_is_synthetic_test) ||
      row.recipient_synthetic_id !== null ||
      Boolean(row.recipient_is_synthetic_test);

    const context = Object.freeze({
      receiptId,
      executionId: String(row.execution_id),
      asset: String(row.asset),
      amountRaw: String(row.amount_units),
      amountDecimals: Number(row.amount_decimals),
      rail: String(row.rail),
    });

    const sender = await this.growth.append({
      eventType: "PAYMENT_SETTLED_SENT",
      actorAccountId: senderAccountId,
      sourceDomain: "PAYMENT",
      sourceId: paymentIntentId,
      sourceEventId: receiptId,
      occurredAt: new Date(row.settled_at).toISOString(),
      synthetic,
      schemaVersion: 1,
      context,
    });

    let recipientCreated = false;

    if (recipientAccountId) {
      const recipient = await this.growth.append({
        eventType: "PAYMENT_SETTLED_RECEIVED",
        actorAccountId: recipientAccountId,
        sourceDomain: "PAYMENT",
        sourceId: paymentIntentId,
        sourceEventId: receiptId,
        occurredAt: new Date(row.settled_at).toISOString(),
        synthetic,
        schemaVersion: 1,
        context,
      });

      recipientCreated = recipient.created;
    }

    return Object.freeze({
      paymentIntentId,
      receiptId,
      senderCreated: sender.created,
      recipientCreated,
      synthetic,
    });
  }
}
