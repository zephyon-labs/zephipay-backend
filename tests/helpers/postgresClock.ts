import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";

// The fixture host has exhibited a 772 ms backward clock correction. This is
// test scheduling headroom, not a change to any product expiry or clock guard.
const safetyMarginMs = 1500;
const waitLimitMs = 20_000;

export async function postgresDeadline(pool: Pool): Promise<string> {
  const { rows } = await pool.query("SELECT clock_timestamp()+interval '8 seconds' AS deadline");
  return rows[0].deadline.toISOString();
}

export async function assertPostgresBeforeExpiry(pool: Pool, deadline: string): Promise<void> {
  const { rows } = await pool.query(`WITH sample AS MATERIALIZED (SELECT clock_timestamp() AS observed)
    SELECT observed::text, observed+($2::int*interval '1 millisecond')<$1::timestamptz AS ready FROM sample`,
  [deadline, safetyMarginMs]);
  assert.equal(rows[0].ready, true, `Fixture setup exhausted its expiry budget: ${JSON.stringify({ deadline, ...rows[0] })}`);
}

export async function waitForPostgresPast(pool: Pool, deadline: string) {
  const started = process.hrtime.bigint();
  let previousMs: number | undefined, maximumBackwardMs = 0, consecutive = 0, samples = 0;
  let last: { observed: string; observed_ms: string; ready: boolean } | undefined;
  // Only PostgreSQL decides whether the boundary passed. Monotonic process time
  // bounds the observation loop; a Node/host wall-clock sleep proves nothing.
  while (Number(process.hrtime.bigint()-started)/1e6 < waitLimitMs) {
    const { rows } = await pool.query(`WITH sample AS MATERIALIZED (SELECT clock_timestamp() AS observed)
      SELECT observed::text, (extract(epoch FROM observed)*1000)::text AS observed_ms,
        observed>$1::timestamptz+($2::int*interval '1 millisecond') AS ready FROM sample`,
    [deadline, safetyMarginMs]);
    last = rows[0];
    assert(last, "PostgreSQL clock sample missing");
    const observedMs = Number(last.observed_ms);
    const backwardMs = previousMs === undefined ? 0 : Math.max(0, previousMs-observedMs);
    maximumBackwardMs = Math.max(maximumBackwardMs, backwardMs);
    previousMs = observedMs;
    samples++;
    consecutive = last.ready && backwardMs === 0 ? consecutive+1 : 0;
    if (consecutive === 2) return { deadline, observed: last.observed, safetyMarginMs, samples, maximumBackwardMs };
    await delay(100);
  }
  throw new Error(`PostgreSQL clock did not cross the required boundary within ${waitLimitMs} ms: ${JSON.stringify({ deadline, last, samples, maximumBackwardMs })}`);
}
