import type { JsonObject } from "../payments/paymentTypes";
import { validateUuid } from "../identity/identityTypes";

export const GROWTH_EVENT_TYPES = [
  "PAYMENT_SETTLED_SENT",
  "PAYMENT_SETTLED_RECEIVED",
] as const;

export type GrowthEventType =
  (typeof GROWTH_EVENT_TYPES)[number];

export const GROWTH_SOURCE_DOMAINS = [
  "PAYMENT",
] as const;

export type GrowthSourceDomain =
  (typeof GROWTH_SOURCE_DOMAINS)[number];

export type GrowthEvent = Readonly<{
  eventId: bigint;
  eventType: GrowthEventType;
  actorAccountId: string;
  sourceDomain: GrowthSourceDomain;
  sourceId: string;
  sourceEventId: string;
  occurredAt: string;
  synthetic: boolean;
  schemaVersion: 1;
  context: JsonObject;
  recordedAt: string;
}>;

export type CreateGrowthEventInput = Readonly<{
  eventType: GrowthEventType;
  actorAccountId: string;
  sourceDomain: GrowthSourceDomain;
  sourceId: string;
  sourceEventId: string;
  occurredAt: string;
  synthetic: boolean;
  schemaVersion: 1;
  context?: JsonObject;
}>;

export function validateGrowthEventInput(
  input: CreateGrowthEventInput,
): void {
  if (!GROWTH_EVENT_TYPES.includes(input.eventType)) {
    throw new Error("Unsupported growth event type.");
  }

  if (!GROWTH_SOURCE_DOMAINS.includes(input.sourceDomain)) {
    throw new Error("Unsupported growth source domain.");
  }

  validateUuid(input.actorAccountId, "Growth actor account ID");
  validateBoundedIdentifier(input.sourceId, "Growth source ID");
  validateBoundedIdentifier(input.sourceEventId, "Growth source event ID");

  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error("Growth event occurredAt must be a valid timestamp.");
  }

  if (input.schemaVersion !== 1) {
    throw new Error("Unsupported growth event schema version.");
  }

  if (
    input.context !== undefined &&
    (
      input.context === null ||
      typeof input.context !== "object" ||
      Array.isArray(input.context)
    )
  ) {
    throw new Error("Growth event context must be an object.");
  }
}

function validateBoundedIdentifier(value: string, name: string): void {
  if (
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new Error(`${name} must contain 1 to 128 characters without surrounding whitespace.`);
  }
}
