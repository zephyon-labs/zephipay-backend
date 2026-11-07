import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { Pool } from "pg";
import {
  createAccountSessionInTransaction,
  revokeAccountSessionInTransaction,
} from "../storage/postgres/postgresIdentityPersistence";
import type {
  Account,
  Binding,
  CanonicalSession,
  LoginAttemptId,
  NativeBindingReference,
  SessionPersistence,
  SessionTransaction,
} from "./contracts";
import { accountSnapshot, bindingSnapshot, sessionSnapshot } from "./records";
import { accountId, attemptId, bindingReference, data, sessionId, text, time } from "./values";

const bindingColumns = `login_attempt_id AS "loginAttemptId", binding_reference AS "nativeBindingReference",
  environment, issuer, client_id AS "clientId", audience, creation_key AS "creationKey", challenge,
  access_commitment AS "accessCommitment", revocation_commitment AS "revocationCommitment",
  created_at_ms::text AS "createdAt", attempt_expires_at_ms::text AS "attemptExpiresAt",
  last_observed_at_ms::text AS "lastObservedAt", attempt_state AS "attemptState", state,
  owner_subject AS "ownerSubject", account_id::text AS "accountId", canonical_session_id::text AS "canonicalAccountSessionId"`;
const accountColumns = `account_id::text AS "accountId", actor_subject AS "actorSubject", status,
  version::text, ceil(extract(epoch FROM updated_at)*1000)::text AS "updatedAt"`;
const sessionColumns = `session_id::text AS "canonicalAccountSessionId", account_id::text AS "accountId",
  ceil(extract(epoch FROM created_at)*1000)::text AS "createdAt",
  floor(extract(epoch FROM expires_at)*1000)::text AS "expiresAt",
  ceil(extract(epoch FROM revoked_at)*1000)::text AS "revokedAt"`;
const bindingFields = [
  "loginAttemptId",
  "nativeBindingReference",
  "environment",
  "issuer",
  "clientId",
  "audience",
  "creationKey",
  "challenge",
  "accessCommitment",
  "revocationCommitment",
  "createdAt",
  "attemptExpiresAt",
  "lastObservedAt",
  "attemptState",
  "state",
  "ownerSubject",
  "accountId",
  "canonicalAccountSessionId",
] as const;

function row(value: unknown, fields: readonly string[]) {
  if (types.isProxy(value)) throw new Error("Database row proxy rejected");
  return data(value, fields);
}
function integer(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new Error("Invalid database integer");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new Error("Database integer exceeds bigint range");
  return parsed;
}
function milliseconds(value: unknown): number {
  return time(Number(integer(value)));
}
function mapBinding(value: unknown): Binding {
  const r = row(value, bindingFields);
  const unowned =
    r.ownerSubject === null && r.accountId === null && r.canonicalAccountSessionId === null;
  return bindingSnapshot({
    loginAttemptId: r.loginAttemptId,
    nativeBindingReference: r.nativeBindingReference,
    context: {
      environment: r.environment,
      issuer: r.issuer,
      clientId: r.clientId,
      audience: r.audience,
    },
    creationKey: r.creationKey,
    challenge: r.challenge,
    accessCommitment: r.accessCommitment,
    revocationCommitment: r.revocationCommitment,
    createdAt: milliseconds(r.createdAt),
    attemptExpiresAt: milliseconds(r.attemptExpiresAt),
    lastObservedAt: milliseconds(r.lastObservedAt),
    attemptState: r.attemptState,
    state: r.state,
    ...(unowned
      ? {}
      : {
          owner: { issuer: r.issuer, subject: r.ownerSubject, accountId: r.accountId },
          canonicalAccountSessionId: r.canonicalAccountSessionId,
        }),
  });
}
function mapAccount(value: unknown): Account {
  const r = row(value, ["accountId", "actorSubject", "status", "version", "updatedAt"]);
  return accountSnapshot({
    ...r,
    version: integer(r.version),
    updatedAt: milliseconds(r.updatedAt),
  });
}
function mapSession(value: unknown): CanonicalSession {
  const r = row(value, [
    "canonicalAccountSessionId",
    "accountId",
    "createdAt",
    "expiresAt",
    "revokedAt",
  ]);
  return sessionSnapshot({
    ...r,
    createdAt: milliseconds(r.createdAt),
    expiresAt: milliseconds(r.expiresAt),
    revokedAt: r.revokedAt === null ? null : milliseconds(r.revokedAt),
  });
}

/** Unmounted candidate. The caller supplies a pool; there is no environment lookup or connection on import. */
export class PostgresNativeSessionPersistence implements SessionPersistence {
  readonly productionReady = false;
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async bindingForAttempt(id: LoginAttemptId): Promise<NativeBindingReference | null> {
    const result = await this.pool.query(
      "SELECT binding_reference AS reference FROM native_session_candidate.bindings WHERE login_attempt_id=$1",
      [attemptId(id)],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error("Ambiguous attempt");
    return bindingReference(row(result.rows[0], ["reference"]).reference);
  }

  async transaction<T>(
    reference: NativeBindingReference,
    body: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T> {
    bindingReference(reference);
    const client = await this.pool.connect();
    let open = false,
      poisoned = false,
      destroy = false;
    let pending: Promise<unknown> | null = null;
    const drain = async () => {
      if (pending) await pending.catch(() => {});
    };
    // One leased connection, sequential operations. Escaped/unawaited handles cannot outlive BEGIN/COMMIT.
    const operation = <V>(work: () => Promise<V>): Promise<V> => {
      if (!open || pending || poisoned) {
        poisoned = true;
        const rejected = Promise.reject<V>(
          new Error("Inactive or concurrent transaction operation"),
        );
        void rejected.catch(() => {});
        return rejected;
      }
      const task = Promise.resolve()
        .then(work)
        .then((value) => {
          if (!open || poisoned) throw new Error("Transaction lease ended");
          return value;
        })
        .catch((error) => {
          poisoned = true;
          throw error;
        })
        .finally(() => {
          pending = null;
        });
      pending = task;
      void task.catch(() => {});
      return task;
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL search_path=pg_catalog,public,pg_temp");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
      const selected = await client.query(
        `SELECT ${bindingColumns} FROM native_session_candidate.bindings WHERE binding_reference=$1 FOR UPDATE`,
        [reference],
      );
      if (selected.rows.length > 1) throw new Error("Ambiguous binding");
      let binding = selected.rows.length ? mapBinding(selected.rows[0]) : null;
      if (binding && binding.nativeBindingReference !== reference)
        throw new Error("Binding mismatch");
      let account: Account | null = null,
        session: CanonicalSession | null = null;
      let resolved: string | null | undefined;
      let observed: number | null = null;
      let mutation: "created" | "revoked" | null = null;
      const checkMutation = () => {
        if (
          mutation &&
          (!binding ||
            !session ||
            binding.canonicalAccountSessionId !== session.canonicalAccountSessionId ||
            binding.state !== (mutation === "created" ? "ACTIVE" : "REVOKED"))
        )
          throw new Error("Canonical mutation lacks binding transition");
      };
      const requireBinding = () => {
        if (!binding) throw new Error("Missing binding");
        return binding;
      };
      const requireAccount = (value: Account) => {
        const a = accountSnapshot(value);
        if (
          !account ||
          JSON.stringify({ ...a, version: a.version.toString() }) !==
            JSON.stringify({ ...account, version: account.version.toString() })
        )
          throw new Error("Unlocked or stale account");
        return a;
      };
      const readSession = async (id: string) => {
        const result = await client.query(
          `SELECT ${sessionColumns} FROM public.account_sessions WHERE session_id=$1 FOR UPDATE`,
          [id],
        );
        if (result.rows.length !== 1) throw new Error("Missing canonical session");
        const s = mapSession(result.rows[0]);
        if (s.canonicalAccountSessionId !== id || !account || s.accountId !== account.accountId)
          throw new Error("Canonical session mismatch");
        return s;
      };
      open = true;
      const tx: SessionTransaction = Object.freeze({
        binding: () => operation(async () => binding),
        resolveExisting: (issuer: string, subject: string) =>
          operation(async () => {
            const b = requireBinding();
            if (account || session || b.state !== "PENDING" || text(issuer) !== b.context.issuer)
              throw new Error("Invalid identity resolution order");
            const result = await client.query(
              'SELECT account_id::text AS "accountId" FROM public.external_identities WHERE issuer=$1 AND subject=$2',
              [issuer, text(subject)],
            );
            if (result.rows.length > 1) throw new Error("Ambiguous canonical identity");
            resolved = result.rows.length
              ? accountId(row(result.rows[0], ["accountId"]).accountId)
              : null;
            return resolved;
          }),
        lockAccount: (id: string) =>
          operation(async () => {
            const b = requireBinding();
            accountId(id);
            if (
              session ||
              (account && account.accountId !== id) ||
              id !== (b.owner?.accountId ?? resolved)
            )
              throw new Error("Account lock order or identity mismatch");
            const result = await client.query(
              `SELECT ${accountColumns} FROM public.accounts WHERE account_id=$1 FOR UPDATE`,
              [id],
            );
            if (result.rows.length !== 1) throw new Error("Missing canonical account");
            const a = mapAccount(result.rows[0]);
            if (a.accountId !== id) throw new Error("Locked account mismatch");
            account = a;
            return a;
          }),
        lockSession: (id: string) =>
          operation(async () => {
            const b = requireBinding();
            sessionId(id);
            if (
              !account ||
              (session && session.canonicalAccountSessionId !== id) ||
              b.canonicalAccountSessionId !== id
            )
              throw new Error("Account-before-session lock required");
            session = await readSession(id);
            return session;
          }),
        observeTime: () =>
          operation(async () => {
            const b = requireBinding();
            if (b.owner && (!account || !session))
              throw new Error("Clock requires canonical locks");
            const result = await client.query(
              "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS observed",
            );
            if (result.rows.length !== 1) throw new Error("Missing database clock");
            observed = milliseconds(row(result.rows[0], ["observed"]).observed);
            return observed;
          }),
        saveBinding: (value: Binding) =>
          operation(async () => {
            const old = requireBinding(),
              next = bindingSnapshot(value);
            if (observed === null || next.lastObservedAt !== observed)
              throw new Error("Binding write lacks observed database time");
            for (const key of [
              "loginAttemptId",
              "nativeBindingReference",
              "creationKey",
              "challenge",
              "accessCommitment",
              "revocationCommitment",
              "createdAt",
              "attemptExpiresAt",
            ] as const)
              if (old[key] !== next[key]) throw new Error("Immutable binding changed");
            if (
              JSON.stringify(old.context) !== JSON.stringify(next.context) ||
              (old.owner &&
                (JSON.stringify(old.owner) !== JSON.stringify(next.owner) ||
                  old.canonicalAccountSessionId !== next.canonicalAccountSessionId))
            )
              throw new Error("Binding context or owner changed");
            if (
              next.owner &&
              (next.owner.accountId !== account?.accountId ||
                next.canonicalAccountSessionId !== session?.canonicalAccountSessionId)
            )
              throw new Error("Binding write lacks canonical locks");
            const result = await client.query(
              `UPDATE native_session_candidate.bindings SET last_observed_at_ms=$2, state=$3, attempt_state=$4,
            owner_subject=$5, account_id=$6, canonical_session_id=$7 WHERE binding_reference=$1 AND state=$8 AND last_observed_at_ms=$9 RETURNING ${bindingColumns}`,
              [
                reference,
                next.lastObservedAt,
                next.state,
                next.attemptState,
                next.owner?.subject ?? null,
                next.owner?.accountId ?? null,
                next.canonicalAccountSessionId ?? null,
                old.state,
                old.lastObservedAt,
              ],
            );
            if (result.rows.length !== 1 || result.rowCount !== 1)
              throw new Error("Binding generation changed");
            const saved = mapBinding(result.rows[0]);
            if (JSON.stringify(saved) !== JSON.stringify(next))
              throw new Error("Contradictory binding write");
            binding = saved;
          }),
        createSession: (value: Account, createdAt: number, expiresAt: number) =>
          operation(async () => {
            const b = requireBinding(),
              a = requireAccount(value);
            if (
              b.state !== "PENDING" ||
              b.attemptState !== "PENDING" ||
              b.owner ||
              session ||
              a.status !== "ACTIVE" ||
              observed !== time(createdAt) ||
              createdAt >= b.attemptExpiresAt ||
              time(expiresAt) <= createdAt
            )
              throw new Error("Invalid canonical creation");
            const id = sessionId(randomUUID());
            await createAccountSessionInTransaction(client, {
              accountId: a.accountId,
              expectedAccountVersion: a.version,
              sessionId: id,
              createdAt: new Date(createdAt).toISOString(),
              expiresAt: new Date(expiresAt).toISOString(),
            });
            mutation = "created";
            session = await readSession(id);
            return session;
          }),
        revokeSession: (value: Account, sessionValue: CanonicalSession, revokedAt: number) =>
          operation(async () => {
            const b = requireBinding(),
              a = requireAccount(value),
              s = sessionSnapshot(sessionValue);
            if (
              b.state !== "ACTIVE" ||
              !session ||
              JSON.stringify(s) !== JSON.stringify(session) ||
              session.revokedAt !== null ||
              observed !== time(revokedAt)
            )
              throw new Error("Invalid canonical revocation");
            await revokeAccountSessionInTransaction(client, {
              accountId: a.accountId,
              expectedAccountVersion: a.version,
              sessionId: s.canonicalAccountSessionId,
              revokedAt: new Date(revokedAt).toISOString(),
            });
            mutation = "revoked";
            session = await readSession(s.canonicalAccountSessionId);
          }),
      });
      const result = await body(tx);
      if (pending || poisoned) throw new Error("Incomplete or failed transaction operation");
      checkMutation();
      open = false;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      open = false;
      destroy = true;
      await drain();
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Commit outcome can remain unknown. Never return the callback result. */
      }
      throw error;
    } finally {
      open = false;
      client.release(destroy);
    }
  }
}
