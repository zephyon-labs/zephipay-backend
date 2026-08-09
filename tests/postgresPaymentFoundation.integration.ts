import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { Pool } from "pg";

import type { CreatePaymentInput } from "../src/payments/paymentTypes";
import { actorSubjectForAccount } from "../src/identity/identityTypes";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { PaymentIntentApplicationError, PaymentIntentService } from "../src/services/paymentIntentService";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresPaymentPersistence } from "../src/storage/postgres/postgresPaymentPersistence";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const storage = new PostgresPaymentPersistence(pool);
const identityStorage = new PostgresIdentityPersistence(pool);
const accounts = new AccountProvisioningService(identityStorage);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-08-01T12:00:00.000Z";
const MINT = "integration-mint";
const RECIPIENT = "integration-recipient";
const MIGRATION_LOCK_ID = "827346192045711001";
const INTEGRATION_ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const INTEGRATION_ACCOUNT_TWO_ID = "10000000-0000-4000-8000-000000000002";
const INTEGRATION_ACTOR = actorSubjectForAccount(INTEGRATION_ACCOUNT_ID);
const INTEGRATION_ACTOR_TWO = actorSubjectForAccount(INTEGRATION_ACCOUNT_TWO_ID);

function input(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  return {
    id: randomUUID(),
    actorSubject: INTEGRATION_ACTOR,
    idempotencyKey: `integration-key-${randomUUID()}`,
    requestHash: HASH_A,
    network: "solana-devnet",
    rail: "solana",
    asset: "USDC",
    mintAddress: MINT,
    recipientAddress: RECIPIENT,
    amountRaw: 9_007_199_254_740_993n,
    purpose: "PostgreSQL integration",
    ...overrides,
  };
}

async function processingPayment(createInput = input()) {
  const claim = await storage.claimIdempotencyKey(createInput);
  assert.equal(claim.outcome, "CLAIMED");
  return storage.transitionPayment({
    paymentId: claim.payment.id,
    expectedVersion: claim.payment.version,
    toStatus: "PROCESSING",
    evidence: { userConfirmedAt: NOW, executionStartedAt: NOW },
  });
}

before(async () => {
  const migration = await pool.query(
    "SELECT checksum FROM payment_schema_migrations WHERE version='001_payment_foundation.sql'",
  );
  assert.equal(migration.rows.length, 1);
  assert.match(migration.rows[0].checksum, /^[a-f0-9]{64}$/);
});

beforeEach(async () => {
  await pool.query("TRUNCATE payment_events, payment_receipts, payments, beta_allowlist, accounts RESTART IDENTITY CASCADE");
  await identityStorage.createAccount({ accountId: INTEGRATION_ACCOUNT_ID, createdAt: NOW });
  await identityStorage.createAccount({ accountId: INTEGRATION_ACCOUNT_TWO_ID, createdAt: NOW });
  await storage.createAllowlistEntry({ actorSubject: INTEGRATION_ACTOR });
  await storage.createAllowlistEntry({ actorSubject: INTEGRATION_ACTOR_TWO });
});

after(async () => {
  await pool.end();
});

describe("PostgreSQL payment foundation", () => {
  it("persists canonical null purpose without changing supplied values", async () => {
    const absent = await storage.claimIdempotencyKey(input({ purpose: null }));
    assert.equal(absent.outcome, "CLAIMED");
    assert.equal(absent.payment.purpose, null);
    const supplied = await storage.claimIdempotencyKey(input({ purpose: "Historical purpose" }));
    assert.equal(supplied.outcome, "CLAIMED");
    assert.equal(supplied.payment.purpose, "Historical purpose");
  });

  it("serializes idempotency claims and detects a hash conflict", async () => {
    const key = "integration-shared-key-0001";
    const claims = await Promise.all(Array.from({ length: 20 }, () =>
      storage.claimIdempotencyKey(input({ id: randomUUID(), idempotencyKey: key })),
    ));
    assert.equal(claims.filter(({ outcome }) => outcome === "CLAIMED").length, 1);
    assert.equal(claims.filter(({ outcome }) => outcome === "EXISTING").length, 19);
    const conflict = await storage.claimIdempotencyKey(input({
      id: randomUUID(), idempotencyKey: key, requestHash: HASH_B,
    }));
    assert.equal(conflict.outcome, "HASH_CONFLICT");
    const count = await pool.query("SELECT count(*) FROM payments WHERE idempotency_key=$1", [key]);
    assert.equal(count.rows[0].count, "1");
  });

  it("requires structured proof and preserves UNKNOWN without it", async () => {
    const processing = await processingPayment();
    const unknown = await storage.transitionPayment({
      paymentId: processing.id,
      expectedVersion: processing.version,
      toStatus: "UNKNOWN",
    });
    await assert.rejects(() => storage.transitionPayment({
      paymentId: unknown.id,
      expectedVersion: unknown.version,
      toStatus: "FAILED",
      evidence: undefined as never,
    }));
    const failed = await storage.transitionPayment({
      paymentId: unknown.id,
      expectedVersion: unknown.version,
      toStatus: "FAILED",
      evidence: {
        failedAt: NOW,
        failureCode: "CHAIN_ERROR",
        terminalProof: {
          kind: "SOLANA_TRANSACTION_ERROR",
          signature: "failed-signature",
          slot: "42",
          chainError: { custom: "6001" },
        },
      },
    });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.terminalProof?.kind, "SOLANA_TRANSACTION_ERROR");
    assert.equal((await storage.listPaymentEvents(failed.id)).at(-1)?.eventType, "SETTLEMENT_FAILED");
  });

  it("atomically completes with a matching receipt and event", async () => {
    const processing = await processingPayment();
    const result = await storage.storeVerifiedReceipt({
      paymentId: processing.id,
      expectedVersion: processing.version,
      receipt: {
        id: randomUUID(), paymentId: processing.id, network: "solana-devnet",
        programId: "program", receiptPda: "receipt-pda", solanaSignature: "signature",
        slot: 9_007_199_254_740_993n, mintAddress: MINT, recipientAddress: RECIPIENT,
        amountRaw: processing.amountRaw, onchainReference: HASH_A,
        rawReceipt: { nested: { safeInteger: "9007199254740993" } }, verifiedAt: NOW,
      },
      event: {},
    });
    assert.equal(result.payment.status, "COMPLETED");
    assert.equal(result.receipt.amountRaw, 9_007_199_254_740_993n);
    assert.equal((await storage.listPaymentEvents(processing.id)).at(-1)?.eventType, "RECEIPT_VERIFIED");
  });

  it("rolls back mismatched/duplicate receipts and enforces append-only tables", async () => {
    const first = await processingPayment();
    await assert.rejects(() => storage.storeVerifiedReceipt({
      paymentId: first.id,
      expectedVersion: first.version,
      receipt: {
        id: randomUUID(), paymentId: first.id, network: "solana-devnet",
        programId: "program", receiptPda: "bad-pda", solanaSignature: "bad-signature",
        slot: 1n, mintAddress: "wrong-mint", recipientAddress: RECIPIENT,
        amountRaw: first.amountRaw, onchainReference: HASH_A, rawReceipt: {}, verifiedAt: NOW,
      },
      event: {},
    }));
    assert.equal((await storage.findPayment(first.id))?.status, "PROCESSING");
    assert.equal(await storage.findReceiptByPaymentId(first.id), undefined);

    const completed = await storage.storeVerifiedReceipt({
      paymentId: first.id,
      expectedVersion: first.version,
      receipt: {
        id: randomUUID(), paymentId: first.id, network: "solana-devnet",
        programId: "program", receiptPda: "unique-pda", solanaSignature: "unique-signature",
        slot: 1n, mintAddress: MINT, recipientAddress: RECIPIENT,
        amountRaw: first.amountRaw, onchainReference: HASH_A, rawReceipt: {}, verifiedAt: NOW,
      },
      event: { runtimeEventId: "receipt-event-1" },
    });
    const second = await processingPayment(input({
      id: randomUUID(),
      idempotencyKey: "integration-second-payment",
      requestHash: HASH_B,
    }));
    const receiptForSecond = (receiptPda: string, solanaSignature: string) => ({
      paymentId: second.id,
      expectedVersion: second.version,
      receipt: {
        id: randomUUID(), paymentId: second.id, network: "solana-devnet" as const,
        programId: "program", receiptPda, solanaSignature,
        slot: 2n, mintAddress: MINT, recipientAddress: RECIPIENT,
        amountRaw: second.amountRaw, onchainReference: HASH_B, rawReceipt: {}, verifiedAt: NOW,
      },
      event: {},
    });
    await assert.rejects(() => storage.storeVerifiedReceipt(
      receiptForSecond("different-pda", "unique-signature"),
    ));
    await assert.rejects(() => storage.storeVerifiedReceipt(
      receiptForSecond("unique-pda", "different-signature"),
    ));
    await assert.rejects(() => pool.query("UPDATE payment_receipts SET program_id='changed' WHERE payment_id=$1", [first.id]));
    await assert.rejects(() => pool.query("DELETE FROM payment_events WHERE payment_id=$1", [first.id]));
    await assert.rejects(() => storage.transitionPayment({
      paymentId: first.id, expectedVersion: completed.payment.version,
      toStatus: "FAILED",
      evidence: {
        failedAt: NOW, failureCode: "NO",
        terminalProof: { kind: "SOLANA_TRANSACTION_ERROR", signature: "unique-signature", chainError: {} },
      },
    }));
  });

  it("rejects lifecycle version bypass and duplicate runtime event IDs", async () => {
    const processing = await processingPayment();
    await assert.rejects(() => pool.query(
      "UPDATE payments SET last_checked_at=now() WHERE id=$1",
      [processing.id],
    ));
    await storage.appendInformationalEvent({
      paymentId: processing.id, eventType: "RUNTIME_APPROVED", runtimeEventId: "runtime-duplicate",
    });
    await assert.rejects(() => storage.appendInformationalEvent({
      paymentId: processing.id, eventType: "RUNTIME_APPROVED", runtimeEventId: "runtime-duplicate",
    }));
    await assert.rejects(() => pool.query(
      `INSERT INTO payment_events(payment_id,sequence_number,event_type,to_status,details)
       SELECT $1,COALESCE(MAX(sequence_number),0)+1,'RECEIPT_VERIFIED','COMPLETED','{}'::jsonb
       FROM payment_events WHERE payment_id=$1`,
      [processing.id],
    ));
  });

  it("rejects a direct status transition without its matching lifecycle event", async () => {
    const processing = await processingPayment();
    await assert.rejects(() => pool.query(
      "UPDATE payments SET status='UNKNOWN', version=version+1, updated_at=now() WHERE id=$1",
      [processing.id],
    ));
    assert.equal((await storage.findPayment(processing.id))?.status, "PROCESSING");
  });

  it("holds one advisory lock owner and rolls back bookkeeping on failure", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
      const contender = await second.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [MIGRATION_LOCK_ID]);
      assert.equal(contender.rows[0].acquired, false);
      await first.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      await second.query("BEGIN");
      await second.query(
        "INSERT INTO payment_schema_migrations(version,checksum) VALUES ('rollback-test','test')",
      );
      await second.query("ROLLBACK");
      const absent = await pool.query("SELECT 1 FROM payment_schema_migrations WHERE version='rollback-test'");
      assert.equal(absent.rows.length, 0);
    } finally {
      first.release();
      second.release();
    }
  });
});

describe("PostgreSQL authenticated payment intents", () => {
  async function serviceFixture(options: { enabled?: boolean; expiresAt?: string; clock?: () => string } = {}) {
    const principal = {
      issuer: "https://integration.example/",
      providerSubject: `auth0|${randomUUID()}`,
      scopes: ["read:payments", "write:payments"],
    } as const;
    const account = (await accounts.resolve(principal)).account;
    await storage.createAllowlistEntry({
      actorSubject: account.actorSubject,
      enabled: options.enabled,
      expiresAt: options.expiresAt,
    });
    return {
      principal,
      account,
      service: new PaymentIntentService(accounts, storage, { clock: options.clock }),
    };
  }

  const serviceInput = (key: string) => ({
    idempotencyKey: key,
    recipient: RECIPIENT,
    amount: "1.000001",
    purpose: "Authenticated integration",
  });

  it("creates for a canonical account with active beta access and enforces ownership", async () => {
    const first = await serviceFixture();
    const created = await first.service.create(first.principal, serviceInput("service-active-key-0001"));
    assert.equal(created.paymentIntent.status, "awaiting_confirmation");
    assert.equal(created.paymentIntent.amountRaw, "1000001");
    const other = await serviceFixture();
    await assert.rejects(() => other.service.find(other.principal, created.paymentIntent.id), (error) =>
      error instanceof PaymentIntentApplicationError && error.kind === "NOT_FOUND");
  });

  it("denies disabled, revoked, and expired beta access", async () => {
    const disabled = await serviceFixture({ enabled: false });
    await assert.rejects(() => disabled.service.create(disabled.principal, serviceInput("service-disabled-key-01")), /Beta payment access/);

    const revoked = await serviceFixture();
    await pool.query(
      "UPDATE beta_allowlist SET enabled=false, revoked_at=now() WHERE actor_subject=$1",
      [revoked.account.actorSubject],
    );
    await assert.rejects(() => revoked.service.create(revoked.principal, serviceInput("service-revoked-key-001")), /Beta payment access/);

    const expired = await serviceFixture({
      expiresAt: "2030-01-01T00:00:00.000Z",
      clock: () => "2031-01-01T00:00:00.000Z",
    });
    await assert.rejects(() => expired.service.create(expired.principal, serviceInput("service-expired-key-001")), /Beta payment access/);
  });

  it("converges concurrent creates and confirmations with one USER_CONFIRMED event", async () => {
    const fixture = await serviceFixture();
    const key = "service-concurrent-key-01";
    const creates = await Promise.all(Array.from({ length: 20 }, () =>
      fixture.service.create(fixture.principal, serviceInput(key))));
    assert.equal(creates.filter(({ created }) => created).length, 1);
    const payment = creates[0].paymentIntent;
    const confirmations = await Promise.all(Array.from({ length: 20 }, () =>
      fixture.service.confirm(fixture.principal, {
        paymentId: payment.id,
        requestHash: payment.requestHash,
        expectedVersion: 0n,
      })));
    assert.equal(confirmations.filter(({ applied }) => applied).length, 1);
    assert.equal(confirmations.filter(({ applied }) => !applied).length, 19);
    const events = await storage.listPaymentEvents(payment.id);
    assert.equal(events.filter(({ eventType }) => eventType === "USER_CONFIRMED").length, 1);
  });
});
