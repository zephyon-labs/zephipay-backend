import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { Pool } from "pg";

import {
  AccountVersionConflictError,
  ExternalIdentityConflictError,
} from "../src/identity/identityStorageContracts";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const storage = new PostgresIdentityPersistence(pool);
const ACCOUNT_A = "00000000-0000-4000-8000-000000000501";
const ACCOUNT_B = "00000000-0000-4000-8000-000000000502";
const START = "2026-08-02T12:00:00.000Z";
const LATER = "2026-08-02T13:00:00.000Z";
const EXPIRES = "2026-08-03T12:00:00.000Z";

before(async () => {
  const migration = await pool.query(
    "SELECT checksum FROM payment_schema_migrations WHERE version='002_identity_foundation.sql'",
  );
  assert.equal(migration.rows.length, 1);
  assert.match(migration.rows[0].checksum, /^[a-f0-9]{64}$/);
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE account_security_events, account_sessions, external_identities, accounts RESTART IDENTITY CASCADE",
  );
});

after(async () => {
  await pool.end();
});

describe("PostgreSQL identity foundation", () => {
  it("creates a canonical account and enforces optimistic concurrency", async () => {
    const account = await storage.createAccount({ accountId: ACCOUNT_A, createdAt: START });
    assert.equal(account.actorSubject, `zp:account:${ACCOUNT_A}`);
    assert.equal(account.version, 0n);
    const first = await storage.updateAccountStatus({
      accountId: ACCOUNT_A, expectedVersion: 0n, status: "SUSPENDED", occurredAt: LATER,
    });
    assert.equal(first.version, 1n);
    await assert.rejects(() => storage.updateAccountStatus({
      accountId: ACCOUNT_A, expectedVersion: 0n, status: "ACTIVE",
    }), AccountVersionConflictError);
    const events = await storage.listAccountSecurityEvents(ACCOUNT_A);
    assert.deepEqual(events.map(({ eventType, accountVersion }) => [eventType, accountVersion]), [
      ["ACCOUNT_CREATED", 0n], ["ACCOUNT_STATUS_CHANGED", 1n],
    ]);
  });

  it("enforces issuer/subject uniqueness under concurrent linking", async () => {
    await storage.createAccount({ accountId: ACCOUNT_A, createdAt: START });
    await storage.createAccount({ accountId: ACCOUNT_B, createdAt: START });
    const issuer = "https://identity.example";
    const subject = "shared-provider-subject";
    const results = await Promise.allSettled([
      storage.linkExternalIdentity({
        identityId: randomUUID(), accountId: ACCOUNT_A, expectedAccountVersion: 0n,
        issuer, subject, linkedAt: LATER,
      }),
      storage.linkExternalIdentity({
        identityId: randomUUID(), accountId: ACCOUNT_B, expectedAccountVersion: 0n,
        issuer, subject, linkedAt: LATER,
      }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejection = results.find(({ status }) => status === "rejected");
    assert.ok(rejection?.status === "rejected");
    assert.ok(rejection.reason instanceof ExternalIdentityConflictError);
    const count = await pool.query(
      "SELECT count(*) FROM external_identities WHERE issuer=$1 AND subject=$2",
      [issuer, subject],
    );
    assert.equal(count.rows[0].count, "1");
  });

  it("creates and revokes sessions atomically with security events", async () => {
    await storage.createAccount({ accountId: ACCOUNT_A, createdAt: START });
    const sessionId = randomUUID();
    const created = await storage.createAccountSession({
      sessionId, accountId: ACCOUNT_A, expectedAccountVersion: 0n,
      createdAt: START, expiresAt: EXPIRES,
    });
    const revoked = await storage.revokeAccountSession({
      sessionId, accountId: ACCOUNT_A, expectedAccountVersion: created.account.version,
      revokedAt: LATER,
    });
    assert.equal(revoked.account.version, 2n);
    assert.equal(revoked.session.revokedAt, LATER);
    assert.deepEqual((await storage.listAccountSecurityEvents(ACCOUNT_A)).map(({ eventType }) => eventType), [
      "ACCOUNT_CREATED", "SESSION_CREATED", "SESSION_REVOKED",
    ]);
  });

  it("rejects direct mutation and append-only bypasses", async () => {
    await storage.createAccount({ accountId: ACCOUNT_A, createdAt: START });
    const linked = await storage.linkExternalIdentity({
      identityId: randomUUID(), accountId: ACCOUNT_A, expectedAccountVersion: 0n,
      issuer: "https://identity.example", subject: "immutable-subject", linkedAt: LATER,
    });
    await assert.rejects(() => pool.query(
      "UPDATE external_identities SET subject='changed' WHERE identity_id=$1",
      [linked.identity.identityId],
    ));
    await assert.rejects(() => pool.query(
      "DELETE FROM account_security_events WHERE account_id=$1",
      [ACCOUNT_A],
    ));
    await assert.rejects(() => pool.query(
      "UPDATE accounts SET status='SUSPENDED',version=version+1,updated_at=now() WHERE account_id=$1",
      [ACCOUNT_A],
    ));
    assert.equal((await storage.findAccount(ACCOUNT_A))?.status, "ACTIVE");
  });

  it("rolls back identity/session mutations when event persistence fails", async () => {
    await storage.createAccount({ accountId: ACCOUNT_A, createdAt: START });
    await assert.rejects(() => pool.query(
      `INSERT INTO external_identities(identity_id,issuer,subject,account_id,linked_at)
       VALUES ($1,'https://identity.example','no-event',$2,$3)`,
      [randomUUID(), ACCOUNT_A, LATER],
    ));
    await assert.rejects(() => pool.query(
      `INSERT INTO account_sessions(session_id,account_id,created_at,expires_at)
       VALUES ($1,$2,$3,$4)`,
      [randomUUID(), ACCOUNT_A, START, EXPIRES],
    ));
    assert.equal((await storage.listExternalIdentities(ACCOUNT_A)).length, 0);
    assert.equal((await storage.listAccountSessions(ACCOUNT_A)).length, 0);
  });
});
