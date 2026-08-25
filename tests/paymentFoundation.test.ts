import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDatabaseUrl } from "../src/config/environment";
import { InvalidPaymentTransitionError, validatePaymentTransition } from "../src/payments/paymentLifecycle";
import { createPaymentIdentityRequestHash, createPaymentRequestHash, validateRequestHash } from "../src/payments/requestHash";
import type { CreatePaymentInput, PaymentStatus } from "../src/payments/paymentTypes";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const START = "2026-08-01T12:00:00.000Z";
const MINT = "mint-address";
const RECIPIENT = "recipient-address";

function paymentInput(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    actorSubject: "actor-one",
    idempotencyKey: "idempotency-key-0001",
    requestHash: HASH_A,
    network: "solana-devnet",
    rail: "solana",
    asset: "USDC",
    mintAddress: MINT,
    recipientAddress: RECIPIENT,
    amountRaw: 9_007_199_254_740_993n,
    purpose: "Precision test",
    ...overrides,
  };
}

async function persistence(...actors: string[]): Promise<InMemoryPaymentPersistence> {
  const storage = new InMemoryPaymentPersistence({ clock: () => START });
  for (const actorSubject of actors.length > 0 ? actors : ["actor-one"]) {
    await storage.createAllowlistEntry({ actorSubject });
  }
  return storage;
}

describe("payment lifecycle", () => {
  it("accepts every documented transition with required proof", () => {
    validatePaymentTransition("AWAITING_CONFIRMATION", "PROCESSING", {
      userConfirmedAt: START,
      executionStartedAt: START,
    });
    validatePaymentTransition("AWAITING_CONFIRMATION", "FAILED", {
      failedAt: START,
      failureCode: "REJECTED",
      terminalProof: { kind: "PRE_SUBMISSION_REJECTION", code: "REJECTED", reason: "Rejected before submission." },
    });
    validatePaymentTransition("PROCESSING", "UNKNOWN");
    const failure = {
      failedAt: START,
      failureCode: "CHAIN_ERROR",
      terminalProof: {
        kind: "SOLANA_TRANSACTION_ERROR" as const,
        signature: "signature",
        slot: "42",
        chainError: { instructionError: "custom" },
      },
    };
    validatePaymentTransition("PROCESSING", "FAILED", failure);
    validatePaymentTransition("UNKNOWN", "FAILED", failure);
  });

  it("rejects every undocumented status pair", () => {
    const statuses: PaymentStatus[] = ["AWAITING_CONFIRMATION", "PROCESSING", "UNKNOWN", "COMPLETED", "FAILED"];
    const legal = new Set([
      "AWAITING_CONFIRMATION:PROCESSING", "AWAITING_CONFIRMATION:FAILED",
      "PROCESSING:UNKNOWN", "PROCESSING:COMPLETED", "PROCESSING:FAILED",
      "UNKNOWN:COMPLETED", "UNKNOWN:FAILED",
    ]);
    for (const from of statuses) {
      for (const to of statuses) {
        if (legal.has(`${from}:${to}`)) continue;
        assert.throws(() => validatePaymentTransition(from, to, {}), InvalidPaymentTransitionError);
      }
    }
  });

  it("protects UNKNOWN and terminal states", () => {
    assert.throws(() => validatePaymentTransition("UNKNOWN", "PROCESSING"), InvalidPaymentTransitionError);
    assert.throws(() => validatePaymentTransition("UNKNOWN", "FAILED"), /terminal proof/);
    assert.throws(() => validatePaymentTransition("COMPLETED", "FAILED", {
      failedAt: START, failureCode: "REJECTED",
      terminalProof: { kind: "PRE_SUBMISSION_REJECTION", code: "REJECTED", reason: "No." },
    }));
    assert.throws(() => validatePaymentTransition("FAILED", "PROCESSING"));
  });
});

describe("request hashing and configuration", () => {
  it("validates hashes and hashes bigint amounts without precision loss", () => {
    const hash = createPaymentRequestHash({
      actorSubject: "actor-one",
      network: "solana-devnet",
      mintAddress: MINT,
      recipientAddress: RECIPIENT,
      amountRaw: 9_007_199_254_740_993n,
      purpose: "Precision test",
    });
    validateRequestHash(hash);
    assert.equal(hash.length, 64);
    assert.throws(() => validateRequestHash("ABC"));
  });

  it("canonicalizes frozen Payment Identity snapshots independently of JSON object key order", () => {
    const snapshot = {
      accountId: "recipient-account", username: "recipient", displayName: "Recipient",
      accountType: "PERSONAL" as const, verificationState: "VERIFIED" as const,
      payabilityState: "AVAILABLE" as const, capturedAt: START, schemaVersion: 1 as const,
      identitySource: "RECIPIENT_DIRECTORY" as const, resolutionSource: "RECIPIENT_DIRECTORY" as const,
      trustOutcome: "NOT_REQUIRED" as const,
    };
    const reordered = JSON.parse(JSON.stringify(snapshot, Object.keys(snapshot).sort())) as typeof snapshot;
    const canonical = { actorSubject: "actor-one", network: "solana-devnet" as const,
      mintAddress: MINT, recipientAddress: RECIPIENT, amountRaw: 1_000_000n, purpose: null,
      recipientAccountId: snapshot.accountId, trustConfirmationOutcome: "NOT_REQUIRED" as const };
    assert.equal(
      createPaymentIdentityRequestHash({ ...canonical, recipientSnapshot: snapshot }),
      createPaymentIdentityRequestHash({ ...canonical, recipientSnapshot: reordered }),
    );
  });

  it("requires a valid database URL only when PostgreSQL is enabled", () => {
    assert.equal(parseDatabaseUrl(false, undefined), undefined);
    assert.equal(parseDatabaseUrl(true, "postgresql://user:pass@db.example/test"), "postgresql://user:pass@db.example/test");
    assert.throws(() => parseDatabaseUrl(true, undefined));
    assert.throws(() => parseDatabaseUrl(true, "https://db.example/test"));
  });
});

describe("deterministic in-memory payment persistence", () => {
  it("rejects authoritative events through the informational telemetry surface", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    await assert.rejects(() => storage.appendInformationalEvent({
      paymentId: claim.payment.id,
      eventType: "SETTLEMENT_CONFIRMED" as never,
    }), /reserved/);
  });

  it("claims same actor/key/hash once and detects hash conflict", async () => {
    const storage = await persistence();
    const claimed = await storage.claimIdempotencyKey(paymentInput());
    const existing = await storage.claimIdempotencyKey(paymentInput({ id: "00000000-0000-4000-8000-000000000002" }));
    const conflict = await storage.claimIdempotencyKey(paymentInput({ id: "00000000-0000-4000-8000-000000000003", requestHash: HASH_B }));
    assert.equal(claimed.outcome, "CLAIMED");
    assert.equal(existing.outcome, "EXISTING");
    assert.equal(conflict.outcome, "HASH_CONFLICT");
    assert.equal(existing.payment.id, claimed.payment.id);
  });

  it("allows different actors to reuse an idempotency key", async () => {
    const storage = await persistence("actor-one", "actor-two");
    const first = await storage.claimIdempotencyKey(paymentInput());
    const second = await storage.claimIdempotencyKey(paymentInput({
      id: "00000000-0000-4000-8000-000000000002",
      actorSubject: "actor-two",
    }));
    assert.equal(first.outcome, "CLAIMED");
    assert.equal(second.outcome, "CLAIMED");
  });

  it("serializes concurrent claims deterministically", async () => {
    const storage = await persistence();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      storage.claimIdempotencyKey(paymentInput({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` })),
    ));
    assert.equal(results.filter(({ outcome }) => outcome === "CLAIMED").length, 1);
    assert.equal(results.filter(({ outcome }) => outcome === "EXISTING").length, 19);
  });

  it("preserves bigint precision and ordered append-only events", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    assert.equal(claim.payment.amountRaw, 9_007_199_254_740_993n);
    await storage.appendInformationalEvent({ paymentId: claim.payment.id, eventType: "RUNTIME_APPROVED" });
    const events = await storage.listPaymentEvents(claim.payment.id);
    assert.deepEqual(events.map(({ sequenceNumber }) => sequenceNumber), [1, 2]);
    assert.deepEqual(events.map(({ eventType }) => eventType), ["CREATED", "RUNTIME_APPROVED"]);
    assert.ok(Object.isFrozen(events[0]));
  });

  it("completes payment, receipt, and event atomically", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    const processing = await storage.transitionPayment({
      paymentId: claim.payment.id,
      expectedVersion: 0n,
      toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    });
    const result = await storage.storeVerifiedReceipt({
      paymentId: processing.id,
      expectedVersion: processing.version,
      receipt: {
        id: "00000000-0000-4000-8000-000000000099",
        paymentId: processing.id,
        network: "solana-devnet",
        programId: "program",
        receiptPda: "receipt-pda",
        solanaSignature: "signature",
        slot: 9_007_199_254_740_993n,
        mintAddress: MINT,
        recipientAddress: RECIPIENT,
        amountRaw: processing.amountRaw,
        onchainReference: HASH_A,
        rawReceipt: { verified: true },
        verifiedAt: START,
      },
      event: {},
    });
    assert.equal(result.payment.status, "COMPLETED");
    assert.equal(result.receipt.slot, 9_007_199_254_740_993n);
    assert.equal((await storage.listPaymentEvents(processing.id)).at(-1)?.eventType, "RECEIPT_VERIFIED");
    await assert.rejects(() => storage.transitionPayment({
      paymentId: processing.id,
      expectedVersion: result.payment.version,
      toStatus: "FAILED",
      evidence: {
        failedAt: START,
        failureCode: "CHAIN_FAILURE",
        terminalProof: {
          kind: "SOLANA_TRANSACTION_ERROR",
          signature: "signature",
          chainError: { custom: 1 },
        },
      },
    }));
  });

  it("rolls back an invalid receipt insertion", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    const processing = await storage.transitionPayment({
      paymentId: claim.payment.id,
      expectedVersion: 0n,
      toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    });
    await assert.rejects(() => storage.storeVerifiedReceipt({
      paymentId: processing.id,
      expectedVersion: processing.version,
      receipt: {
        id: "00000000-0000-4000-8000-000000000099", paymentId: processing.id,
        network: "solana-devnet", programId: "program", receiptPda: "receipt-pda",
        solanaSignature: "signature", slot: 1n, mintAddress: "wrong-mint",
        recipientAddress: RECIPIENT, amountRaw: processing.amountRaw,
        onchainReference: HASH_A, rawReceipt: {}, verifiedAt: START,
      },
      event: {},
    }));
    assert.equal(await storage.findReceiptByPaymentId(processing.id), undefined);
    assert.equal((await storage.findPayment(processing.id))?.status, "PROCESSING");
    assert.equal((await storage.listPaymentEvents(processing.id)).length, 2);
  });

  it("requires terminal proof for failure and keeps UNKNOWN out of processing", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    const processing = await storage.transitionPayment({
      paymentId: claim.payment.id, expectedVersion: 0n, toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    });
    const unknown = await storage.transitionPayment({
      paymentId: processing.id, expectedVersion: 1n, toStatus: "UNKNOWN",
    });
    await assert.rejects(() => storage.transitionPayment({
      paymentId: unknown.id, expectedVersion: unknown.version, toStatus: "FAILED",
      evidence: undefined as never,
    }), /terminal proof/);
    await assert.rejects(() => storage.transitionPayment({
      paymentId: unknown.id, expectedVersion: unknown.version, toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    }));
    assert.equal((await storage.findPayment(unknown.id))?.status, "UNKNOWN");
  });

  it("persists structured proof in the derived canonical failure event", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    const processing = await storage.transitionPayment({
      paymentId: claim.payment.id,
      expectedVersion: 0n,
      toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    });
    const failed = await storage.transitionPayment({
      paymentId: processing.id,
      expectedVersion: processing.version,
      toStatus: "FAILED",
      evidence: {
        failedAt: START,
        failureCode: "SOLANA_ERROR",
        terminalProof: {
          kind: "SOLANA_TRANSACTION_ERROR",
          signature: "failed-signature",
          slot: "9007199254740993",
          chainError: { instruction: { custom: "42" } },
        },
      },
    });
    assert.equal(failed.terminalProof?.kind, "SOLANA_TRANSACTION_ERROR");
    assert.equal(failed.submittedSlot, 9_007_199_254_740_993n);
    const failureEvent = (await storage.listPaymentEvents(failed.id)).at(-1);
    assert.equal(failureEvent?.eventType, "SETTLEMENT_FAILED");
    assert.deepEqual(failureEvent?.details.terminalProof, failed.terminalProof);
  });

  it("enforces global signature, receipt PDA, and runtime event ID uniqueness", async () => {
    const storage = await persistence("actor-one", "actor-two");
    const firstClaim = await storage.claimIdempotencyKey(paymentInput());
    const secondClaim = await storage.claimIdempotencyKey(paymentInput({
      id: "00000000-0000-4000-8000-000000000002",
      actorSubject: "actor-two",
      idempotencyKey: "idempotency-key-0002",
      requestHash: HASH_B,
    }));
    const first = await storage.transitionPayment({
      paymentId: firstClaim.payment.id, expectedVersion: 0n, toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    });
    const second = await storage.transitionPayment({
      paymentId: secondClaim.payment.id, expectedVersion: 0n, toStatus: "PROCESSING",
      evidence: { userConfirmedAt: START, executionStartedAt: START },
    });
    await storage.recordSignatureObservation({
      paymentId: first.id, expectedVersion: first.version,
      solanaSignature: "unique-signature", submittedAt: START,
    });
    await assert.rejects(() => storage.recordSignatureObservation({
      paymentId: second.id, expectedVersion: second.version,
      solanaSignature: "unique-signature", submittedAt: START,
    }), /already exists/);
    const firstAfterSignature = await storage.findPayment(first.id);
    assert.ok(firstAfterSignature);
    await storage.storeVerifiedReceipt({
      paymentId: first.id,
      expectedVersion: firstAfterSignature.version,
      receipt: {
        id: "00000000-0000-4000-8000-000000000091",
        paymentId: first.id, network: "solana-devnet", programId: "program",
        receiptPda: "globally-unique-pda", solanaSignature: "unique-signature",
        slot: 1n, mintAddress: MINT, recipientAddress: RECIPIENT,
        amountRaw: first.amountRaw, onchainReference: HASH_A, rawReceipt: {}, verifiedAt: START,
      },
      event: {},
    });
    await assert.rejects(() => storage.storeVerifiedReceipt({
      paymentId: second.id,
      expectedVersion: second.version,
      receipt: {
        id: "00000000-0000-4000-8000-000000000092",
        paymentId: second.id, network: "solana-devnet", programId: "program",
        receiptPda: "globally-unique-pda", solanaSignature: "different-signature",
        slot: 2n, mintAddress: MINT, recipientAddress: RECIPIENT,
        amountRaw: second.amountRaw, onchainReference: HASH_B, rawReceipt: {}, verifiedAt: START,
      },
      event: {},
    }), /already exists/);
    await storage.appendInformationalEvent({
      paymentId: first.id, eventType: "RUNTIME_APPROVED", runtimeEventId: "runtime-event-1",
    });
    await assert.rejects(() => storage.appendInformationalEvent({
      paymentId: second.id, eventType: "RUNTIME_APPROVED", runtimeEventId: "runtime-event-1",
    }), /already exists/);
  });

  it("deep-clones JSON values on writes and reads", async () => {
    const storage = await persistence();
    const claim = await storage.claimIdempotencyKey(paymentInput());
    const details = { nested: { value: "original" } };
    await storage.appendInformationalEvent({
      paymentId: claim.payment.id,
      eventType: "RUNTIME_APPROVED",
      details,
    });
    details.nested.value = "mutated";
    const firstRead = await storage.listPaymentEvents(claim.payment.id);
    assert.deepEqual(firstRead.at(-1)?.details, { nested: { value: "original" } });
    (firstRead.at(-1)?.details.nested as { value: string }).value = "read-mutation";
    const secondRead = await storage.listPaymentEvents(claim.payment.id);
    assert.deepEqual(secondRead.at(-1)?.details, { nested: { value: "original" } });
  });

  it("validates PostgreSQL-compatible bounded input constraints", async () => {
    const storage = await persistence();
    await assert.rejects(() => storage.claimIdempotencyKey(paymentInput({ purpose: "x".repeat(121) })));
    await assert.rejects(() => storage.claimIdempotencyKey(paymentInput({ amountRaw: 0n })));
    await assert.rejects(() => storage.claimIdempotencyKey(paymentInput({ idempotencyKey: "short" })));
    await assert.rejects(() => storage.createAllowlistEntry({
      actorSubject: "actor-expired",
      expiresAt: "2026-08-01T11:59:59.000Z",
    }));
  });
});
