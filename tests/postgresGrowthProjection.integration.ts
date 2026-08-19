import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { Pool } from "pg";

import { PaymentSettlementGrowthProjector } from "../src/growth/paymentSettlementGrowthProjector";
import { actorSubjectForAccount } from "../src/identity/identityTypes";
import { PostgresGrowthEventRepository } from "../src/storage/postgres/postgresGrowthEventRepository";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";

const url = process.env.TEST_DATABASE_URL?.trim();

if (!url) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: url,
  max: 4,
});

const identities = new PostgresIdentityPersistence(pool);
const growth = new PostgresGrowthEventRepository(pool);
const projector = new PaymentSettlementGrowthProjector(pool, growth);

const NOW = "2026-08-19T15:00:00.000Z";

beforeEach(async () => {
  await pool.query(
    `TRUNCATE
       growth_events,
       e2e_test_runs,
       synthetic_test_actors,
       payment_execution_receipts,
       payment_execution_events,
       payment_execution_attempts,
       payment_executions,
       payment_events,
       payment_receipts,
       payments,
       synthetic_beta_identities,
       economic_identities,
       payment_destinations,
       account_security_events,
       account_sessions,
       external_identities,
       accounts,
       beta_allowlist
     RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await pool.end();
});

async function account(): Promise<string> {
  const accountId = randomUUID();

  await identities.createAccount({
    accountId,
    createdAt: NOW,
  });

  return accountId;
}

async function settledPayment(input: {
  senderAccountId: string;
  recipientAccountId?: string;
  recipientSyntheticId?: string;
}): Promise<{
  paymentId: string;
  executionId: string;
  receiptId: string;
}> {
  const paymentId = randomUUID();
  const executionId = randomUUID();
  const receiptId = `receipt:${executionId}`;
  const senderActor = actorSubjectForAccount(input.senderAccountId);

  const recipientType =
    input.recipientAccountId || input.recipientSyntheticId
      ? "PAYMENT_IDENTITY"
      : "DIRECT_WALLET";

  let recipientSnapshot: Record<string, unknown> | null = null;

  if (input.recipientAccountId) {
    recipientSnapshot = {
      accountId: input.recipientAccountId,
      username: "recipient",
      displayName: "Recipient",
      accountType: "PERSONAL",
      verificationState: "VERIFIED",
      payabilityState: "AVAILABLE",
      capturedAt: NOW,
      schemaVersion: 1,
      identitySource: "RECIPIENT_DIRECTORY",
      resolutionSource: "RECIPIENT_DIRECTORY",
      trustOutcome: "NOT_REQUIRED",
    };
  }

  if (input.recipientSyntheticId) {
    await pool.query(
      `INSERT INTO synthetic_beta_identities
         (synthetic_id, normalized_name, display_name)
       VALUES ($1, 'synthetic-growth', 'Synthetic Growth')`,
      [input.recipientSyntheticId],
    );

    recipientSnapshot = {
      accountId: input.recipientSyntheticId,
      username: "Synthetic Growth",
      displayName: "Synthetic Growth",
      accountType: "PERSONAL",
      verificationState: "UNVERIFIED",
      payabilityState: "AVAILABLE",
      capturedAt: NOW,
      schemaVersion: 1,
      identitySource: "SYNTHETIC_BETA",
      resolutionSource: "SYNTHETIC_BETA",
      trustOutcome: "NOT_REQUIRED",
    };
  }

  await pool.query(
    `INSERT INTO payments (
       id,
       actor_subject,
       idempotency_key,
       request_hash,
       status,
       network,
       rail,
       asset,
       mint_address,
       recipient_address,
       amount_raw,
       purpose,
       recipient_type,
       recipient_account_id,
       recipient_synthetic_id,
       recipient_snapshot,
       recipient_snapshot_version,
       trust_confirmation_outcome,
       user_confirmed_at,
       execution_started_at,
       created_at,
       updated_at
     )
     VALUES (
       $1,$2,$3,decode($4,'hex'),'PROCESSING',
       'solana-devnet','solana','USDC',
       'mint','destination',1000000,NULL,
       $5,$6,$7,$8::jsonb,
       $9,$10,$11,$11,$11,$11
     )`,
    [
      paymentId,
      senderActor,
      `growth-${paymentId}`,
      "a".repeat(64),
      recipientType,
      input.recipientAccountId ?? null,
      input.recipientSyntheticId ?? null,
      recipientSnapshot ? JSON.stringify(recipientSnapshot) : null,
      recipientSnapshot ? 1 : null,
      recipientSnapshot ? "NOT_REQUIRED" : null,
      NOW,
    ],
  );

  await pool.query(
    `INSERT INTO payment_executions (
       execution_id,
       payment_intent_id,
       actor_subject,
       status,
       selected_rail,
       execution_mode,
       settlement_network,
       policy_hash,
       provider_idempotency_key,
       settlement_evidence,
       settled_at,
       created_at,
       updated_at
     )
     VALUES (
       $1,$2,$3,'SETTLED','solana',
       'devnet_validation','solana-devnet',
       decode($4,'hex'),$5,
       '{"confirmationStatus":"finalized"}'::jsonb,
       $6,$6,$6
     )`,
    [
      executionId,
      paymentId,
      senderActor,
      "b".repeat(64),
      `growth-provider-${executionId}`,
      NOW,
    ],
  );

  await pool.query(
    `INSERT INTO payment_execution_receipts (
       receipt_id,
       execution_id,
       payment_intent_id,
       actor_subject,
       runtime_transaction_id,
       rail,
       asset,
       amount_units,
       amount_decimals,
       sender_id,
       recipient_id,
       recipient_snapshot,
       memo,
       provider_reference,
       settled_at,
       evidence_type,
       evidence_version,
       evidence,
       schema_version,
       request_hash,
       created_at
     )
     VALUES (
       $1,$2::uuid,$3,$4,$2::uuid::text,'solana','USDC',
       '1000000',6,$5,$6,$7::jsonb,NULL,
       'provider-reference',$8,
       'solana.signature',1,
       '{"confirmationStatus":"finalized"}'::jsonb,
       1,decode($9,'hex'),$8
     )`,
    [
      receiptId,
      executionId,
      paymentId,
      senderActor,
      input.senderAccountId,
      input.recipientAccountId ??
        input.recipientSyntheticId ??
        "wallet:external",
      recipientSnapshot ? JSON.stringify(recipientSnapshot) : null,
      NOW,
      "a".repeat(64),
    ],
  );

  return {
    paymentId,
    executionId,
    receiptId,
  };
}

test("projects canonical sender and recipient settlement facts", async () => {
  const sender = await account();
  const recipient = await account();

  const payment = await settledPayment({
    senderAccountId: sender,
    recipientAccountId: recipient,
  });

  const projected = await projector.projectPayment(payment.paymentId);

  assert.ok(projected);
  assert.equal(projected.synthetic, false);
  assert.equal(projected.senderCreated, true);
  assert.equal(projected.recipientCreated, true);

  assert.equal((await growth.listByActor(sender, 10))[0].eventType,
    "PAYMENT_SETTLED_SENT");

  assert.equal((await growth.listByActor(recipient, 10))[0].eventType,
    "PAYMENT_SETTLED_RECEIVED");
});

test("direct-wallet settlement creates only sender growth", async () => {
  const sender = await account();

  const payment = await settledPayment({
    senderAccountId: sender,
  });

  const projected = await projector.projectPayment(payment.paymentId);

  assert.ok(projected);
  assert.equal(projected.senderCreated, true);
  assert.equal(projected.recipientCreated, false);

  const count = await pool.query(
    "SELECT count(*)::int count FROM growth_events",
  );

  assert.equal(count.rows[0].count, 1);
});

test("synthetic beta recipient makes the payment synthetic and creates no canonical recipient event", async () => {
  const sender = await account();

  const payment = await settledPayment({
    senderAccountId: sender,
    recipientSyntheticId: randomUUID(),
  });

  const projected = await projector.projectPayment(payment.paymentId);

  assert.ok(projected);
  assert.equal(projected.synthetic, true);
  assert.equal(projected.senderCreated, true);
  assert.equal(projected.recipientCreated, false);

  const events = await growth.listByActor(sender, 10);

  assert.equal(events.length, 1);
  assert.equal(events[0].synthetic, true);
});

test("synthetic test sender makes canonical recipient activity synthetic too", async () => {
  const sender = await account();
  const recipient = await account();

  await pool.query(
    `INSERT INTO synthetic_test_actors (
       synthetic_actor_id,
       account_id,
       actor_class,
       actor_kind,
       test_origin,
       created_at
     )
     VALUES (
       'growth-synthetic-sender',
       $1,
       'synthetic_test',
       'human',
       'codex_e2e',
       $2
     )`,
    [sender, NOW],
  );

  const payment = await settledPayment({
    senderAccountId: sender,
    recipientAccountId: recipient,
  });

  const projected = await projector.projectPayment(payment.paymentId);

  assert.ok(projected);
  assert.equal(projected.synthetic, true);

  const senderEvents = await growth.listByActor(sender, 10);
  const recipientEvents = await growth.listByActor(recipient, 10);

  assert.equal(senderEvents[0].synthetic, true);
  assert.equal(recipientEvents[0].synthetic, true);
});

test("synthetic test recipient makes the entire canonical payment synthetic", async () => {
  const sender = await account();
  const recipient = await account();

  await pool.query(
    `INSERT INTO synthetic_test_actors (
       synthetic_actor_id,
       account_id,
       actor_class,
       actor_kind,
       test_origin,
       created_at
     )
     VALUES (
       'growth-synthetic-recipient',
       $1,
       'synthetic_test',
       'human',
       'codex_e2e',
       $2
     )`,
    [recipient, NOW],
  );

  const payment = await settledPayment({
    senderAccountId: sender,
    recipientAccountId: recipient,
  });

  const projected = await projector.projectPayment(payment.paymentId);

  assert.ok(projected);
  assert.equal(projected.synthetic, true);

  const senderEvents = await growth.listByActor(sender, 10);
  const recipientEvents = await growth.listByActor(recipient, 10);

  assert.equal(senderEvents[0].synthetic, true);
  assert.equal(recipientEvents[0].synthetic, true);
});

test("projection replay is idempotent", async () => {
  const sender = await account();
  const recipient = await account();

  const payment = await settledPayment({
    senderAccountId: sender,
    recipientAccountId: recipient,
  });

  const first = await projector.projectPayment(payment.paymentId);
  const replay = await projector.projectPayment(payment.paymentId);

  assert.ok(first);
  assert.ok(replay);

  assert.equal(first.senderCreated, true);
  assert.equal(first.recipientCreated, true);

  assert.equal(replay.senderCreated, false);
  assert.equal(replay.recipientCreated, false);

  const count = await pool.query(
    "SELECT count(*)::int count FROM growth_events",
  );

  assert.equal(count.rows[0].count, 2);
});

test("unsettled execution cannot produce growth", async () => {
  const sender = await account();
  const paymentId = randomUUID();
  const executionId = randomUUID();
  const senderActor = actorSubjectForAccount(sender);

  await pool.query(
    `INSERT INTO payments (
       id, actor_subject, idempotency_key, request_hash,
       status, network, rail, asset, mint_address,
       recipient_address, amount_raw, purpose,
       recipient_type, user_confirmed_at,
       execution_started_at, created_at, updated_at
     )
     VALUES (
       $1,$2,$3,decode($4,'hex'),
       'PROCESSING','solana-devnet','solana','USDC','mint',
       'destination',1000000,NULL,
       'DIRECT_WALLET',$5,$5,$5,$5
     )`,
    [
      paymentId,
      senderActor,
      `growth-unsettled-${paymentId}`,
      "d".repeat(64),
      NOW,
    ],
  );

  await pool.query(
    `INSERT INTO payment_executions (
       execution_id, payment_intent_id, actor_subject,
       status, selected_rail, execution_mode,
       settlement_network, policy_hash,
       provider_idempotency_key, created_at, updated_at
     )
     VALUES (
       $1,$2,$3,
       'PROCESSING','solana','devnet_validation',
       'solana-devnet',decode($4,'hex'),$5,$6,$6
     )`,
    [
      executionId,
      paymentId,
      senderActor,
      "e".repeat(64),
      "f".repeat(64),
      NOW,
    ],
  );

  const projected = await projector.projectPayment(paymentId);

  assert.equal(projected, undefined);

  const count = await pool.query(
    "SELECT count(*)::int count FROM growth_events",
  );

  assert.equal(count.rows[0].count, 0);
});

test("pending sweep projects durable receipts once", async () => {
  const sender = await account();

  await settledPayment({
    senderAccountId: sender,
  });

  await settledPayment({
    senderAccountId: sender,
  });

  const first = await projector.projectPending(100);
  const second = await projector.projectPending(100);

  assert.equal(first.length, 2);
  assert.equal(second.length, 0);

  const events = await growth.listByActor(sender, 10);

  assert.equal(events.length, 2);
});
