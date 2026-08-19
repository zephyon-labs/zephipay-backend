import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateGrowthEventInput,
  type CreateGrowthEventInput,
} from "../src/growth/growthTypes";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function valid(
  overrides: Partial<CreateGrowthEventInput> = {},
): CreateGrowthEventInput {
  return {
    eventType: "PAYMENT_SETTLED_SENT",
    actorAccountId: ACCOUNT_ID,
    sourceDomain: "PAYMENT",
    sourceId: "payment:11111111-1111-4111-8111-111111111112",
    sourceEventId: "receipt:11111111-1111-4111-8111-111111111113",
    occurredAt: "2026-08-19T09:00:00.000Z",
    synthetic: false,
    schemaVersion: 1,
    context: {
      asset: "USDC",
      amountRaw: "1000000",
    },
    ...overrides,
  };
}

describe("growth event contract", () => {
  it("accepts a bounded canonical payment fact", () => {
    assert.doesNotThrow(() => validateGrowthEventInput(valid()));
  });

  it("accepts synthetic activity explicitly", () => {
    assert.doesNotThrow(() =>
      validateGrowthEventInput(valid({ synthetic: true })),
    );
  });

  it("accepts sender and recipient settlement facts", () => {
    assert.doesNotThrow(() =>
      validateGrowthEventInput(
        valid({ eventType: "PAYMENT_SETTLED_SENT" }),
      ),
    );

    assert.doesNotThrow(() =>
      validateGrowthEventInput(
        valid({ eventType: "PAYMENT_SETTLED_RECEIVED" }),
      ),
    );
  });

  it("rejects malformed canonical account IDs", () => {
    assert.throws(
      () => validateGrowthEventInput(
        valid({ actorAccountId: "auth0|someone" }),
      ),
      /canonical UUID/,
    );
  });

  it("rejects blank, padded, and oversized source identifiers", () => {
    assert.throws(
      () => validateGrowthEventInput(valid({ sourceId: "" })),
      /1 to 128/,
    );

    assert.throws(
      () => validateGrowthEventInput(valid({ sourceId: " payment " })),
      /1 to 128/,
    );

    assert.throws(
      () => validateGrowthEventInput(
        valid({ sourceEventId: "x".repeat(129) }),
      ),
      /1 to 128/,
    );
  });

  it("rejects invalid timestamps", () => {
    assert.throws(
      () => validateGrowthEventInput(
        valid({ occurredAt: "whenever" }),
      ),
      /valid timestamp/,
    );
  });
});
