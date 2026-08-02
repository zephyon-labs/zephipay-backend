import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { actorSubjectForAccount } from "../src/identity/identityTypes";
import {
  AccountVersionConflictError,
  ExternalIdentityConflictError,
} from "../src/identity/identityStorageContracts";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const ACCOUNT_A = "00000000-0000-4000-8000-000000000101";
const ACCOUNT_B = "00000000-0000-4000-8000-000000000102";
const IDENTITY_A = "00000000-0000-4000-8000-000000000201";
const IDENTITY_B = "00000000-0000-4000-8000-000000000202";
const SESSION_A = "00000000-0000-4000-8000-000000000301";
const START = "2026-08-02T12:00:00.000Z";
const LATER = "2026-08-02T13:00:00.000Z";
const EXPIRES = "2026-08-03T12:00:00.000Z";

function persistence(): InMemoryIdentityPersistence {
  return new InMemoryIdentityPersistence({ clock: () => START });
}

describe("canonical account identity", () => {
  it("derives a stable ZephiPay-owned actor subject", async () => {
    const storage = persistence();
    const account = await storage.createAccount({ accountId: ACCOUNT_A });
    assert.equal(account.actorSubject, `zp:account:${ACCOUNT_A}`);
    assert.equal(actorSubjectForAccount(ACCOUNT_A.toUpperCase()), account.actorSubject);
    assert.equal(account.version, 0n);
    assert.deepEqual(await storage.findAccountByActorSubject(account.actorSubject), account);
    assert.ok(Object.isFrozen(account));
  });

  it("enforces optimistic concurrency and deterministic account events", async () => {
    const storage = persistence();
    await storage.createAccount({ accountId: ACCOUNT_A });
    const updated = await storage.updateAccountStatus({
      accountId: ACCOUNT_A, expectedVersion: 0n, status: "SUSPENDED", occurredAt: LATER,
    });
    assert.equal(updated.version, 1n);
    await assert.rejects(() => storage.updateAccountStatus({
      accountId: ACCOUNT_A, expectedVersion: 0n, status: "ACTIVE",
    }), AccountVersionConflictError);
    const events = await storage.listAccountSecurityEvents(ACCOUNT_A);
    assert.deepEqual(events.map(({ eventType, accountVersion }) => [eventType, accountVersion]), [
      ["ACCOUNT_CREATED", 0n], ["ACCOUNT_STATUS_CHANGED", 1n],
    ]);
    assert.deepEqual(events[1].details, { previousStatus: "ACTIVE", status: "SUSPENDED" });
    assert.ok(Object.isFrozen(events[1]));
  });
});

describe("external identity links", () => {
  it("links issuer and subject without using email or provider IDs as account identity", async () => {
    const storage = persistence();
    await storage.createAccount({ accountId: ACCOUNT_A });
    const result = await storage.linkExternalIdentity({
      identityId: IDENTITY_A, accountId: ACCOUNT_A, expectedAccountVersion: 0n,
      issuer: "https://identity.example", subject: "provider-user-1", linkedAt: LATER,
    });
    assert.equal(result.account.version, 1n);
    assert.equal(result.identity.accountId, ACCOUNT_A);
    assert.equal(result.account.actorSubject, `zp:account:${ACCOUNT_A}`);
    assert.deepEqual(await storage.findExternalIdentity(
      "https://identity.example", "provider-user-1",
    ), result.identity);
  });

  it("serializes concurrent links and enforces global issuer/subject uniqueness", async () => {
    const storage = persistence();
    await storage.createAccount({ accountId: ACCOUNT_A });
    await storage.createAccount({ accountId: ACCOUNT_B });
    const results = await Promise.allSettled([
      storage.linkExternalIdentity({
        identityId: IDENTITY_A, accountId: ACCOUNT_A, expectedAccountVersion: 0n,
        issuer: "https://identity.example", subject: "shared-subject",
      }),
      storage.linkExternalIdentity({
        identityId: IDENTITY_B, accountId: ACCOUNT_B, expectedAccountVersion: 0n,
        issuer: "https://identity.example", subject: "shared-subject",
      }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejection = results.find(({ status }) => status === "rejected");
    assert.ok(rejection?.status === "rejected");
    assert.ok(rejection.reason instanceof ExternalIdentityConflictError);
  });
});

describe("account sessions and security events", () => {
  it("creates and irreversibly revokes a session with versioned events", async () => {
    const storage = persistence();
    await storage.createAccount({ accountId: ACCOUNT_A });
    const created = await storage.createAccountSession({
      sessionId: SESSION_A, accountId: ACCOUNT_A, expectedAccountVersion: 0n,
      createdAt: START, expiresAt: EXPIRES,
    });
    const revoked = await storage.revokeAccountSession({
      sessionId: SESSION_A, accountId: ACCOUNT_A,
      expectedAccountVersion: created.account.version, revokedAt: LATER,
    });
    assert.equal(revoked.session.revokedAt, LATER);
    assert.equal(revoked.account.version, 2n);
    await assert.rejects(() => storage.revokeAccountSession({
      sessionId: SESSION_A, accountId: ACCOUNT_A,
      expectedAccountVersion: revoked.account.version, revokedAt: LATER,
    }), /already revoked/);
    const events = await storage.listAccountSecurityEvents(ACCOUNT_A);
    assert.deepEqual(events.map(({ eventType }) => eventType), [
      "ACCOUNT_CREATED", "SESSION_CREATED", "SESSION_REVOKED",
    ]);
  });

  it("matches PostgreSQL-compatible input constraints", async () => {
    const storage = persistence();
    await assert.rejects(() => storage.createAccount({ accountId: "not-a-uuid" }));
    await storage.createAccount({ accountId: ACCOUNT_A });
    await assert.rejects(() => storage.linkExternalIdentity({
      identityId: IDENTITY_A, accountId: ACCOUNT_A, expectedAccountVersion: 0n,
      issuer: " issuer ", subject: "subject",
    }));
    await assert.rejects(() => storage.createAccountSession({
      sessionId: SESSION_A, accountId: ACCOUNT_A, expectedAccountVersion: 0n,
      createdAt: START, expiresAt: START,
    }), /after creation/);
  });
});
