import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { Pool } from "pg";

import { PostgresGrowthEventRepository } from "../src/storage/postgres/postgresGrowthEventRepository";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresZpStateRepository } from "../src/storage/postgres/postgresZpStateRepository";

const url = process.env.TEST_DATABASE_URL?.trim();

if (!url) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: url,
  max: 8,
});

const identities =
  new PostgresIdentityPersistence(pool);

const growth =
  new PostgresGrowthEventRepository(pool);

const NOW = "2026-08-19T17:00:00.000Z";

const zp =
  new PostgresZpStateRepository(
    pool,
    () => NOW,
  );

beforeEach(async () => {
  await pool.query(
    `TRUNCATE
       account_zp_state,
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

async function append(
  accountId: string,
  index: number,
  options: {
    type?:
      | "PAYMENT_SETTLED_SENT"
      | "PAYMENT_SETTLED_RECEIVED";
    synthetic?: boolean;
  } = {},
) {
  return growth.append({
    eventType:
      options.type ??
      "PAYMENT_SETTLED_SENT",
    actorAccountId: accountId,
    sourceDomain: "PAYMENT",
    sourceId: `payment:${index}`,
    sourceEventId: `receipt:${index}`,
    occurredAt: NOW,
    synthetic:
      options.synthetic ?? false,
    schemaVersion: 1,
    context: {},
  });
}

test(
  "projects canonical Growth activity into durable ZP state",
  async () => {
    const accountId = await account();

    await append(accountId, 1);
    await append(accountId, 2, {
      type: "PAYMENT_SETTLED_RECEIVED",
    });

    const result =
      await zp.projectAccount(accountId);

    assert.equal(result.processedEvents, 2);
    assert.equal(result.totalPoints, 15n);
    assert.equal(result.sentCount, 1n);
    assert.equal(result.receivedCount, 1n);

    const state = await zp.find(accountId);

    assert.ok(state);
    assert.equal(state.totalPoints, 15n);
    assert.equal(state.sentCount, 1n);
    assert.equal(state.receivedCount, 1n);
    assert.equal(state.policyVersion, 1);
  },
);

test(
  "projection replay does not double count",
  async () => {
    const accountId = await account();

    await append(accountId, 1);

    const first =
      await zp.projectAccount(accountId);

    const replay =
      await zp.projectAccount(accountId);

    assert.equal(first.processedEvents, 1);
    assert.equal(first.totalPoints, 10n);

    assert.equal(replay.processedEvents, 0);
    assert.equal(replay.totalPoints, 10n);

    const state = await zp.find(accountId);

    assert.ok(state);
    assert.equal(state.totalPoints, 10n);
    assert.equal(state.sentCount, 1n);
  },
);

test(
  "synthetic events advance the cursor but award no ZP",
  async () => {
    const accountId = await account();

    const first =
      await append(accountId, 1);

    const synthetic =
      await append(accountId, 2, {
        synthetic: true,
      });

    const third =
      await append(accountId, 3, {
        type: "PAYMENT_SETTLED_RECEIVED",
      });

    const result =
      await zp.projectAccount(accountId);

    assert.equal(result.processedEvents, 3);
    assert.equal(result.totalPoints, 15n);
    assert.equal(result.sentCount, 1n);
    assert.equal(result.receivedCount, 1n);

    assert.equal(
      result.lastGrowthEventId,
      third.event.eventId,
    );

    assert.ok(
      synthetic.event.eventId >
      first.event.eventId,
    );
  },
);

test(
  "bounded projection resumes from its durable cursor",
  async () => {
    const accountId = await account();

    for (let i = 1; i <= 5; i += 1) {
      await append(accountId, i);
    }

    const first =
      await zp.projectAccount(accountId, 2);

    assert.equal(first.processedEvents, 2);
    assert.equal(first.totalPoints, 20n);

    const second =
      await zp.projectAccount(accountId, 2);

    assert.equal(second.processedEvents, 2);
    assert.equal(second.totalPoints, 40n);

    const third =
      await zp.projectAccount(accountId, 2);

    assert.equal(third.processedEvents, 1);
    assert.equal(third.totalPoints, 50n);

    const fourth =
      await zp.projectAccount(accountId, 2);

    assert.equal(fourth.processedEvents, 0);
    assert.equal(fourth.totalPoints, 50n);
  },
);

test(
  "different accounts maintain independent ZP cursors",
  async () => {
    const left = await account();
    const right = await account();

    await append(left, 1);
    await append(left, 2);

    await append(right, 3, {
      type: "PAYMENT_SETTLED_RECEIVED",
    });

    await zp.projectAccount(left);
    await zp.projectAccount(right);

    const leftState = await zp.find(left);
    const rightState = await zp.find(right);

    assert.ok(leftState);
    assert.ok(rightState);

    assert.equal(leftState.totalPoints, 20n);
    assert.equal(rightState.totalPoints, 5n);

    assert.equal(leftState.sentCount, 2n);
    assert.equal(rightState.receivedCount, 1n);
  },
);

test(
  "concurrent projection converges without double counting",
  async () => {
    const accountId = await account();

    for (let i = 1; i <= 20; i += 1) {
      await append(accountId, i);
    }

    await Promise.all([
      zp.projectAccount(accountId),
      zp.projectAccount(accountId),
      zp.projectAccount(accountId),
      zp.projectAccount(accountId),
    ]);

    const state = await zp.find(accountId);

    assert.ok(state);

    assert.equal(state.totalPoints, 200n);
    assert.equal(state.sentCount, 20n);
    assert.equal(state.receivedCount, 0n);

    const replay =
      await zp.projectAccount(accountId);

    assert.equal(replay.processedEvents, 0);
    assert.equal(replay.totalPoints, 200n);
  },
);

test(
  "zero-event projection initializes honest zero state",
  async () => {
    const accountId = await account();

    const result =
      await zp.projectAccount(accountId);

    assert.equal(result.processedEvents, 0);
    assert.equal(result.totalPoints, 0n);
    assert.equal(result.sentCount, 0n);
    assert.equal(result.receivedCount, 0n);
    assert.equal(result.lastGrowthEventId, 0n);

    const state = await zp.find(accountId);

    assert.ok(state);
    assert.equal(state.totalPoints, 0n);
  },
);
