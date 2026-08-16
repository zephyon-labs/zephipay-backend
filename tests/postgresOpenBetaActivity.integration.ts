import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { Pool } from "pg";

import { PostgresOpenBetaActivityRepository } from "../src/storage/postgres/postgresOpenBetaActivityRepository";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { actorSubjectForAccount } from "../src/identity/identityTypes";

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL is required.");
const pool = new Pool({ connectionString: url, max: 2 });
const repository = new PostgresOpenBetaActivityRepository(pool);
const identities = new PostgresIdentityPersistence(pool);
const EPOCH = "2026-08-09T06:09:34.531759Z";

beforeEach(async () => {
  await pool.query("TRUNCATE telemetry_epochs,payment_execution_receipts,payment_execution_events,payment_execution_attempts,payment_executions,payment_events,payment_receipts,payments,economic_identities,payment_destinations,external_identities,account_security_events,account_sessions,accounts,beta_allowlist RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO telemetry_epochs(epoch_name,starts_at,established_at,provenance_note) VALUES('OPEN_BETA',$1,$1,'Controlled integration epoch.')", [EPOCH]);
});
after(async () => pool.end());

test("epoch boundary excludes historical activity and aggregates exact durable Mock facts", async () => {
  const senderOne = await account(), senderTwo = await account();
  await economic(senderOne, "sender_one"); await economic(senderTwo, "sender_two");
  await execution(senderOne, "2026-08-09T06:09:34.531758Z", "SETTLED", "1000000", true);
  await execution(senderOne, EPOCH, "SETTLED", "900719925474099312345", true, { identitySource: "SYNTHETIC_BETA", displayName: "Synthetic", username: "synthetic" });
  await execution(senderOne, "2026-08-09T06:10:00.000000Z", "SETTLED", "2000000", true);
  await execution(senderTwo, "2026-08-09T06:11:00.000000Z", "SETTLED", "3000000", true);
  await execution(senderTwo, "2026-08-09T06:12:00.000000Z", "FAILED", "0", false);
  await execution(senderTwo, "2026-08-09T06:13:00.000000Z", "PROCESSING", "0", false);

  const before = (await pool.query("SELECT (SELECT count(*) FROM payments) payments,(SELECT count(*) FROM payment_executions) executions,(SELECT count(*) FROM payment_execution_receipts) receipts")).rows[0];
  assert.deepEqual(await repository.aggregate("OPEN_BETA"), {
    betaTesters: 2,
    paymentsCompleted: 3,
    mockUsdcAmountRaw: "900719925474104312345",
    durableReceipts: 3,
    executionsInitiated: 5,
    executionsSettled: 3,
  });
  const after = (await pool.query("SELECT (SELECT count(*) FROM payments) payments,(SELECT count(*) FROM payment_executions) executions,(SELECT count(*) FROM payment_execution_receipts) receipts")).rows[0];
  assert.deepEqual(after, before, "observational telemetry must not mutate economic state");
});

test("epoch absence fails closed, duplicate epoch is prohibited, and non-Mock execution is rejected", async () => {
  await pool.query("TRUNCATE telemetry_epochs");
  await assert.rejects(() => repository.aggregate("OPEN_BETA"), /epoch is unavailable/i);
  await pool.query("INSERT INTO telemetry_epochs(epoch_name,starts_at,established_at,provenance_note) VALUES('OPEN_BETA',$1,$1,'Restored.')", [EPOCH]);
  await assert.rejects(() => pool.query("INSERT INTO telemetry_epochs(epoch_name,starts_at,established_at,provenance_note) VALUES('OPEN_BETA',$1,$1,'Duplicate.')", [EPOCH]));
  await assert.rejects(() => pool.query("UPDATE telemetry_epochs SET provenance_note='Rewritten.' WHERE epoch_name='OPEN_BETA'"));
  await assert.rejects(() => pool.query("DELETE FROM telemetry_epochs WHERE epoch_name='OPEN_BETA'"));
  const actor = await account(); const paymentId = await payment(actor, EPOCH);
  await assert.rejects(() => pool.query("INSERT INTO payment_executions(execution_id,payment_intent_id,actor_subject,selected_rail,provider_idempotency_key,created_at,updated_at) VALUES($1,$2,$3,'solana',$4,$5,$5)", [randomUUID(), paymentId, actor, randomUUID(), EPOCH]));
});

test("synthetic source accounts remain operationally durable but do not increment public human metrics", async () => {
  const human = await account(), synthetic = await account();
  await execution(human, EPOCH, "SETTLED", "2000000", true);
  await execution(synthetic, EPOCH, "SETTLED", "3000000", true);
  await pool.query("INSERT INTO synthetic_test_actors(synthetic_actor_id,account_id,actor_kind,test_origin,created_at) VALUES('synthetic-human-a',$1,'human','codex_e2e',$2)", [synthetic.slice("zp:account:".length), EPOCH]);
  assert.deepEqual(await repository.aggregate("OPEN_BETA"), {
    betaTesters: 1, paymentsCompleted: 1, mockUsdcAmountRaw: "2000000",
    durableReceipts: 1, executionsInitiated: 1, executionsSettled: 1,
  });
  assert.equal((await pool.query("SELECT count(*)::int count FROM payment_executions")).rows[0].count, 2);
});

async function account(): Promise<string> {
  const id = randomUUID();
  await identities.createAccount({ accountId: id, createdAt: EPOCH });
  return actorSubjectForAccount(id);
}
async function economic(actor: string, username: string) {
  const id = actor.slice("zp:account:".length);
  await pool.query("INSERT INTO economic_identities(account_id,username,normalized_username,display_name) VALUES($1,$2,$2,$2)", [id, username]);
}
async function payment(actor: string, createdAt: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO payments(id,actor_subject,idempotency_key,request_hash,status,network,rail,asset,mint_address,recipient_address,amount_raw,purpose,created_at,updated_at) VALUES($1,$2,$3,decode($4,'hex'),'AWAITING_CONFIRMATION','solana-devnet','solana','USDC','mint','11111111111111111111111111111111',1,NULL,$5,$5)", [id, actor, randomUUID(), "a".repeat(64), createdAt]);
  return id;
}
async function execution(actor: string, createdAt: string, status: "SETTLED" | "FAILED" | "PROCESSING", amount: string, withReceipt: boolean, recipientSnapshot?: Record<string, unknown>) {
  const paymentIntentId = await payment(actor, createdAt), executionId = randomUUID();
  await pool.query("INSERT INTO payment_executions(execution_id,payment_intent_id,actor_subject,status,provider_idempotency_key,settled_at,failed_at,failure_code,settlement_evidence,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)", [executionId, paymentIntentId, actor, status, randomUUID(), status === "SETTLED" ? createdAt : null, status === "FAILED" ? createdAt : null, status === "FAILED" ? "REJECTED" : null, status === "SETTLED" ? {} : null, createdAt]);
  if (withReceipt) await pool.query("INSERT INTO payment_execution_receipts(receipt_id,execution_id,payment_intent_id,actor_subject,runtime_transaction_id,rail,asset,amount_units,amount_decimals,sender_id,recipient_id,recipient_snapshot,memo,settled_at,evidence_type,evidence_version,evidence,schema_version,request_hash,created_at) VALUES($1,$2,$3,$4,$9,'mock','USDC',$5,6,'sender','recipient',$6,NULL,$7,'mock.execution',1,'{}',1,decode($8,'hex'),$7)", [`receipt:${executionId}`, executionId, paymentIntentId, actor, amount, recipientSnapshot ? JSON.stringify(recipientSnapshot) : null, createdAt, "a".repeat(64), executionId]);
}
