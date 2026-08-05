import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { EconomicIdentity, PaymentDestination } from "../../economicIdentity/economicIdentityTypes";
import type { EconomicIdentityPersistence } from "../../economicIdentity/economicIdentityStorageContracts";
import {
  EconomicIdentityVersionConflictError,
  PaymentDestinationConflictError,
  UsernameConflictError,
} from "../../economicIdentity/economicIdentityStorageContracts";
import { validateDestinationPersistenceInput, validateEconomicIdentityPersistenceInput } from "../../economicIdentity/economicIdentityValidation";

export class PostgresEconomicIdentityPersistence implements EconomicIdentityPersistence {
  constructor(private readonly pool: Pool) {}

  async findEconomicIdentity(accountId: string): Promise<EconomicIdentity | undefined> {
    const result = await this.pool.query("SELECT * FROM economic_identities WHERE account_id=$1", [accountId]);
    return result.rows[0] ? mapIdentity(result.rows[0]) : undefined;
  }

  async findEconomicIdentityByUsername(normalizedUsername: string): Promise<EconomicIdentity | undefined> {
    const result = await this.pool.query("SELECT * FROM economic_identities WHERE normalized_username=$1", [normalizedUsername]);
    return result.rows[0] ? mapIdentity(result.rows[0]) : undefined;
  }

  async upsertEconomicIdentity(input: Parameters<EconomicIdentityPersistence["upsertEconomicIdentity"]>[0]): Promise<Readonly<{ identity: EconomicIdentity; created: boolean }>> {
    validateEconomicIdentityPersistenceInput(input);
    try {
      if (input.expectedVersion === undefined) {
        const result = await this.pool.query(
          `INSERT INTO economic_identities
             (account_id,account_type,username,normalized_username,display_name,avatar_url,discoverability,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()),COALESCE($8::timestamptz,now()))
           ON CONFLICT (account_id) DO NOTHING RETURNING *`,
          [input.accountId, input.accountType, input.username, input.normalizedUsername,
            input.displayName, input.avatarUrl ?? null, input.discoverability, input.occurredAt ?? null],
        );
        if (!result.rows[0]) throw new EconomicIdentityVersionConflictError(input.accountId);
        return { identity: mapIdentity(result.rows[0]), created: true };
      }
      const result = await this.pool.query(
        `UPDATE economic_identities SET account_type=$2,username=$3,normalized_username=$4,
           display_name=$5,avatar_url=$6,discoverability=$7,version=version+1,
           updated_at=COALESCE($8::timestamptz,now())
         WHERE account_id=$1 AND version=$9 RETURNING *`,
        [input.accountId, input.accountType, input.username, input.normalizedUsername,
          input.displayName, input.avatarUrl ?? null, input.discoverability,
          input.occurredAt ?? null, input.expectedVersion.toString()],
      );
      if (!result.rows[0]) throw new EconomicIdentityVersionConflictError(input.accountId);
      return { identity: mapIdentity(result.rows[0]), created: false };
    } catch (error) {
      if (isUniqueViolation(error)) throw new UsernameConflictError();
      throw error;
    }
  }

  async updateEconomicIdentityState(input: Parameters<EconomicIdentityPersistence["updateEconomicIdentityState"]>[0]): Promise<EconomicIdentity> {
    const result = await this.pool.query(
      `UPDATE economic_identities SET public_identity_status=$2,verification_state=$3,payability_state=$4,
         version=version+1,updated_at=COALESCE($5::timestamptz,now())
       WHERE account_id=$1 AND version=$6 RETURNING *`,
      [input.accountId, input.publicIdentityStatus, input.verificationState, input.payabilityState,
        input.occurredAt ?? null, input.expectedVersion.toString()],
    );
    if (!result.rows[0]) throw new EconomicIdentityVersionConflictError(input.accountId);
    return mapIdentity(result.rows[0]);
  }

  async findPaymentDestination(destinationId: string): Promise<PaymentDestination | undefined> {
    const result = await this.pool.query("SELECT * FROM payment_destinations WHERE destination_id=$1", [destinationId]);
    return result.rows[0] ? mapDestination(result.rows[0]) : undefined;
  }

  async listPaymentDestinations(accountId: string): Promise<PaymentDestination[]> {
    const result = await this.pool.query(
      "SELECT * FROM payment_destinations WHERE account_id=$1 ORDER BY is_primary DESC,created_at,destination_id", [accountId]);
    return result.rows.map(mapDestination);
  }

  upsertSolanaDestination(input: Parameters<EconomicIdentityPersistence["upsertSolanaDestination"]>[0]): Promise<Readonly<{ destination: PaymentDestination; created: boolean }>> {
    validateDestinationPersistenceInput(input);
    return this.transaction(async (client) => {
      try {
        if (input.primary) await client.query(
          `UPDATE payment_destinations SET is_primary=false,version=version+1,
             updated_at=COALESCE($2::timestamptz,now())
           WHERE account_id=$1 AND destination_type='SOLANA_WALLET' AND is_primary
             AND destination_id<>$3`, [input.accountId, input.occurredAt ?? null, input.destinationId]);
        if (input.expectedVersion === undefined) {
          const result = await client.query(
            `INSERT INTO payment_destinations
               (destination_id,account_id,destination_type,destination_address,is_primary,created_at,updated_at)
             VALUES ($1,$2,'SOLANA_WALLET',$3,$4,COALESCE($5::timestamptz,now()),COALESCE($5::timestamptz,now()))
             ON CONFLICT (destination_id) DO NOTHING RETURNING *`,
            [input.destinationId, input.accountId, input.address, input.primary, input.occurredAt ?? null],
          );
          if (!result.rows[0]) throw new PaymentDestinationConflictError("Payment destination already exists.");
          return { destination: mapDestination(result.rows[0]), created: true };
        }
        const result = await client.query(
          `UPDATE payment_destinations SET is_primary=$4,version=version+1,
             updated_at=COALESCE($5::timestamptz,now())
           WHERE destination_id=$1 AND account_id=$2 AND destination_address=$3 AND version=$6 RETURNING *`,
          [input.destinationId, input.accountId, input.address, input.primary,
            input.occurredAt ?? null, input.expectedVersion.toString()],
        );
        if (!result.rows[0]) throw new PaymentDestinationConflictError("Payment destination version is stale or destination is unavailable.");
        return { destination: mapDestination(result.rows[0]), created: false };
      } catch (error) {
        if (isUniqueViolation(error)) throw new PaymentDestinationConflictError();
        throw error;
      }
    });
  }

  async updatePaymentDestinationState(input: Parameters<EconomicIdentityPersistence["updatePaymentDestinationState"]>[0]): Promise<PaymentDestination> {
    const result = await this.pool.query(
      `UPDATE payment_destinations SET status=$3,ownership_state=$4,version=version+1,
         updated_at=COALESCE($5::timestamptz,now())
       WHERE destination_id=$1 AND account_id=$2 AND version=$6 RETURNING *`,
      [input.destinationId, input.accountId, input.status, input.ownershipState,
        input.occurredAt ?? null, input.expectedVersion.toString()],
    );
    if (!result.rows[0]) throw new PaymentDestinationConflictError("Payment destination version is stale or destination is unavailable.");
    return mapDestination(result.rows[0]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

function mapIdentity(row: QueryResultRow): EconomicIdentity {
  return Object.freeze({
    accountId: String(row.account_id), accountType: row.account_type,
    username: String(row.username), normalizedUsername: String(row.normalized_username),
    displayName: String(row.display_name), avatarUrl: optionalString(row.avatar_url),
    publicIdentityStatus: row.public_identity_status, discoverability: row.discoverability,
    verificationState: row.verification_state, payabilityState: row.payability_state,
    version: BigInt(String(row.version)), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

function mapDestination(row: QueryResultRow): PaymentDestination {
  return Object.freeze({
    destinationId: String(row.destination_id), accountId: String(row.account_id),
    destinationType: row.destination_type, address: String(row.destination_address),
    status: row.status, ownershipState: row.ownership_state, primary: Boolean(row.is_primary),
    version: BigInt(String(row.version)), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalString(value: unknown): string | undefined { return value == null ? undefined : String(value); }
function isUniqueViolation(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "23505"; }
