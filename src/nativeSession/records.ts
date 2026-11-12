import { types } from "node:util";
import type { Account, Binding, CanonicalSession } from "./contracts";
import {
  accountId,
  attemptId,
  bindingReference,
  data,
  digest,
  owns,
  sessionId,
  text,
  time,
} from "./values";

/** Persistence is a typed seam, not permission to execute getters or trust mutable records. */
function record(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  // Even descriptor reflection on a Proxy can run code or fabricate changing data.
  if (types.isProxy(value)) throw new Error("Persistence proxy rejected");
  return data(value, required, optional);
}

function state<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new Error("Unknown persistence state");
  return value as T;
}

export function accountSnapshot(value: unknown): Account {
  const a = record(value, ["accountId", "actorSubject", "status", "version", "updatedAt"]);
  const id = accountId(a.accountId);
  if (a.actorSubject !== `zp:account:${id}` || typeof a.version !== "bigint" || a.version < 0n)
    throw new Error("Invalid canonical account");
  return Object.freeze({
    accountId: id,
    actorSubject: a.actorSubject,
    status: state(a.status, ["ACTIVE", "SUSPENDED", "DELETION_PENDING", "DELETED"] as const),
    version: a.version,
    updatedAt: time(a.updatedAt),
  });
}

export function sessionSnapshot(value: unknown): CanonicalSession {
  const s = record(value, [
    "canonicalAccountSessionId",
    "accountId",
    "createdAt",
    "expiresAt",
    "revokedAt",
  ]);
  const createdAt = time(s.createdAt),
    expiresAt = time(s.expiresAt);
  const revokedAt = s.revokedAt === null ? null : time(s.revokedAt);
  if (expiresAt <= createdAt || (revokedAt !== null && revokedAt < createdAt))
    throw new Error("Invalid canonical session state");
  return Object.freeze({
    canonicalAccountSessionId: sessionId(s.canonicalAccountSessionId),
    accountId: accountId(s.accountId),
    createdAt,
    expiresAt,
    revokedAt,
  });
}

export function bindingSnapshot(value: unknown): Binding {
  const b = record(
    value,
    [
      "loginAttemptId",
      "nativeBindingReference",
      "context",
      "creationKey",
      "challenge",
      "accessCommitment",
      "revocationCommitment",
      "createdAt",
      "attemptExpiresAt",
      "lastObservedAt",
      "attemptState",
      "state",
    ],
    ["owner", "canonicalAccountSessionId"],
  );
  const c = record(b.context, ["environment", "issuer", "clientId", "audience"]);
  const context = Object.freeze({
    environment: text(c.environment),
    issuer: text(c.issuer),
    clientId: text(c.clientId),
    audience: text(c.audience),
  });
  const createdAt = time(b.createdAt),
    attemptExpiresAt = time(b.attemptExpiresAt),
    lastObservedAt = time(b.lastObservedAt);
  if (attemptExpiresAt <= createdAt || lastObservedAt < createdAt)
    throw new Error("Invalid binding times");
  const attemptState = state(b.attemptState, [
    "PENDING",
    "COMPLETED",
    "CANCELLED",
    "EXPIRED",
  ] as const);
  const bindingState = state(b.state, [
    "PENDING",
    "ACTIVE",
    "CANCELLED",
    "EXPIRED",
    "REVOKED",
  ] as const);
  let owner: Binding["owner"], canonicalAccountSessionId: Binding["canonicalAccountSessionId"];
  if (owns(b, "owner")) {
    const o = record(b.owner, ["issuer", "subject", "accountId"]);
    owner = Object.freeze({
      issuer: text(o.issuer),
      subject: text(o.subject),
      accountId: accountId(o.accountId),
    });
    if (owner.issuer !== context.issuer) throw new Error("Owner issuer mismatch");
  }
  if (owns(b, "canonicalAccountSessionId"))
    canonicalAccountSessionId = sessionId(b.canonicalAccountSessionId);
  if ((owner !== undefined) !== (canonicalAccountSessionId !== undefined))
    throw new Error("Incomplete canonical linkage");
  if (attemptState === "COMPLETED") {
    if (!owner || !["ACTIVE", "REVOKED", "EXPIRED"].includes(bindingState))
      throw new Error("Invalid completed binding");
  } else if (owner || bindingState !== attemptState) {
    throw new Error("Invalid uncompleted binding");
  }
  if (bindingState === "EXPIRED" && !owner && lastObservedAt < attemptExpiresAt)
    throw new Error("Unobserved attempt expiry");
  return Object.freeze({
    loginAttemptId: attemptId(b.loginAttemptId),
    nativeBindingReference: bindingReference(b.nativeBindingReference),
    context,
    creationKey: digest(b.creationKey),
    challenge: digest(b.challenge),
    accessCommitment: digest(b.accessCommitment),
    revocationCommitment: digest(b.revocationCommitment),
    createdAt,
    attemptExpiresAt,
    lastObservedAt,
    attemptState,
    state: bindingState,
    ...(owner ? { owner, canonicalAccountSessionId: canonicalAccountSessionId! } : {}),
  });
}
