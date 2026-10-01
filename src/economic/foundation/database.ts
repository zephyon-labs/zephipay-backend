import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export async function transaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function machineId(value: unknown): string {
  requireCondition(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/.test(value), "Invalid authority identifier.");
  return value;
}
export function units(value: unknown): string {
  requireCondition(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n, "Invalid exposure units.");
  return value;
}
export async function databaseTime(client: PoolClient): Promise<string> {
  return (await client.query("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();
}

/** References only. Never pass envelopes, tokens, signatures or transaction bytes. */
export async function audit(client: PoolClient, event: {
  type: string; actor: string; intentId?: string; generation?: string; finalizationId?: string;
  consentId?: string; runtimeId?: string; reference?: string;
}): Promise<void> {
  await client.query(`INSERT INTO economic_authority_events
    (event_type, actor, intent_id, generation, finalization_id, consent_id, runtime_id, reference)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [event.type, event.actor, event.intentId ?? null, event.generation ?? null,
    event.finalizationId ?? null, event.consentId ?? null, event.runtimeId ?? null, event.reference ?? null]);
}
