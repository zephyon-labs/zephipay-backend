import type { ZpMilestone } from "./zpPolicy";
import { ZP_POLICY_VERSION } from "./zpPolicy";
import type { AccountZpState } from "./zpState";

export type ZpMilestoneDimension = "SENT" | "RECEIVED";

export type PendingZpMilestone = Readonly<{
  milestone: ZpMilestone;
  dimension: ZpMilestoneDimension;
  current: string;
  target: string;
  progressPercent: number;
}>;

export type PublicZpProgress = Readonly<{
  totalPoints: string;
  sentCount: string;
  receivedCount: string;
  policyVersion: typeof ZP_POLICY_VERSION;
  unlockedMilestones: readonly ZpMilestone[];
  pendingMilestones: readonly PendingZpMilestone[];
}>;

type ZpMilestonePolicy = Readonly<{
  milestone: ZpMilestone;
  dimension: ZpMilestoneDimension;
  threshold: bigint;
}>;

const MILESTONE_POLICY: readonly ZpMilestonePolicy[] = Object.freeze([
  Object.freeze({
    milestone: "FIRST_PAYMENT_SENT",
    dimension: "SENT",
    threshold: 1n,
  }),
  Object.freeze({
    milestone: "FIRST_PAYMENT_RECEIVED",
    dimension: "RECEIVED",
    threshold: 1n,
  }),
  Object.freeze({
    milestone: "TEN_PAYMENTS_SENT",
    dimension: "SENT",
    threshold: 10n,
  }),
  Object.freeze({
    milestone: "TWENTY_FIVE_PAYMENTS_SENT",
    dimension: "SENT",
    threshold: 25n,
  }),
]);

export function projectZpProgress(
  state: AccountZpState,
): PublicZpProgress {
  if (state.policyVersion !== ZP_POLICY_VERSION) {
    throw new Error("ZP state policy version is unsupported.");
  }

  assertNonnegative(state.totalPoints, "ZP total points");
  assertNonnegative(state.sentCount, "ZP sent count");
  assertNonnegative(state.receivedCount, "ZP received count");

  const unlockedMilestones: ZpMilestone[] = [];
  const pendingMilestones: PendingZpMilestone[] = [];

  for (const policy of MILESTONE_POLICY) {
    const current = policy.dimension === "SENT"
      ? state.sentCount
      : state.receivedCount;

    if (current >= policy.threshold) {
      unlockedMilestones.push(policy.milestone);
      continue;
    }

    pendingMilestones.push(Object.freeze({
      milestone: policy.milestone,
      dimension: policy.dimension,
      current: current.toString(),
      target: policy.threshold.toString(),
      progressPercent: progressPercent(current, policy.threshold),
    }));
  }

  return Object.freeze({
    totalPoints: state.totalPoints.toString(),
    sentCount: state.sentCount.toString(),
    receivedCount: state.receivedCount.toString(),
    policyVersion: state.policyVersion,
    unlockedMilestones: Object.freeze(unlockedMilestones),
    pendingMilestones: Object.freeze(pendingMilestones),
  });
}

function progressPercent(
  current: bigint,
  target: bigint,
): number {
  if (target <= 0n) {
    throw new Error("ZP milestone target must be positive.");
  }

  if (current <= 0n) {
    return 0;
  }

  if (current >= target) {
    return 100;
  }

  return Number((current * 100n) / target);
}

function assertNonnegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new Error(`${name} must not be negative.`);
  }
}
