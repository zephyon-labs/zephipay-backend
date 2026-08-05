import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";

import { Pool } from "pg";

import { EconomicIdentityVersionConflictError, PaymentDestinationConflictError, UsernameConflictError } from "../src/economicIdentity/economicIdentityStorageContracts";
import { PostgresEconomicIdentityPersistence } from "../src/storage/postgres/postgresEconomicIdentityPersistence";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const accounts = new PostgresIdentityPersistence(pool);
const economic = new PostgresEconomicIdentityPersistence(pool);
const ACCOUNT_A = "00000000-0000-4000-8000-000000000701";
const ACCOUNT_B = "00000000-0000-4000-8000-000000000702";
const WALLET_A = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const WALLET_B = "4Nd1mYwRkXkYtGT7dQz4FzRzCQXDpGfVv3YJz7drGqPv";
const START = "2026-08-05T12:00:00.000Z";
const LATER = "2026-08-05T13:00:00.000Z";
const execFileAsync = promisify(execFile);

before(async () => {
  await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const migrationSql = await readFile(path.resolve(process.cwd(), "migrations/003_economic_identity.sql"), "utf8");
  const expectedChecksum = createHash("sha256").update(migrationSql).digest("hex");
  const migration = await pool.query("SELECT checksum FROM payment_schema_migrations WHERE version='003_economic_identity.sql'");
  assert.equal(migration.rows.length, 1);
  assert.equal(migration.rows[0].checksum, expectedChecksum);
  const schema = await pool.query(
    `SELECT to_regclass('public.economic_identities') economic_identities,
            to_regclass('public.payment_destinations') payment_destinations,
            to_regclass('public.economic_identities_normalized_username_unique') username_index,
            to_regclass('public.payment_destinations_primary_per_type_unique') primary_index`,
  );
  assert.deepEqual(schema.rows[0], {
    economic_identities: "economic_identities",
    payment_destinations: "payment_destinations",
    username_index: "economic_identities_normalized_username_unique",
    primary_index: "payment_destinations_primary_per_type_unique",
  });
});

beforeEach(async () => {
  await pool.query("TRUNCATE account_security_events,account_sessions,external_identities,economic_identities,payment_destinations,accounts RESTART IDENTITY CASCADE");
  await accounts.createAccount({ accountId: ACCOUNT_A, createdAt: START });
  await accounts.createAccount({ accountId: ACCOUNT_B, createdAt: START });
});

after(async () => pool.end());

describe("PostgreSQL economic identity", () => {
  it("creates optional one-to-one identities with safe defaults and optimistic updates", async () => {
    assert.equal(await economic.findEconomicIdentity(ACCOUNT_A), undefined);
    const created = await economic.upsertEconomicIdentity({
      accountId: ACCOUNT_A, accountType: "PERSONAL", username: "Alice_01",
      normalizedUsername: "alice_01", displayName: "Alice", discoverability: "PRIVATE", occurredAt: START,
    });
    assert.equal(created.identity.verificationState, "UNVERIFIED");
    assert.equal(created.identity.payabilityState, "UNAVAILABLE");
    const updated = await economic.upsertEconomicIdentity({
      accountId: ACCOUNT_A, expectedVersion: 0n, accountType: "CREATOR", username: "Alice_01",
      normalizedUsername: "alice_01", displayName: "Alice Creator", discoverability: "USERNAME_ONLY",
      occurredAt: LATER,
    });
    assert.equal(updated.identity.version, 1n);
    await assert.rejects(() => economic.upsertEconomicIdentity({
      accountId: ACCOUNT_A, expectedVersion: 0n, accountType: "PERSONAL", username: "Alice_01",
      normalizedUsername: "alice_01", displayName: "Stale", discoverability: "PRIVATE",
    }), EconomicIdentityVersionConflictError);
  });

  it("enforces normalized username uniqueness in PostgreSQL", async () => {
    const results = await Promise.allSettled([
      economic.upsertEconomicIdentity({ accountId: ACCOUNT_A, accountType: "PERSONAL", username: "Shared_01", normalizedUsername: "shared_01", displayName: "A", discoverability: "PRIVATE" }),
      economic.upsertEconomicIdentity({ accountId: ACCOUNT_B, accountType: "BUSINESS", username: "shared_01", normalizedUsername: "shared_01", displayName: "B", discoverability: "PRIVATE" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason instanceof UsernameConflictError);
  });

  it("enforces destination ownership linkage, address uniqueness, and one primary", async () => {
    const first = await economic.upsertSolanaDestination({ destinationId: randomUUID(), accountId: ACCOUNT_A, address: WALLET_A, primary: true });
    assert.equal(first.destination.ownershipState, "UNVERIFIED");
    await assert.rejects(() => economic.upsertSolanaDestination({ destinationId: randomUUID(), accountId: ACCOUNT_B, address: WALLET_A, primary: true }), PaymentDestinationConflictError);
    const second = await economic.upsertSolanaDestination({ destinationId: randomUUID(), accountId: ACCOUNT_A, address: WALLET_B, primary: true });
    const destinations = await economic.listPaymentDestinations(ACCOUNT_A);
    assert.equal(destinations.filter((destination) => destination.primary).length, 1);
    assert.equal(destinations.find((destination) => destination.primary)?.destinationId, second.destination.destinationId);
    await assert.rejects(() => economic.upsertSolanaDestination({ destinationId: randomUUID(), accountId: randomUUID(), address: "7YttLkHDoNj9wyDur5L6e4wR9HkT5QEdW8ZVQ7L7d7Jy", primary: true }));
  });

  it("supports system-controlled state without exposing it through user upserts", async () => {
    const created = (await economic.upsertEconomicIdentity({ accountId: ACCOUNT_A, accountType: "PERSONAL", username: "State_01", normalizedUsername: "state_01", displayName: "State", discoverability: "USERNAME_ONLY" })).identity;
    const controlled = await economic.updateEconomicIdentityState({ accountId: ACCOUNT_A, expectedVersion: created.version, publicIdentityStatus: "ACTIVE", verificationState: "PENDING", payabilityState: "AVAILABLE" });
    assert.equal(controlled.verificationState, "PENDING");
    assert.equal(controlled.payabilityState, "AVAILABLE");
  });
});
