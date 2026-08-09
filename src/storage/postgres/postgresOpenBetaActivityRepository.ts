import type { Pool } from "pg";

import {
  type OpenBetaActivityAggregate,
  type OpenBetaActivityRepository,
  type OPEN_BETA_EPOCH,
} from "../../telemetry/openBetaActivity";

export class PostgresOpenBetaActivityRepository implements OpenBetaActivityRepository {
  constructor(private readonly pool: Pool) {}

  async aggregate(epochName: typeof OPEN_BETA_EPOCH): Promise<OpenBetaActivityAggregate> {
    const result = await this.pool.query(`
      WITH epoch AS (
        SELECT starts_at FROM telemetry_epochs WHERE epoch_name = $1
      ), eligible_executions AS (
        SELECT e.execution_id, e.payment_intent_id, e.actor_subject, e.status
        FROM payment_executions e
        CROSS JOIN epoch
        WHERE e.selected_rail = 'mock' AND e.created_at >= epoch.starts_at
      ), eligible_receipts AS (
        SELECT r.receipt_id, r.payment_intent_id, r.actor_subject, r.amount_units, r.amount_decimals
        FROM payment_execution_receipts r
        JOIN eligible_executions e
          ON e.execution_id = r.execution_id
         AND e.payment_intent_id = r.payment_intent_id
         AND e.actor_subject = r.actor_subject
         AND e.status = 'SETTLED'
        JOIN accounts a ON a.actor_subject = r.actor_subject
        WHERE r.rail = 'mock' AND r.asset = 'USDC'
      )
      SELECT
        (SELECT starts_at FROM epoch) AS epoch_starts_at,
        (SELECT count(*) FROM eligible_executions) AS executions_initiated,
        (SELECT count(*) FROM eligible_executions WHERE status = 'SETTLED') AS executions_settled,
        (SELECT count(DISTINCT payment_intent_id) FROM eligible_receipts) AS payments_completed,
        (SELECT count(*) FROM eligible_receipts) AS durable_receipts,
        (SELECT count(DISTINCT actor_subject) FROM eligible_receipts) AS beta_testers,
        (SELECT COALESCE(sum(amount_units), 0) FROM eligible_receipts) AS mock_usdc_amount_raw,
        (SELECT min(amount_decimals) FROM eligible_receipts) AS minimum_decimals,
        (SELECT max(amount_decimals) FROM eligible_receipts) AS maximum_decimals
    `, [epochName]);
    const row = result.rows[0];
    if (!row?.epoch_starts_at) throw new Error("OPEN_BETA telemetry epoch is unavailable.");
    if ((row.minimum_decimals !== null && Number(row.minimum_decimals) !== 6) ||
        (row.maximum_decimals !== null && Number(row.maximum_decimals) !== 6)) {
      throw new Error("OPEN_BETA Mock USDC receipt decimals are inconsistent.");
    }
    return Object.freeze({
      betaTesters: count(row.beta_testers, "betaTesters"),
      paymentsCompleted: count(row.payments_completed, "paymentsCompleted"),
      mockUsdcAmountRaw: integer(row.mock_usdc_amount_raw, "mockUsdcAmountRaw"),
      durableReceipts: count(row.durable_receipts, "durableReceipts"),
      executionsInitiated: count(row.executions_initiated, "executionsInitiated"),
      executionsSettled: count(row.executions_settled, "executionsSettled"),
    });
  }
}

function count(value: unknown, name: string): number {
  const parsed = Number(integer(value, name));
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe public aggregate range.`);
  return parsed;
}

function integer(value: unknown, name: string): string {
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} is not an unsigned integer.`);
  return normalized;
}
