import type { Pool, PoolClient, QueryResultRow } from "pg";

import { observeTransaction } from "../../observability/reliabilityObservability";

import {
  actorSubjectForAccount,
  type Account,
  type AccountSecurityEvent,
  type AccountSecurityEventType,
  type AccountSession,
  type ExternalIdentity,
  validateExternalIdentity,
  validateTimestamp,
  validateUuid,
} from "../../identity/identityTypes";
import {
  AccountVersionConflictError,
  ExternalIdentityConflictError,
  type IdentityPersistence,
} from "../../identity/identityStorageContracts";

export class PostgresIdentityPersistence implements IdentityPersistence {
  constructor(private readonly pool: Pool) {}

  createAccount(input: Parameters<IdentityPersistence["createAccount"]>[0]): Promise<Account> {
    validateUuid(input.accountId, "Account ID");
    if (input.createdAt) validateTimestamp(input.createdAt, "Account creation time");
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO accounts (account_id, actor_subject, created_at, updated_at)
         VALUES ($1,$2,COALESCE($3::timestamptz,now()),COALESCE($3::timestamptz,now()))
         RETURNING *`,
        [input.accountId, actorSubjectForAccount(input.accountId), input.createdAt ?? null],
      );
      const account = mapAccount(result.rows[0]);
      await appendSecurityEvent(client, account, "ACCOUNT_CREATED", account.createdAt);
      return account;
    });
  }

  async findAccount(accountId: string): Promise<Account | undefined> {
    const result = await this.pool.query("SELECT * FROM accounts WHERE account_id=$1", [accountId]);
    return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
  }

  async findAccountByActorSubject(actorSubject: string): Promise<Account | undefined> {
    const result = await this.pool.query("SELECT * FROM accounts WHERE actor_subject=$1", [actorSubject]);
    return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
  }

  updateAccountStatus(input: Parameters<IdentityPersistence["updateAccountStatus"]>[0]): Promise<Account> {
    if (input.occurredAt) validateTimestamp(input.occurredAt, "Account status event time");
    return this.transaction(async (client) => {
      const current = await lockAccount(client, input.accountId);
      requireVersion(current, input.expectedVersion);
      if (current.status === input.status) throw new Error("Account status must change.");
      const result = await client.query(
        `UPDATE accounts SET status=$2, version=version+1,
           updated_at=COALESCE($3::timestamptz,now())
         WHERE account_id=$1 AND version=$4 RETURNING *`,
        [input.accountId, input.status, input.occurredAt ?? null, current.version.toString()],
      );
      if (!result.rows[0]) throw new AccountVersionConflictError(input.accountId);
      const account = mapAccount(result.rows[0]);
      await appendSecurityEvent(client, account, "ACCOUNT_STATUS_CHANGED", account.updatedAt, {
        details: { previousStatus: current.status, status: account.status },
      });
      return account;
    });
  }

  linkExternalIdentity(input: Parameters<IdentityPersistence["linkExternalIdentity"]>[0]): Promise<Readonly<{ account: Account; identity: ExternalIdentity }>> {
    validateUuid(input.identityId, "Identity ID");
    validateExternalIdentity(input.issuer, input.subject);
    if (input.linkedAt) validateTimestamp(input.linkedAt, "Identity link time");
    return this.transaction(async (client) => {
      const current = await lockAccount(client, input.accountId);
      requireVersion(current, input.expectedAccountVersion);
      let identityResult;
      try {
        identityResult = await client.query(
          `INSERT INTO external_identities
             (identity_id,issuer,subject,account_id,linked_at)
           VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz,now())) RETURNING *`,
          [input.identityId, input.issuer, input.subject, input.accountId, input.linkedAt ?? null],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new ExternalIdentityConflictError(input.issuer, input.subject);
        throw error;
      }
      const identity = mapExternalIdentity(identityResult.rows[0]);
      const account = await incrementAccount(client, current, identity.linkedAt);
      await appendSecurityEvent(client, account, "EXTERNAL_IDENTITY_LINKED", identity.linkedAt, {
        identityId: identity.identityId,
      });
      return { account, identity };
    });
  }

  provisionExternalIdentity(input: Parameters<IdentityPersistence["provisionExternalIdentity"]>[0]): Promise<Readonly<{ account: Account; identity: ExternalIdentity; created: boolean }>> {
    validateUuid(input.accountId, "Account ID");
    validateUuid(input.identityId, "Identity ID");
    validateExternalIdentity(input.issuer, input.subject);
    if (input.occurredAt) validateTimestamp(input.occurredAt, "Provisioning time");
    return this.transaction(async (client) => {
      // Serialize only callers provisioning the same validated provider identity.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([input.issuer, input.subject])]);
      const found = await client.query(
        "SELECT * FROM external_identities WHERE issuer=$1 AND subject=$2",
        [input.issuer, input.subject],
      );
      if (found.rows[0]) {
        const identity = mapExternalIdentity(found.rows[0]);
        const account = await lockAccount(client, identity.accountId);
        return { account, identity, created: false };
      }
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const accountResult = await client.query(
        `INSERT INTO accounts (account_id,actor_subject,created_at,updated_at)
         VALUES ($1,$2,$3,$3) RETURNING *`,
        [input.accountId, actorSubjectForAccount(input.accountId), occurredAt],
      );
      const base = mapAccount(accountResult.rows[0]);
      await appendSecurityEvent(client, base, "ACCOUNT_CREATED", base.createdAt);
      const identityResult = await client.query(
        `INSERT INTO external_identities (identity_id,issuer,subject,account_id,linked_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [input.identityId, input.issuer, input.subject, input.accountId, base.createdAt],
      );
      const identity = mapExternalIdentity(identityResult.rows[0]);
      const account = await incrementAccount(client, base, identity.linkedAt);
      await appendSecurityEvent(client, account, "EXTERNAL_IDENTITY_LINKED", identity.linkedAt, { identityId: identity.identityId });
      return { account, identity, created: true };
    });
  }

  async findExternalIdentity(issuer: string, subject: string): Promise<ExternalIdentity | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM external_identities WHERE issuer=$1 AND subject=$2",
      [issuer, subject],
    );
    return result.rows[0] ? mapExternalIdentity(result.rows[0]) : undefined;
  }

  async listExternalIdentities(accountId: string): Promise<ExternalIdentity[]> {
    const result = await this.pool.query(
      "SELECT * FROM external_identities WHERE account_id=$1 ORDER BY linked_at, identity_id",
      [accountId],
    );
    return result.rows.map(mapExternalIdentity);
  }

  createAccountSession(input: Parameters<IdentityPersistence["createAccountSession"]>[0]): Promise<Readonly<{ account: Account; session: AccountSession }>> {
    validateUuid(input.sessionId, "Session ID");
    validateTimestamp(input.expiresAt, "Session expiry time");
    if (input.createdAt) validateTimestamp(input.createdAt, "Session creation time");
    if (input.createdAt && Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) {
      throw new Error("Session expiry must be after creation.");
    }
    return this.transaction(async (client) => {
      const current = await lockAccount(client, input.accountId);
      requireVersion(current, input.expectedAccountVersion);
      const result = await client.query(
        `INSERT INTO account_sessions (session_id,account_id,created_at,expires_at)
         VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4) RETURNING *`,
        [input.sessionId, input.accountId, input.createdAt ?? null, input.expiresAt],
      );
      const session = mapAccountSession(result.rows[0]);
      const account = await incrementAccount(client, current, session.createdAt);
      await appendSecurityEvent(client, account, "SESSION_CREATED", session.createdAt, {
        sessionId: session.sessionId,
      });
      return { account, session };
    });
  }

  async findAccountSession(sessionId: string): Promise<AccountSession | undefined> {
    const result = await this.pool.query("SELECT * FROM account_sessions WHERE session_id=$1", [sessionId]);
    return result.rows[0] ? mapAccountSession(result.rows[0]) : undefined;
  }

  async listAccountSessions(accountId: string): Promise<AccountSession[]> {
    const result = await this.pool.query(
      "SELECT * FROM account_sessions WHERE account_id=$1 ORDER BY created_at DESC, session_id",
      [accountId],
    );
    return result.rows.map(mapAccountSession);
  }

  revokeAccountSession(input: Parameters<IdentityPersistence["revokeAccountSession"]>[0]): Promise<Readonly<{ account: Account; session: AccountSession }>> {
    if (input.revokedAt) validateTimestamp(input.revokedAt, "Session revocation time");
    return this.transaction(async (client) => {
      const current = await lockAccount(client, input.accountId);
      requireVersion(current, input.expectedAccountVersion);
      const result = await client.query(
        `UPDATE account_sessions SET revoked_at=COALESCE($3::timestamptz,now())
         WHERE session_id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING *`,
        [input.sessionId, input.accountId, input.revokedAt ?? null],
      );
      if (!result.rows[0]) throw new Error(`Session ${input.sessionId} was not found or is already revoked.`);
      const session = mapAccountSession(result.rows[0]);
      const account = await incrementAccount(client, current, session.revokedAt as string);
      await appendSecurityEvent(client, account, "SESSION_REVOKED", session.revokedAt as string, {
        sessionId: session.sessionId,
      });
      return { account, session };
    });
  }

  async listAccountSecurityEvents(accountId: string): Promise<AccountSecurityEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM account_security_events WHERE account_id=$1 ORDER BY sequence_number",
      [accountId],
    );
    return result.rows.map(mapSecurityEvent);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await observeTransaction(this.pool, async () => {
        try {
          await client.query("BEGIN");
          const result = await operation(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }
}

async function lockAccount(client: PoolClient, accountId: string): Promise<Account> {
  const result = await client.query("SELECT * FROM accounts WHERE account_id=$1 FOR UPDATE", [accountId]);
  if (!result.rows[0]) throw new Error(`Account ${accountId} was not found.`);
  return mapAccount(result.rows[0]);
}

function requireVersion(account: Account, expectedVersion: bigint): void {
  if (account.version !== expectedVersion) throw new AccountVersionConflictError(account.accountId);
}

async function incrementAccount(client: PoolClient, current: Account, updatedAt: string): Promise<Account> {
  const result = await client.query(
    `UPDATE accounts SET version=version+1, updated_at=$2
     WHERE account_id=$1 AND version=$3 RETURNING *`,
    [current.accountId, updatedAt, current.version.toString()],
  );
  if (!result.rows[0]) throw new AccountVersionConflictError(current.accountId);
  return mapAccount(result.rows[0]);
}

async function appendSecurityEvent(
  client: PoolClient,
  account: Account,
  eventType: AccountSecurityEventType,
  occurredAt: string,
  input: { sessionId?: string; identityId?: string; details?: Record<string, string> } = {},
): Promise<AccountSecurityEvent> {
  const result = await client.query(
    `INSERT INTO account_security_events
       (account_id,sequence_number,event_type,account_version,session_id,identity_id,details,occurred_at)
     SELECT $1,COALESCE(MAX(sequence_number),0)+1,$2,$3,$4,$5,$6,$7
     FROM account_security_events WHERE account_id=$1 RETURNING *`,
    [account.accountId, eventType, account.version.toString(), input.sessionId ?? null,
      input.identityId ?? null, JSON.stringify(input.details ?? {}), occurredAt],
  );
  return mapSecurityEvent(result.rows[0]);
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }

function mapAccount(row: QueryResultRow): Account {
  return Object.freeze({
    accountId: String(row.account_id), actorSubject: String(row.actor_subject),
    status: row.status, version: BigInt(String(row.version)),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

function mapExternalIdentity(row: QueryResultRow): ExternalIdentity {
  return Object.freeze({
    identityId: String(row.identity_id), issuer: String(row.issuer), subject: String(row.subject),
    accountId: String(row.account_id), linkedAt: iso(row.linked_at),
  });
}

function mapAccountSession(row: QueryResultRow): AccountSession {
  return Object.freeze({
    sessionId: String(row.session_id), accountId: String(row.account_id),
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at == null ? undefined : iso(row.revoked_at),
  });
}

function mapSecurityEvent(row: QueryResultRow): AccountSecurityEvent {
  return Object.freeze({
    eventId: BigInt(String(row.event_id)), accountId: String(row.account_id),
    sequenceNumber: Number(row.sequence_number), eventType: row.event_type,
    accountVersion: BigInt(String(row.account_version)),
    sessionId: row.session_id == null ? undefined : String(row.session_id),
    identityId: row.identity_id == null ? undefined : String(row.identity_id),
    details: Object.freeze({ ...(row.details ?? {}) }), occurredAt: iso(row.occurred_at),
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
