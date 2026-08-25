import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PaymentExecutionWorker } from "../src/executions/executionWorker";
import type { PaymentRecord } from "../src/payments/paymentTypes";
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
