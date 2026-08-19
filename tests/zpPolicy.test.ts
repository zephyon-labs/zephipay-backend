import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GrowthEvent } from "../src/growth/growthTypes";
import {
  deriveZpMilestones,
  evaluateZpEvent,
  totalZp,
  ZP_POLICY_VERSION,
} from "../src/growth/zpPolicy";

const NOW = "2026-08-19T16:00:00.000Z";

function event(
  overrides: Partial<GrowthEvent> = {},
): GrowthEvent {
  return Object.freeze({
    eventId: 1n,
    eventType: "PAYMENT_SETTLED_SENT",
    actorAccountId: "11111111-1111-4111-8111-111111111111",
    sourceDomain: "PAYMENT",
    sourceId: "11111111-1111-4111-8111-111111111112",
    sourceEventId: "receipt:test",
    occurredAt: NOW,
    synthetic: false,
    schemaVersion: 1,
    context: Object.freeze({}),
    recordedAt: NOW,
    ...overrides,
  });
}

describe("ZP policy", () => {
  it("awards canonical sent payment activity", () => {
    const decision = evaluateZpEvent(event());

    assert.deepEqual(decision, {
      eligible: true,
      points: 10,
      reason: "ELIGIBLE_PAYMENT_ACTIVITY",
      policyVersion: ZP_POLICY_VERSION,
    });
  });

  it("awards canonical received payment activity", () => {
    const decision = evaluateZpEvent(
      event({
        eventType: "PAYMENT_SETTLED_RECEIVED",
      }),
    );

    assert.equal(decision.eligible, true);
    assert.equal(decision.points, 5);
  });

  it("never awards synthetic activity", () => {
    const decision = evaluateZpEvent(
      event({
        synthetic: true,
      }),
    );

    assert.deepEqual(decision, {
      eligible: false,
      points: 0,
      reason: "SYNTHETIC_ACTIVITY",
      policyVersion: ZP_POLICY_VERSION,
    });
  });

  it("totals only eligible canonical activity", () => {
    const events = [
      event({
        eventId: 1n,
      }),
      event({
        eventId: 2n,
        eventType: "PAYMENT_SETTLED_RECEIVED",
      }),
      event({
        eventId: 3n,
        synthetic: true,
      }),
    ];

    assert.equal(totalZp(events), 15);
  });

  it("derives milestones from history without storing milestone events", () => {
    const events: GrowthEvent[] = [];

    for (let i = 0; i < 10; i += 1) {
      events.push(
        event({
          eventId: BigInt(i + 1),
          sourceEventId: `receipt:sent:${i}`,
        }),
      );
    }

    events.push(
      event({
        eventId: 11n,
        eventType: "PAYMENT_SETTLED_RECEIVED",
        sourceEventId: "receipt:received:1",
      }),
    );

    assert.deepEqual(
      deriveZpMilestones(events),
      [
        "FIRST_PAYMENT_SENT",
        "FIRST_PAYMENT_RECEIVED",
        "TEN_PAYMENTS_SENT",
      ],
    );
  });

  it("synthetic activity cannot unlock milestones", () => {
    const events = Array.from(
      { length: 25 },
      (_, i) =>
        event({
          eventId: BigInt(i + 1),
          sourceEventId: `receipt:synthetic:${i}`,
          synthetic: true,
        }),
    );

    assert.deepEqual(
      deriveZpMilestones(events),
      [],
    );
  });
});
