import type {
  Pool,
  PoolClient,
  QueryResultRow,
} from "pg";

import { validateUuid } from "../../identity/identityTypes";
import {
  evaluateZpEvent,
  ZP_POLICY_VERSION,
} from "../../growth/zpPolicy";
import type {
  AccountZpState,
  ZpProjectionResult,
  ZpStateRepository,
} from "../../growth/zpState";
import type {
  GrowthEvent,
  GrowthEventType,
  GrowthSourceDomain,
} from "../../growth/growthTypes";
import type { JsonObject } from "../../payments/paymentTypes";

export class PostgresZpStateRepository
implements ZpStateRepository {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async find(
    accountId: string,
  ): Promise<AccountZpState | undefined> {
    validateUuid(accountId, "ZP account ID");

    const result = await this.pool.query(
      `SELECT *
       FROM account_zp_state
       WHERE account_id=$1`,
      [accountId],
    );

    return result.rows[0]
      ? mapState(result.rows[0])
      : undefined;
  }

  async listPendingAccounts(limit: number): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        "ZP pending account limit must be between 1 and 500.",
      );
    }

    const result = await this.pool.query(
      `SELECT g.actor_account_id
       FROM growth_events g
       LEFT JOIN account_zp_state z
         ON z.account_id = g.actor_account_id
       WHERE g.event_id > COALESCE(z.last_growth_event_id, 0)
       GROUP BY g.actor_account_id
       ORDER BY MIN(g.event_id), g.actor_account_id
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => String(row.actor_account_id));
  }

  async projectAccount(
    accountId: string,
    limit = 100,
  ): Promise<ZpProjectionResult> {
    validateUuid(accountId, "ZP account ID");

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new Error(
        "ZP projection limit must be between 1 and 500.",
      );
    }

    return this.tx(async (client) => {
      await client.query(
        `INSERT INTO account_zp_state (
           account_id,
           policy_version,
           total_points,
           sent_count,
           received_count,
           last_growth_event_id,
           updated_at
         )
         VALUES ($1,$2,0,0,0,0,$3)
         ON CONFLICT (account_id) DO NOTHING`,
        [
          accountId,
          ZP_POLICY_VERSION,
          this.clock(),
        ],
      );

      const stateResult = await client.query(
        `SELECT *
         FROM account_zp_state
         WHERE account_id=$1
         FOR UPDATE`,
        [accountId],
      );

      const stateRow = stateResult.rows[0];

      if (!stateRow) {
        throw new Error(
          "ZP state initialization failed.",
        );
      }

      const prior = mapState(stateRow);

      if (prior.policyVersion !== ZP_POLICY_VERSION) {
        throw new Error(
          "ZP state policy version is unsupported.",
        );
      }

      const eventsResult = await client.query(
        `SELECT *
         FROM growth_events
         WHERE actor_account_id=$1
           AND event_id>$2
         ORDER BY event_id ASC
         LIMIT $3`,
        [
          accountId,
          prior.lastGrowthEventId.toString(),
          limit,
        ],
      );

      const events = eventsResult.rows.map(mapGrowthEvent);

      if (events.length === 0) {
        return Object.freeze({
          accountId,
          processedEvents: 0,
          priorLastGrowthEventId:
            prior.lastGrowthEventId,
          lastGrowthEventId:
            prior.lastGrowthEventId,
          totalPoints: prior.totalPoints,
          sentCount: prior.sentCount,
          receivedCount: prior.receivedCount,
        });
      }

      let totalPoints = prior.totalPoints;
      let sentCount = prior.sentCount;
      let receivedCount = prior.receivedCount;

      for (const event of events) {
        const decision = evaluateZpEvent(event);

        if (!decision.eligible) {
          continue;
        }

        totalPoints += BigInt(decision.points);

        if (
          event.eventType ===
          "PAYMENT_SETTLED_SENT"
        ) {
          sentCount += 1n;
        }

        if (
          event.eventType ===
          "PAYMENT_SETTLED_RECEIVED"
        ) {
          receivedCount += 1n;
        }
      }

      const lastGrowthEventId =
        events[events.length - 1].eventId;

      const updated = await client.query(
        `UPDATE account_zp_state
         SET
           total_points=$2,
           sent_count=$3,
           received_count=$4,
           last_growth_event_id=$5,
           updated_at=$6
         WHERE account_id=$1
           AND policy_version=$7
         RETURNING *`,
        [
          accountId,
          totalPoints.toString(),
          sentCount.toString(),
          receivedCount.toString(),
          lastGrowthEventId.toString(),
          this.clock(),
          ZP_POLICY_VERSION,
        ],
      );

      if (!updated.rows[0]) {
        throw new Error(
          "ZP state projection update failed.",
        );
      }

      return Object.freeze({
        accountId,
        processedEvents: events.length,
        priorLastGrowthEventId:
          prior.lastGrowthEventId,
        lastGrowthEventId,
        totalPoints,
        sentCount,
        receivedCount,
      });
    });
  }

  private async tx<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await operation(client);

      await client.query("COMMIT");

      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapState(
  row: QueryResultRow,
): AccountZpState {
  return Object.freeze({
    accountId: String(row.account_id),
    policyVersion:
      Number(row.policy_version) as typeof ZP_POLICY_VERSION,
    totalPoints: BigInt(String(row.total_points)),
    sentCount: BigInt(String(row.sent_count)),
    receivedCount: BigInt(String(row.received_count)),
    lastGrowthEventId:
      BigInt(String(row.last_growth_event_id)),
    updatedAt:
      new Date(row.updated_at).toISOString(),
  });
}

function mapGrowthEvent(
  row: QueryResultRow,
): GrowthEvent {
  return Object.freeze({
    eventId: BigInt(String(row.event_id)),
    eventType:
      String(row.event_type) as GrowthEventType,
    actorAccountId:
      String(row.actor_account_id),
    sourceDomain:
      String(row.source_domain) as GrowthSourceDomain,
    sourceId: String(row.source_id),
    sourceEventId:
      String(row.source_event_id),
    occurredAt:
      new Date(row.occurred_at).toISOString(),
    synthetic: Boolean(row.synthetic),
    schemaVersion:
      Number(row.schema_version) as 1,
    context: cloneJsonObject(row.context),
    recordedAt:
      new Date(row.recorded_at).toISOString(),
  });
}

function cloneJsonObject(
  value: unknown,
): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Persisted growth event context must be an object.",
    );
  }

  return JSON.parse(
    JSON.stringify(value),
  ) as JsonObject;
}
