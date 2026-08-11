import type { Pool } from "pg";

export type InvariantViolation = Readonly<{ name: string; count: number }>;
export type InvariantReport = Readonly<{ passed: boolean; checkedAt: string; violations: readonly InvariantViolation[] }>;

const checks = Object.freeze([
  ["duplicate_actor_idempotency", `SELECT count(*)::int n FROM (SELECT actor_subject,idempotency_key FROM payments GROUP BY 1,2 HAVING count(*)<>1) x`],
  ["multiple_executions_per_intent", `SELECT count(*)::int n FROM (SELECT payment_intent_id FROM payment_executions GROUP BY 1 HAVING count(*)>1) x`],
  ["duplicate_execution_ids", `SELECT count(*)::int n FROM (SELECT execution_id FROM payment_executions GROUP BY 1 HAVING count(*)>1) x`],
  ["duplicate_receipt_ids", `SELECT count(*)::int n FROM (SELECT receipt_id FROM payment_execution_receipts GROUP BY 1 HAVING count(*)>1) x`],
  ["settled_without_one_receipt", `SELECT count(*)::int n FROM (SELECT e.execution_id FROM payment_executions e LEFT JOIN payment_execution_receipts r ON r.execution_id=e.execution_id WHERE e.status='SETTLED' GROUP BY e.execution_id HAVING count(r.receipt_id)<>1) x`],
  ["orphan_or_mismatched_receipt", `SELECT count(*)::int n FROM payment_execution_receipts r LEFT JOIN payment_executions e ON e.execution_id=r.execution_id LEFT JOIN payments p ON p.id=r.payment_intent_id WHERE e.execution_id IS NULL OR p.id IS NULL OR e.payment_intent_id<>r.payment_intent_id OR e.actor_subject<>r.actor_subject OR p.actor_subject<>r.actor_subject OR p.amount_raw::numeric<>r.amount_units OR p.request_hash<>r.request_hash OR r.execution_id::text<>r.runtime_transaction_id`],
  ["terminal_execution_with_lease", `SELECT count(*)::int n FROM payment_executions WHERE status IN ('SETTLED','FAILED','CANCELLED') AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)`],
  ["duplicate_settlement_effect", `SELECT count(*)::int n FROM (SELECT execution_id FROM payment_execution_events WHERE event_type='execution_settled' GROUP BY 1 HAVING count(*)>1) x`],
  ["duplicate_receipt_effect", `SELECT count(*)::int n FROM (SELECT execution_id FROM payment_execution_events WHERE event_type='receipt_created' GROUP BY 1 HAVING count(*)>1) x`],
] as const);

export async function verifyEconomicInvariants(pool: Pick<Pool,"query">, options: Readonly<{expectedUnresolved?:number;expectedPaymentCount?:number;crossAccountReadsDenied?:boolean;expectedPayments?:readonly Readonly<{actorSubject:string;idempotencyKey:string}>[];expectedSettledIntentIds?:readonly string[]}> = {}): Promise<InvariantReport> {
  const violations: InvariantViolation[]=[];
  for (const [name,sql] of checks) {
    const result=await pool.query(sql); const count=Number(result.rows[0]?.n??0);
    if(count!==0)violations.push(Object.freeze({name,count}));
  }
  const unresolved=Number((await pool.query(`SELECT count(*)::int n FROM payment_executions WHERE status NOT IN ('SETTLED','FAILED','CANCELLED')`)).rows[0]?.n??0);
  if(unresolved!==(options.expectedUnresolved??0))violations.push(Object.freeze({name:"unexpected_unresolved_executions",count:unresolved}));
  if(options.expectedPaymentCount!==undefined){const count=Number((await pool.query("SELECT count(*)::int n FROM payments")).rows[0]?.n??0);if(count!==options.expectedPaymentCount)violations.push(Object.freeze({name:"expected_total_payment_count",count}));}
  for(const expected of options.expectedPayments??[]){const count=Number((await pool.query("SELECT count(*)::int n FROM payments WHERE actor_subject=$1 AND idempotency_key=$2",[expected.actorSubject,expected.idempotencyKey])).rows[0]?.n??0);if(count!==1)violations.push(Object.freeze({name:"expected_payment_record_count",count}));}
  for(const intentId of options.expectedSettledIntentIds??[]){const result=await pool.query(`SELECT count(DISTINCT e.execution_id)::int executions,count(DISTINCT r.receipt_id)::int receipts,count(*) FILTER (WHERE ev.event_type='execution_settled')::int settlements,count(*) FILTER (WHERE ev.event_type='receipt_created')::int receipt_effects FROM payment_executions e LEFT JOIN payment_execution_receipts r ON r.execution_id=e.execution_id LEFT JOIN payment_execution_events ev ON ev.execution_id=e.execution_id WHERE e.payment_intent_id=$1 AND e.status='SETTLED'`,[intentId]);const row=result.rows[0]??{};for(const [name,value] of [["expected_settled_execution_count",row.executions],["expected_receipt_count",row.receipts],["expected_settlement_effect_count",row.settlements],["expected_receipt_effect_count",row.receipt_effects]] as const){const count=Number(value??0);if(count!==1)violations.push(Object.freeze({name,count}));}}
  if(options.crossAccountReadsDenied===false)violations.push(Object.freeze({name:"cross_account_read_exposed",count:1}));
  return Object.freeze({passed:violations.length===0,checkedAt:new Date().toISOString(),violations:Object.freeze(violations)});
}
