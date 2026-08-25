import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";

import { PostgresPaymentPersistence } from "../src/storage/postgres/postgresPaymentPersistence";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const freshSchema = `migration_009_fresh_${randomUUID().replaceAll("-", "")}`;
const upgradeSchema = `migration_009_upgrade_${randomUUID().replaceAll("-", "")}`;
const files = readdirSync(path.resolve("migrations")).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort();

before(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await pool.query(`CREATE SCHEMA ${freshSchema}`);
  await pool.query(`CREATE SCHEMA ${upgradeSchema}`);
});

after(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
  await pool.end();
});

test("migration 009 supports fresh and historical upgrade paths without weakening linkage immutability", async () => {
  await withSchema(freshSchema, async (client) => {
    await migrate(client, files);
    assert.deepEqual(await applied(client), files);
  });

  await withSchema(upgradeSchema, async (client) => {
    await migrate(client, files.slice(0, 8));
    const sender = randomUUID();
    const recipient = randomUUID();
    const payment = randomUUID();
    await seedAccount(client, sender);
    await seedAccount(client, recipient);
    const actor = `zp:account:${sender}`;
    const idempotencyKey = `upgrade-${randomUUID()}`;
    const historicalSnapshot = {
      accountId: recipient,
      username: "historical",
      displayName: "Historical",
      accountType: "PERSONAL",
      verificationState: "UNVERIFIED",
      payabilityState: "AVAILABLE",
      capturedAt: "2026-08-01T00:00:00.000Z",
      schemaVersion: 1,
      resolutionSource: "RECIPIENT_DIRECTORY",
      trustOutcome: "ACKNOWLEDGED",
    } as const;
    const historicalHash = preMigration009RequestHash({
      actorSubject: actor,
      recipientAccountId: recipient,
      recipientAddress: "wallet",
      recipientSnapshot: historicalSnapshot,
      amountRaw: 1_000_000n,
      purpose: null,
    });
    await client.query("INSERT INTO beta_allowlist(actor_subject) VALUES($1)", [actor]);
    await client.query(
      `INSERT INTO payments(
         id,actor_subject,idempotency_key,request_hash,status,network,rail,asset,mint_address,
         recipient_address,amount_raw,purpose,recipient_type,recipient_account_id,
         recipient_snapshot,recipient_snapshot_version,trust_confirmation_outcome
       ) VALUES($1,$2,$3,decode($4,'hex'),'AWAITING_CONFIRMATION','solana-devnet','solana','USDC',$5,$6,1000000,NULL,
         'PAYMENT_IDENTITY',$7,$8::jsonb,1,'ACKNOWLEDGED')`,
      [payment, actor, idempotencyKey, historicalHash, "mint", "wallet", recipient, JSON.stringify(historicalSnapshot)],
    );

    await migrate(client, files.slice(8));
    assert.deepEqual(await applied(client), files);
    const backfilled = await client.query("SELECT recipient_snapshot->>'identitySource' AS source,encode(request_hash,'hex') AS request_hash FROM payments WHERE id=$1", [payment]);
    assert.equal(backfilled.rows[0].source, "RECIPIENT_DIRECTORY");
    assert.equal(backfilled.rows[0].request_hash, historicalHash);
    const replayPool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${upgradeSchema},public` });
    try {
      const payments = new PostgresPaymentPersistence(replayPool);
      const replayInput = {id:randomUUID(),actorSubject:actor,senderAccountId:sender,idempotencyKey,recipientAccountId:recipient,trustAcknowledged:true,network:"solana-devnet" as const,rail:"solana" as const,asset:"USDC" as const,mintAddress:"mint",amountRaw:1_000_000n,purpose:null,capturedAt:"2026-08-09T00:00:00.000Z"};
      const replay = await payments.claimPaymentIdentityKey(replayInput);
      assert.equal(replay.outcome, "EXISTING");
      assert.equal(replay.payment.id, payment);
      assert.equal(replay.payment.requestHash, historicalHash);
      assert.equal((await payments.claimPaymentIdentityKey({...replayInput,id:randomUUID(),recipientAccountId:sender})).outcome,"HASH_CONFLICT");
      assert.equal((await payments.claimPaymentIdentityKey({...replayInput,id:randomUUID(),amountRaw:2_000_000n})).outcome,"HASH_CONFLICT");
    } finally {
      await replayPool.end();
    }
    const trigger = await client.query("SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND t.tgname='payments_protect_recipient_linkage' AND NOT t.tgisinternal");
    assert.deepEqual(trigger.rows.map((row) => row.tgenabled), ["O"]);

    await immutable(client, "UPDATE payments SET recipient_snapshot=recipient_snapshot || '{\"displayName\":\"Changed\"}'::jsonb WHERE id=$1", [payment]);
    await immutable(client, "UPDATE payments SET recipient_account_id=$2 WHERE id=$1", [payment, sender]);
    await immutable(client, "UPDATE payments SET recipient_synthetic_id=$2 WHERE id=$1", [payment, randomUUID()]);
    await immutable(client, "UPDATE payments SET recipient_type='DIRECT_WALLET' WHERE id=$1", [payment]);
  });
});

function preMigration009RequestHash(input: Readonly<{
  actorSubject: string;
  recipientAccountId: string;
  recipientAddress: string;
  recipientSnapshot: Readonly<Record<string, unknown>>;
  amountRaw: bigint;
  purpose: string | null;
}>): string {
  return createHash("sha256").update(JSON.stringify({
    actorSubject: input.actorSubject,
    recipientType: "PAYMENT_IDENTITY",
    recipientAccountId: input.recipientAccountId,
    network: "solana-devnet",
    mintAddress: "mint",
    recipientAddress: input.recipientAddress,
    recipientSnapshot: input.recipientSnapshot,
    trustConfirmationOutcome: "ACKNOWLEDGED",
    amountRaw: input.amountRaw.toString(),
    purpose: input.purpose,
  }), "utf8").digest("hex");
}

async function withSchema(schema: string, action: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema},public`);
    await action(client);
  } finally {
    client.release();
  }
}

async function migrate(client: PoolClient, migrationFiles: string[]) {
  await client.query(`CREATE TABLE IF NOT EXISTS payment_schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text NOT NULL)`);
  for (const file of migrationFiles) {
    const sql = await readFile(path.resolve("migrations", file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query("SELECT checksum FROM payment_schema_migrations WHERE version=$1", [file]);
    if (existing.rows[0]) {
      assert.equal(existing.rows[0].checksum, checksum);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO payment_schema_migrations(version,checksum) VALUES($1,$2)", [file, checksum]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function applied(client: PoolClient): Promise<string[]> {
  return (await client.query("SELECT version FROM payment_schema_migrations ORDER BY version")).rows.map((row) => String(row.version));
}

async function seedAccount(client: PoolClient, accountId: string) {
  const actor = `zp:account:${accountId}`;
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO accounts(account_id,actor_subject) VALUES($1,$2)", [accountId, actor]);
    await client.query("INSERT INTO account_security_events(account_id,sequence_number,event_type,account_version,occurred_at) VALUES($1,1,'ACCOUNT_CREATED',0,now())", [accountId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function immutable(client: PoolClient, sql: string, params: unknown[]) {
  await assert.rejects(client.query(sql, params), /payment recipient linkage is immutable/);
}
