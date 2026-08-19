import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";

import { Pool } from "pg";

import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresGrowthEventRepository } from "../src/storage/postgres/postgresGrowthEventRepository";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
});

const identities = new PostgresIdentityPersistence(pool);
const growth = new PostgresGrowthEventRepository(pool);

const ACCOUNT_A = "00000000-0000-4000-8000-000000000801";
const ACCOUNT_B = "00000000-0000-4000-8000-000000000802";

const FIRST = "2026-08-19T12:00:00.000Z";
const SECOND = "2026-08-19T13:00:00.000Z";

const execFileAsync = promisify(execFile);

before(async () => {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/run-migrations.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    },
  );

  const migrationSql = await readFile(
    path.resolve(process.cwd(), "migrations/020_growth_events.sql"),
    "utf8",
  );

  const expectedChecksum = createHash("sha256")
    .update(migrationSql)
    .digest("hex");

  const migration = await pool.query(
    `SELECT checksum
     FROM payment_schema_migrations
     WHERE version='020_growth_events.sql'`,
  );

  assert.equal(migration.rows.length, 1);
  assert.equal(migration.rows[0].checksum, expectedChecksum);

  const schema = await pool.query(
    `SELECT
       to_regclass('public.growth_events') growth_events,
       to_regclass('public.growth_events_actor_time_idx') actor_index,
       to_regclass('public.growth_events_source_idx') source_index`,
  );

  assert.deepEqual(schema.rows[0], {
    growth_events: "growth_events",
    actor_index: "growth_events_actor_time_idx",
    source_index: "growth_events_source_idx",
  });
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE
       growth_events,
       account_security_events,
       account_sessions,
       external_identities,
       accounts
     RESTART IDENTITY CASCADE`,
  );

  await identities.createAccount({
    accountId: ACCOUNT_A,
    createdAt: FIRST,
  });

  await identities.createAccount({
    accountId: ACCOUNT_B,
    createdAt: FIRST,
  });
});

after(async () => {
  await pool.end();
});

describe("PostgreSQL growth events", () => {
  it("appends one canonical event and resolves an exact replay idempotently", async () => {
    const input = {
      eventType: "PAYMENT_SETTLED_SENT" as const,
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT" as const,
      sourceId: "payment:alpha",
      sourceEventId: "receipt:alpha",
      occurredAt: FIRST,
      synthetic: false,
      schemaVersion: 1 as const,
      context: {
        asset: "USDC",
        amountRaw: "1000000",
      },
    };

    const first = await growth.append(input);
    const replay = await growth.append(input);

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.event.eventId, first.event.eventId);

    const count = await pool.query(
      "SELECT count(*)::int AS count FROM growth_events",
    );

    assert.equal(count.rows[0].count, 1);
  });

  it("fails closed when the same source key changes immutable meaning", async () => {
    const base = {
      eventType: "PAYMENT_SETTLED_SENT" as const,
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT" as const,
      sourceId: "payment:conflict",
      sourceEventId: "receipt:conflict",
      occurredAt: FIRST,
      synthetic: false,
      schemaVersion: 1 as const,
      context: {
        asset: "USDC",
        amountRaw: "2000000",
      },
    };

    await growth.append(base);

    await assert.rejects(
      () =>
        growth.append({
          ...base,
          synthetic: true,
        }),
      /idempotency conflict/,
    );

    await assert.rejects(
      () =>
        growth.append({
          ...base,
          context: {
            asset: "USDC",
            amountRaw: "9999999",
          },
        }),
      /idempotency conflict/,
    );
  });

  it("keeps sender and recipient events distinct for the same source fact", async () => {
    const sender = await growth.append({
      eventType: "PAYMENT_SETTLED_SENT",
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT",
      sourceId: "payment:shared",
      sourceEventId: "receipt:shared",
      occurredAt: FIRST,
      synthetic: false,
      schemaVersion: 1,
    });

    const recipient = await growth.append({
      eventType: "PAYMENT_SETTLED_RECEIVED",
      actorAccountId: ACCOUNT_B,
      sourceDomain: "PAYMENT",
      sourceId: "payment:shared",
      sourceEventId: "receipt:shared",
      occurredAt: FIRST,
      synthetic: false,
      schemaVersion: 1,
    });

    assert.equal(sender.created, true);
    assert.equal(recipient.created, true);
    assert.notEqual(sender.event.eventId, recipient.event.eventId);

    const count = await pool.query(
      "SELECT count(*)::int AS count FROM growth_events",
    );

    assert.equal(count.rows[0].count, 2);
  });

  it("persists synthetic classification exactly", async () => {
    const result = await growth.append({
      eventType: "PAYMENT_SETTLED_SENT",
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT",
      sourceId: "payment:synthetic",
      sourceEventId: "receipt:synthetic",
      occurredAt: FIRST,
      synthetic: true,
      schemaVersion: 1,
      context: {
        identitySource: "SYNTHETIC_BETA",
      },
    });

    assert.equal(result.event.synthetic, true);
    assert.equal(
      result.event.context.identitySource,
      "SYNTHETIC_BETA",
    );
  });

  it("enforces canonical account ownership through the database foreign key", async () => {
    await assert.rejects(() =>
      growth.append({
        eventType: "PAYMENT_SETTLED_SENT",
        actorAccountId: "00000000-0000-4000-8000-000000000899",
        sourceDomain: "PAYMENT",
        sourceId: "payment:missing-account",
        sourceEventId: "receipt:missing-account",
        occurredAt: FIRST,
        synthetic: false,
        schemaVersion: 1,
      }),
    );

    const count = await pool.query(
      "SELECT count(*)::int AS count FROM growth_events",
    );

    assert.equal(count.rows[0].count, 0);
  });

  it("is append-only at the PostgreSQL boundary", async () => {
    const created = await growth.append({
      eventType: "PAYMENT_SETTLED_SENT",
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT",
      sourceId: "payment:immutable",
      sourceEventId: "receipt:immutable",
      occurredAt: FIRST,
      synthetic: false,
      schemaVersion: 1,
    });

    await assert.rejects(
      () =>
        pool.query(
          "UPDATE growth_events SET synthetic=true WHERE event_id=$1",
          [created.event.eventId.toString()],
        ),
      /growth events are append-only/,
    );

    await assert.rejects(
      () =>
        pool.query(
          "DELETE FROM growth_events WHERE event_id=$1",
          [created.event.eventId.toString()],
        ),
      /growth events are append-only/,
    );
  });

  it("lists actor history newest first with a bounded limit", async () => {
    await growth.append({
      eventType: "PAYMENT_SETTLED_SENT",
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT",
      sourceId: "payment:first",
      sourceEventId: "receipt:first",
      occurredAt: FIRST,
      synthetic: false,
      schemaVersion: 1,
    });

    await growth.append({
      eventType: "PAYMENT_SETTLED_SENT",
      actorAccountId: ACCOUNT_A,
      sourceDomain: "PAYMENT",
      sourceId: "payment:second",
      sourceEventId: "receipt:second",
      occurredAt: SECOND,
      synthetic: false,
      schemaVersion: 1,
    });

    const history = await growth.listByActor(ACCOUNT_A, 10);

    assert.equal(history.length, 2);
    assert.equal(history[0].sourceId, "payment:second");
    assert.equal(history[1].sourceId, "payment:first");

    const bounded = await growth.listByActor(ACCOUNT_A, 1);

    assert.equal(bounded.length, 1);
    assert.equal(bounded[0].sourceId, "payment:second");

    await assert.rejects(() =>
      growth.listByActor(ACCOUNT_A, 101),
    );
  });
});
