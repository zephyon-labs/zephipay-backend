import type { Pool } from "pg";
import type { ActivityFact, ActivityRepository } from "../../executions/activityRepository";
import type { PaymentIdentitySnapshot } from "../../payments/paymentTypes";
import { runWithReliabilityContext } from "../../observability/reliabilityObservability";

export class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly pool: Pool) {}

  async listByActor(actorSubject: string, limit: number): Promise<ActivityFact[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Activity limit is invalid.");
    return runWithReliabilityContext({dbOperation:"ACTIVITY_READ"},async()=>{
      const result = await this.pool.query(`WITH activity_payments AS (
        SELECT id,actor_subject,user_confirmed_at,recipient_snapshot,amount_raw,asset,purpose,created_at
        FROM payments
        WHERE actor_subject=$1
        ORDER BY created_at DESC,id DESC
        LIMIT $2
      )
      SELECT p.id AS payment_intent_id,p.user_confirmed_at,p.recipient_snapshot,p.amount_raw,p.asset,p.purpose,p.created_at,
             e.execution_id,e.status AS execution_status,e.settled_at,r.receipt_id
      FROM activity_payments p
      LEFT JOIN payment_executions e
        ON e.payment_intent_id=p.id AND e.actor_subject=p.actor_subject
      LEFT JOIN payment_execution_receipts r
        ON r.execution_id=e.execution_id AND r.payment_intent_id=p.id AND r.actor_subject=p.actor_subject
      ORDER BY p.created_at DESC,p.id DESC`,[actorSubject,limit]);
      return result.rows.map(mapActivityFact);
    });
  }
}

function mapActivityFact(row: any): ActivityFact {
  return Object.freeze({
    paymentIntentId:String(row.payment_intent_id),
    userConfirmedAt:iso(row.user_confirmed_at),
    recipientSnapshot:row.recipient_snapshot ? Object.freeze({...row.recipient_snapshot}) as PaymentIdentitySnapshot : undefined,
    amountUnits:String(row.amount_raw),asset:"USDC",memo:row.purpose===null?null:String(row.purpose),createdAt:iso(row.created_at)!,
    executionId:row.execution_id===null?undefined:String(row.execution_id),executionStatus:row.execution_status??undefined,
    settledAt:iso(row.settled_at),receiptId:row.receipt_id===null?undefined:String(row.receipt_id),
  });
}
function iso(value: unknown) { return value ? new Date(String(value)).toISOString() : undefined; }
