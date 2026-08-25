import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PaymentExecutionWorker } from "../src/executions/executionWorker";
import {
  matchesFrozenPaymentIdentityRequest,
  type PaymentIdentityReplayRequest,
} from "../src/payments/paymentIdentityReplay";
import {
  createLegacyPreMigration009PaymentIdentityRequestHash,
  createPaymentIdentityRequestHash,
} from "../src/payments/requestHash";
import type { PaymentIdentitySnapshot, PaymentRecord } from "../src/payments/paymentTypes";
import type { ClaimPaymentIdentityInput } from "../src/storage/storageContracts";
import { InMemoryExecutionRepository } from "../src/storage/memory/inMemoryExecutionRepository";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";

const NOW = "2026-08-25T12:00:00.000Z";
const ACTOR = "zp:account:00000000-0000-4000-8000-000000000701";
const OTHER_ACTOR = "zp:account:00000000-0000-4000-8000-000000000702";
const SENDER = "00000000-0000-4000-8000-000000000701";
const RECIPIENT_A = "00000000-0000-4000-8000-000000000801";
const RECIPIENT_B = "00000000-0000-4000-8000-000000000802";
const DESTINATION_D1 = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const DESTINATION_D2 = "4Nd1mYwRkXkYtGT7dQz4FzRzCQXDpGfVv3YJz7drGqPv";

const CANONICAL_SNAPSHOT: PaymentIdentitySnapshot = Object.freeze({
  accountId: RECIPIENT_A,
  username: "recipient_a",
  displayName: "Recipient A",
  accountType: "PERSONAL",
  verificationState: "UNVERIFIED",
  payabilityState: "AVAILABLE",
  capturedAt: NOW,
  schemaVersion: 1,
  identitySource: "RECIPIENT_DIRECTORY",
  resolutionSource: "RECIPIENT_DIRECTORY",
  trustOutcome: "ACKNOWLEDGED",
});

type Resolution = Readonly<{
  username: string;
  displayName: string;
  accountType: "PERSONAL";
  verificationState: "UNVERIFIED" | "PENDING" | "VERIFIED" | "RESTRICTED";
  payabilityState: "AVAILABLE" | "UNAVAILABLE" | "RESTRICTED";
  destinationAddress: string;
}>;

function input(overrides: Partial<ClaimPaymentIdentityInput> = {}): ClaimPaymentIdentityInput {
  return {
    id: "00000000-0000-4000-8000-000000000901",
    actorSubject: ACTOR,
    senderAccountId: SENDER,
    idempotencyKey: "identity-replay-key-0001",
    recipientAccountId: RECIPIENT_A,
    trustAcknowledged: true,
    network: "solana-devnet",
    rail: "solana",
    asset: "USDC",
    mintAddress: "mint-usdc-devnet",
    amountRaw: 1_000_000n,
    purpose: "Frozen recipient",
    capturedAt: NOW,
    ...overrides,
  };
}

function fixture() {
  let resolution: Resolution | undefined = {
    username: "recipient_a",
    displayName: "Recipient A",
    accountType: "PERSONAL",
    verificationState: "UNVERIFIED",
    payabilityState: "AVAILABLE",
    destinationAddress: DESTINATION_D1,
  };
  let resolutionCalls = 0;
  const payments = new InMemoryPaymentPersistence({
    clock: () => NOW,
    resolvePaymentIdentity: async () => {
      resolutionCalls += 1;
      return resolution;
    },
  });
  return {
    payments,
    resolutionCalls: () => resolutionCalls,
    setResolution: (value: Resolution | undefined) => { resolution = value; },
  };
}

function replayInput(overrides: Partial<PaymentIdentityReplayRequest> = {}): PaymentIdentityReplayRequest {
  return {
    actorSubject: ACTOR,
    idempotencyKey: "legacy-replay-key-0001",
    recipientId: RECIPIENT_A,
    trustAcknowledged: true,
    network: "solana-devnet",
    rail: "solana",
    asset: "USDC",
    mintAddress: "mint-usdc-devnet",
    amountRaw: 1_000_000n,
    purpose: "Historical recipient",
    ...overrides,
  };
}

function frozenRecord(requestHash: string, overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return Object.freeze({
    id: "00000000-0000-4000-8000-000000000951",
    actorSubject: ACTOR,
    idempotencyKey: "legacy-replay-key-0001",
    requestHash,
    status: "AWAITING_CONFIRMATION",
    version: 0n,
    network: "solana-devnet",
    rail: "solana",
    asset: "USDC",
    mintAddress: "mint-usdc-devnet",
    recipientAddress: DESTINATION_D1,
    amountRaw: 1_000_000n,
    purpose: "Historical recipient",
    recipientType: "PAYMENT_IDENTITY",
    recipientAccountId: RECIPIENT_A,
    recipientSnapshot: CANONICAL_SNAPSHOT,
    recipientSnapshotVersion: 1,
    trustConfirmationOutcome: "ACKNOWLEDGED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function hashInput(snapshot: PaymentIdentitySnapshot = CANONICAL_SNAPSHOT) {
  return {
    actorSubject: ACTOR,
    network: "solana-devnet" as const,
    mintAddress: "mint-usdc-devnet",
    recipientAddress: DESTINATION_D1,
    amountRaw: 1_000_000n,
    purpose: "Historical recipient",
    recipientAccountId: RECIPIENT_A,
    recipientSnapshot: snapshot,
    trustConfirmationOutcome: "ACKNOWLEDGED" as const,
  };
}

describe("IDENT-R001 historical Payment Identity hash compatibility", () => {
  it("accepts the current canonical hash before considering compatibility", () => {
    const currentHash = createPaymentIdentityRequestHash(hashInput());
    assert.equal(matchesFrozenPaymentIdentityRequest(frozenRecord(currentHash), replayInput()), true);
  });

  it("accepts only the known pre-migration-009 canonical snapshot hash", () => {
    const currentHash = createPaymentIdentityRequestHash(hashInput());
    const legacyHash = createLegacyPreMigration009PaymentIdentityRequestHash(hashInput());
    assert.notEqual(legacyHash, currentHash);
    assert.equal(matchesFrozenPaymentIdentityRequest(frozenRecord(legacyHash), replayInput()), true);
  });

  it("rejects changed caller semantics before legacy hash compatibility", () => {
    const payment = frozenRecord(createLegacyPreMigration009PaymentIdentityRequestHash(hashInput()));
    assert.equal(matchesFrozenPaymentIdentityRequest(payment, replayInput({ recipientId: RECIPIENT_B })), false);
    assert.equal(matchesFrozenPaymentIdentityRequest(payment, replayInput({ amountRaw: 2_000_000n })), false);
    assert.equal(matchesFrozenPaymentIdentityRequest(payment, replayInput({ purpose: "Changed" })), false);
  });

  it("rejects arbitrary hashes and non-historical snapshot shapes", () => {
    assert.equal(matchesFrozenPaymentIdentityRequest(frozenRecord("b".repeat(64)), replayInput()), false);
    const expandedSnapshot = Object.freeze({ ...CANONICAL_SNAPSHOT, unexpectedField: "not-historical" }) as PaymentIdentitySnapshot;
    const legacyHash = createLegacyPreMigration009PaymentIdentityRequestHash(hashInput(expandedSnapshot));
    assert.equal(matchesFrozenPaymentIdentityRequest(frozenRecord(legacyHash, { recipientSnapshot: expandedSnapshot }), replayInput()), false);
  });

  it("does not apply canonical legacy compatibility to synthetic records", () => {
    const syntheticSnapshot: PaymentIdentitySnapshot = Object.freeze({
      ...CANONICAL_SNAPSHOT,
      identitySource: "SYNTHETIC_BETA",
      resolutionSource: "SYNTHETIC_BETA",
      trustOutcome: "NOT_REQUIRED",
    });
    const syntheticHashInput = {
      ...hashInput(syntheticSnapshot),
      recipientAddress: `synthetic:${RECIPIENT_A}`,
      trustConfirmationOutcome: "NOT_REQUIRED" as const,
    };
    const forgedLegacyHash = createLegacyPreMigration009PaymentIdentityRequestHash(syntheticHashInput);
    const synthetic = frozenRecord(forgedLegacyHash, {
      recipientAddress: syntheticHashInput.recipientAddress,
      recipientAccountId: undefined,
      recipientSyntheticId: RECIPIENT_A,
      recipientSnapshot: syntheticSnapshot,
      trustConfirmationOutcome: "NOT_REQUIRED",
    });
    assert.equal(matchesFrozenPaymentIdentityRequest(synthetic, replayInput()), false);
  });
});

describe("IDENT-001 frozen Payment Identity replay", () => {
  it("returns the existing payment without consulting changed metadata, trust, visibility, or destination", async () => {
    const f = fixture();
    const first = await f.payments.claimPaymentIdentityKey(input());
    assert.equal(first.outcome, "CLAIMED");
    assert.equal(f.resolutionCalls(), 1);

    f.setResolution({
      username: "recipient_b_locator",
      displayName: "Reassigned presentation",
      accountType: "PERSONAL",
      verificationState: "RESTRICTED",
      payabilityState: "UNAVAILABLE",
      destinationAddress: DESTINATION_D2,
    });
    const replay = await f.payments.claimPaymentIdentityKey(input({
      id: "00000000-0000-4000-8000-000000000902",
      capturedAt: "2026-08-25T12:05:00.000Z",
    }));
    assert.equal(replay.outcome, "EXISTING");
    assert.equal(replay.payment.id, first.payment.id);
    assert.equal(replay.payment.recipientAccountId, RECIPIENT_A);
    assert.equal(replay.payment.recipientAddress, DESTINATION_D1);
    assert.equal(replay.payment.recipientSnapshot?.username, "recipient_a");
    assert.equal(replay.payment.recipientSnapshot?.displayName, "Recipient A");
    assert.equal(f.resolutionCalls(), 1);

    f.setResolution(undefined);
    assert.equal((await f.payments.claimPaymentIdentityKey(input())).outcome, "EXISTING");
    assert.equal(f.resolutionCalls(), 1);
    await assert.rejects(
      () => f.payments.claimPaymentIdentityKey(input({ idempotencyKey: "identity-replay-key-0002" })),
      /RECIPIENT_UNAVAILABLE/,
    );
    assert.equal(f.resolutionCalls(), 2);
  });

  it("fails closed for every changed caller-controlled economic semantic before current resolution", async () => {
    const f = fixture();
    await f.payments.claimPaymentIdentityKey(input());
    f.setResolution(undefined);
    const changed = [
      { recipientAccountId: RECIPIENT_B },
      { amountRaw: 2_000_000n },
      { purpose: "Different purpose" },
      { network: "solana-mainnet" },
      { mintAddress: "different-mint" },
      { rail: "mock" },
      { asset: "ZERA" },
      { trustAcknowledged: false },
    ] as const;
    for (const override of changed) {
      const claim = await f.payments.claimPaymentIdentityKey(input(override as Partial<ClaimPaymentIdentityInput>));
      assert.equal(claim.outcome, "HASH_CONFLICT", Object.keys(override)[0]);
    }
    assert.equal(f.resolutionCalls(), 1);
  });

  it("keeps actor-scoped ownership from leaking an existing payment to another actor", async () => {
    const f = fixture();
    const first = await f.payments.claimPaymentIdentityKey(input());
    f.setResolution(undefined);
    await assert.rejects(
      () => f.payments.claimPaymentIdentityKey(input({ actorSubject: OTHER_ACTOR })),
      /RECIPIENT_UNAVAILABLE/,
    );
    assert.equal((await f.payments.findPayment(first.payment.id))?.actorSubject, ACTOR);
  });

  it("feeds the frozen D1 recipient and destination into execution after current state rotates to D2", async () => {
    const f = fixture();
    const claimed = await f.payments.claimPaymentIdentityKey(input());
    f.setResolution({
      username: "recipient_a_rotated",
      displayName: "Recipient A Rotated",
      accountType: "PERSONAL",
      verificationState: "VERIFIED",
      payabilityState: "AVAILABLE",
      destinationAddress: DESTINATION_D2,
    });
    const replay = await f.payments.claimPaymentIdentityKey(input());
    assert.equal(replay.outcome, "EXISTING");
    const confirmed = await f.payments.transitionPayment({
      paymentId: claimed.payment.id,
      expectedVersion: 0n,
      toStatus: "PROCESSING",
      evidence: { userConfirmedAt: NOW, executionStartedAt: NOW },
      occurredAt: NOW,
    });
    const executions = new InMemoryExecutionRepository();
    const execution = (await executions.createOrGet({
      executionId: "00000000-0000-4000-8000-000000000991",
      paymentIntentId: confirmed.id,
      actorSubject: ACTOR,
      providerIdempotencyKey: "a".repeat(64),
      now: NOW,
    })).execution;
    const worker = new PaymentExecutionWorker(f.payments, executions, "ident-worker", "accepted_pending", () => NOW);
    const context = (worker as unknown as {
      context(payment: PaymentRecord, execution: typeof execution, attemptId: string): { recipient: { id: string }; destination: { accountReference: string } };
    }).context(confirmed, execution, "00000000-0000-4000-8000-000000000992");
    assert.equal(context.recipient.id, RECIPIENT_A);
    assert.equal(context.destination.accountReference, DESTINATION_D1);
    assert.equal((await worker.processNext())?.status, "PROCESSING");
    assert.equal((await f.payments.findPayment(confirmed.id))?.recipientAddress, DESTINATION_D1);
    assert.equal(f.resolutionCalls(), 1);
  });
});

describe("IDENT-R002 in-memory differing-semantic first claims", () => {
  function concurrentPayments() {
    return new InMemoryPaymentPersistence({
      clock: () => NOW,
      resolvePaymentIdentity: async (request) => ({
        username: request.recipientAccountId === RECIPIENT_A ? "recipient_a" : "recipient_b",
        displayName: request.recipientAccountId === RECIPIENT_A ? "Recipient A" : "Recipient B",
        accountType: "PERSONAL",
        verificationState: "VERIFIED",
        payabilityState: "AVAILABLE",
        destinationAddress: request.recipientAccountId === RECIPIENT_A ? DESTINATION_D1 : DESTINATION_D2,
      }),
    });
  }

  async function assertOneWinner(
    payments: InMemoryPaymentPersistence,
    left: ClaimPaymentIdentityInput,
    right: ClaimPaymentIdentityInput,
  ) {
    const results = await Promise.all([
      payments.claimPaymentIdentityKey(left),
      payments.claimPaymentIdentityKey(right),
    ]);
    assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ["CLAIMED", "HASH_CONFLICT"]);
    assert.equal(results[0].payment.id, results[1].payment.id);
    const winner = results.find(({ outcome }) => outcome === "CLAIMED")!;
    const loserId = winner.payment.id === left.id ? right.id : left.id;
    assert.equal(await payments.findPayment(loserId), undefined);
  }

  it("establishes exactly one recipient meaning for a concurrent actor/key race", async () => {
    const payments = concurrentPayments();
    await assertOneWinner(
      payments,
      input({ id: "00000000-0000-4000-8000-000000000961", idempotencyKey: "recipient-race-key-0001" }),
      input({ id: "00000000-0000-4000-8000-000000000962", idempotencyKey: "recipient-race-key-0001", recipientAccountId: RECIPIENT_B }),
    );
  });

  it("establishes exactly one amount meaning for a concurrent actor/key race", async () => {
    const payments = concurrentPayments();
    await assertOneWinner(
      payments,
      input({ id: "00000000-0000-4000-8000-000000000963", idempotencyKey: "amount-race-key-000001" }),
      input({ id: "00000000-0000-4000-8000-000000000964", idempotencyKey: "amount-race-key-000001", amountRaw: 2_000_000n }),
    );
  });
});
