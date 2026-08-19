import type {
  Pool,
  QueryResultRow,
} from "pg";

import type {
  GrowthEventAppendResult,
  GrowthEventRepository,
} from "../../growth/growthRepository";
import {
  validateGrowthEventInput,
  type CreateGrowthEventInput,
  type GrowthEvent,
  type GrowthEventType,
  type GrowthSourceDomain,
} from "../../growth/growthTypes";
import type { JsonObject } from "../../payments/paymentTypes";
import { validateUuid } from "../../identity/identityTypes";

export class PostgresGrowthEventRepository
implements GrowthEventRepository {
  constructor(private readonly pool: Pool) {}

  async append(
    input: CreateGrowthEventInput,
  ): Promise<GrowthEventAppendResult> {
    validateGrowthEventInput(input);

    const context = input.context ?? {};

    const inserted = await this.pool.query(
      `INSERT INTO growth_events
         (event_type,
          actor_account_id,
          source_domain,
          source_id,
          source_event_id,
          occurred_at,
          synthetic,
          schema_version,
          context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (
         source_domain,
         source_id,
         source_event_id,
         event_type,
         actor_account_id
       )
       DO NOTHING
       RETURNING *`,
      [
        input.eventType,
        input.actorAccountId,
        input.sourceDomain,
        input.sourceId,
        input.sourceEventId,
        input.occurredAt,
        input.synthetic,
        input.schemaVersion,
        JSON.stringify(context),
      ],
    );

    if (inserted.rows[0]) {
      return Object.freeze({
        event: mapGrowthEvent(inserted.rows[0]),
        created: true,
      });
    }

    const existing = await this.pool.query(
      `SELECT *
       FROM growth_events
       WHERE source_domain=$1
         AND source_id=$2
         AND source_event_id=$3
         AND event_type=$4
         AND actor_account_id=$5`,
      [
        input.sourceDomain,
        input.sourceId,
        input.sourceEventId,
        input.eventType,
        input.actorAccountId,
      ],
    );

    const row = existing.rows[0];

    if (!row) {
      throw new Error("Growth event idempotency resolution failed.");
    }

    const event = mapGrowthEvent(row);

    if (!sameImmutableFact(event, input, context)) {
      throw new Error("Growth event idempotency conflict.");
    }

    return Object.freeze({
      event,
      created: false,
    });
  }

  async listByActor(
    actorAccountId: string,
    limit: number,
  ): Promise<GrowthEvent[]> {
    validateUuid(actorAccountId, "Growth actor account ID");

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Growth event list limit must be between 1 and 100.");
    }

    const result = await this.pool.query(
      `SELECT *
       FROM growth_events
       WHERE actor_account_id=$1
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT $2`,
      [actorAccountId, limit],
    );

    return result.rows.map(mapGrowthEvent);
  }
}

function sameImmutableFact(
  existing: GrowthEvent,
  input: CreateGrowthEventInput,
  context: JsonObject,
): boolean {
  return (
    existing.eventType === input.eventType &&
    existing.actorAccountId === input.actorAccountId.toLowerCase() &&
    existing.sourceDomain === input.sourceDomain &&
    existing.sourceId === input.sourceId &&
    existing.sourceEventId === input.sourceEventId &&
    existing.occurredAt === new Date(input.occurredAt).toISOString() &&
    existing.synthetic === input.synthetic &&
    existing.schemaVersion === input.schemaVersion &&
    stableJson(existing.context) === stableJson(context)
  );
}

function stableJson(value: JsonObject): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }

  return value;
}

function mapGrowthEvent(row: QueryResultRow): GrowthEvent {
  return Object.freeze({
    eventId: BigInt(String(row.event_id)),
    eventType: String(row.event_type) as GrowthEventType,
    actorAccountId: String(row.actor_account_id),
    sourceDomain: String(row.source_domain) as GrowthSourceDomain,
    sourceId: String(row.source_id),
    sourceEventId: String(row.source_event_id),
    occurredAt: new Date(row.occurred_at).toISOString(),
    synthetic: Boolean(row.synthetic),
    schemaVersion: Number(row.schema_version) as 1,
    context: cloneJsonObject(row.context),
    recordedAt: new Date(row.recorded_at).toISOString(),
  });
}

function cloneJsonObject(value: unknown): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Persisted growth event context must be an object.");
  }

  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
