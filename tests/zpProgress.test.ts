import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectZpProgress,
  type PublicZpProgress,
} from "../src/growth/zpProgress";
import type { AccountZpState } from "../src/growth/zpState";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-20T12:00:00.000Z";

function state(
  overrides: Partial<AccountZpState> = {},
): AccountZpState {
  return Object.freeze({
    accountId: ACCOUNT_ID,
    policyVersion: 1,
    totalPoints: 0n,
    sentCount: 0n,
    receivedCount: 0n,
    lastGrowthEventId: 0n,
    updatedAt: NOW,
    ...overrides,
  });
}

function pending(
  projection: PublicZpProgress,
  milestone: string,
) {
  return projection.pendingMilestones.find(
    (item) => item.milestone === milestone,
  );
}

describe("ZP progress projection", () => {
  it("projects an exact frontend-safe zero state", () => {
    assert.deepEqual(projectZpProgress(state()), {
      totalPoints: "0",
      sentCount: "0",
      receivedCount: "0",
      policyVersion: 1,
      unlockedMilestones: [],
      pendingMilestones: [
        {
          milestone: "FIRST_PAYMENT_SENT",
          dimension: "SENT",
          current: "0",
          target: "1",
          progressPercent: 0,
        },
        {
          milestone: "FIRST_PAYMENT_RECEIVED",
          dimension: "RECEIVED",
          current: "0",
          target: "1",
          progressPercent: 0,
        },
        {
          milestone: "TEN_PAYMENTS_SENT",
          dimension: "SENT",
          current: "0",
          target: "10",
          progressPercent: 0,
        },
        {
          milestone: "TWENTY_FIVE_PAYMENTS_SENT",
          dimension: "SENT",
          current: "0",
          target: "25",
          progressPercent: 0,
        },
      ],
    });
  });

  it("unlocks the first sent milestone and advances later sent targets", () => {
    const projection = projectZpProgress(state({
      totalPoints: 10n,
      sentCount: 1n,
    }));

    assert.deepEqual(projection.unlockedMilestones, [
      "FIRST_PAYMENT_SENT",
    ]);
    assert.equal(
      pending(projection, "FIRST_PAYMENT_RECEIVED")?.progressPercent,
      0,
    );
    assert.equal(
      pending(projection, "TEN_PAYMENTS_SENT")?.progressPercent,
      10,
    );
    assert.equal(
      pending(projection, "TWENTY_FIVE_PAYMENTS_SENT")?.progressPercent,
      4,
    );
  });

  it("unlocks received progress independently from sent progress", () => {
    const projection = projectZpProgress(state({
      totalPoints: 5n,
      receivedCount: 1n,
    }));

    assert.deepEqual(projection.unlockedMilestones, [
      "FIRST_PAYMENT_RECEIVED",
    ]);
    assert.deepEqual(
      projection.pendingMilestones.map((item) => item.milestone),
      [
        "FIRST_PAYMENT_SENT",
        "TEN_PAYMENTS_SENT",
        "TWENTY_FIVE_PAYMENTS_SENT",
      ],
    );
    assert.equal(pending(projection, "TEN_PAYMENTS_SENT")?.current, "0");
  });

  it("unlocks ten sent payments at the exact threshold", () => {
    const projection = projectZpProgress(state({
      totalPoints: 100n,
      sentCount: 10n,
    }));

    assert.deepEqual(projection.unlockedMilestones, [
      "FIRST_PAYMENT_SENT",
      "TEN_PAYMENTS_SENT",
    ]);
    assert.equal(pending(projection, "TEN_PAYMENTS_SENT"), undefined);
    assert.equal(
      pending(projection, "TWENTY_FIVE_PAYMENTS_SENT")?.progressPercent,
      40,
    );
  });

  it("unlocks every sent milestone at twenty-five payments", () => {
    const projection = projectZpProgress(state({
      totalPoints: 250n,
      sentCount: 25n,
    }));

    assert.deepEqual(projection.unlockedMilestones, [
      "FIRST_PAYMENT_SENT",
      "TEN_PAYMENTS_SENT",
      "TWENTY_FIVE_PAYMENTS_SENT",
    ]);
    assert.deepEqual(
      projection.pendingMilestones.map((item) => item.milestone),
      ["FIRST_PAYMENT_RECEIVED"],
    );
  });

  it("calculates bounded integer progress below a threshold", () => {
    const projection = projectZpProgress(state({ sentCount: 4n }));

    assert.equal(
      pending(projection, "TEN_PAYMENTS_SENT")?.progressPercent,
      40,
    );
    assert.equal(
      pending(projection, "TWENTY_FIVE_PAYMENTS_SENT")?.progressPercent,
      16,
    );
  });

  it("does not emit progress for milestones at or above their threshold", () => {
    const exact = projectZpProgress(state({ sentCount: 10n }));
    const above = projectZpProgress(state({ sentCount: 15n }));

    assert.equal(pending(exact, "TEN_PAYMENTS_SENT"), undefined);
    assert.equal(pending(above, "TEN_PAYMENTS_SENT"), undefined);
    assert.ok(
      above.pendingMilestones.every(
        (item) => item.progressPercent >= 0 && item.progressPercent <= 100,
      ),
    );
  });

  it("keeps unlocked and pending milestone order deterministic", () => {
    const projection = projectZpProgress(state({
      sentCount: 10n,
      receivedCount: 1n,
    }));

    assert.deepEqual(projection.unlockedMilestones, [
      "FIRST_PAYMENT_SENT",
      "FIRST_PAYMENT_RECEIVED",
      "TEN_PAYMENTS_SENT",
    ]);
    assert.deepEqual(
      projection.pendingMilestones.map((item) => item.milestone),
      ["TWENTY_FIVE_PAYMENTS_SENT"],
    );
  });

  it("preserves policy version and bigint precision as decimal strings", () => {
    const precise = 9_007_199_254_740_993n;
    const projection = projectZpProgress(state({
      totalPoints: precise,
      sentCount: precise,
      receivedCount: precise,
    }));

    assert.equal(projection.policyVersion, 1);
    assert.equal(projection.totalPoints, "9007199254740993");
    assert.equal(projection.sentCount, "9007199254740993");
    assert.equal(projection.receivedCount, "9007199254740993");
  });

  it("fails closed for an unsupported runtime policy version", () => {
    const unsupported = {
      ...state(),
      policyVersion: 2,
    } as unknown as AccountZpState;

    assert.throws(
      () => projectZpProgress(unsupported),
      /policy version is unsupported/,
    );
  });
});
