import type { GrowthEvent, GrowthEventType } from "./growthTypes";

export const ZP_POLICY_VERSION = 1 as const;

export type ZpEligibleEventType =
  | "PAYMENT_SETTLED_SENT"
  | "PAYMENT_SETTLED_RECEIVED";

export type ZpMilestone =
  | "FIRST_PAYMENT_SENT"
  | "FIRST_PAYMENT_RECEIVED"
  | "TEN_PAYMENTS_SENT"
  | "TWENTY_FIVE_PAYMENTS_SENT";

export type ZpPolicyDecision = Readonly<{
  eligible: boolean;
  points: number;
  reason:
    | "ELIGIBLE_PAYMENT_ACTIVITY"
    | "SYNTHETIC_ACTIVITY"
    | "UNSUPPORTED_EVENT";
  policyVersion: 1;
}>;

const EVENT_POINTS: Readonly<Record<ZpEligibleEventType, number>> =
  Object.freeze({
    PAYMENT_SETTLED_SENT: 10,
    PAYMENT_SETTLED_RECEIVED: 5,
  });

export function evaluateZpEvent(
  event: GrowthEvent,
): ZpPolicyDecision {
  if (event.synthetic) {
    return Object.freeze({
      eligible: false,
      points: 0,
      reason: "SYNTHETIC_ACTIVITY",
      policyVersion: ZP_POLICY_VERSION,
    });
  }

  if (!isEligibleEventType(event.eventType)) {
    return Object.freeze({
      eligible: false,
      points: 0,
      reason: "UNSUPPORTED_EVENT",
      policyVersion: ZP_POLICY_VERSION,
    });
  }

  return Object.freeze({
    eligible: true,
    points: EVENT_POINTS[event.eventType],
    reason: "ELIGIBLE_PAYMENT_ACTIVITY",
    policyVersion: ZP_POLICY_VERSION,
  });
}

export function deriveZpMilestones(
  events: readonly GrowthEvent[],
): readonly ZpMilestone[] {
  let sent = 0;
  let received = 0;

  for (const event of events) {
    const decision = evaluateZpEvent(event);

    if (!decision.eligible) {
      continue;
    }

    if (event.eventType === "PAYMENT_SETTLED_SENT") {
      sent += 1;
    }

    if (event.eventType === "PAYMENT_SETTLED_RECEIVED") {
      received += 1;
    }
  }

  const milestones: ZpMilestone[] = [];

  if (sent >= 1) {
    milestones.push("FIRST_PAYMENT_SENT");
  }

  if (received >= 1) {
    milestones.push("FIRST_PAYMENT_RECEIVED");
  }

  if (sent >= 10) {
    milestones.push("TEN_PAYMENTS_SENT");
  }

  if (sent >= 25) {
    milestones.push("TWENTY_FIVE_PAYMENTS_SENT");
  }

  return Object.freeze(milestones);
}

export function totalZp(
  events: readonly GrowthEvent[],
): number {
  return events.reduce((total, event) => {
    const decision = evaluateZpEvent(event);
    return total + decision.points;
  }, 0);
}

function isEligibleEventType(
  eventType: GrowthEventType,
): eventType is ZpEligibleEventType {
  return (
    eventType === "PAYMENT_SETTLED_SENT" ||
    eventType === "PAYMENT_SETTLED_RECEIVED"
  );
}
