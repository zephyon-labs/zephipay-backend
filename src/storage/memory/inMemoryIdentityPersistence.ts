import {
  ACCOUNT_STATUSES,
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
import type { JsonObject } from "../../payments/paymentTypes";
import { cloneJsonObject } from "../jsonValues";
import {
  AccountVersionConflictError,
  ExternalIdentityConflictError,
  type IdentityPersistence,
} from "../../identity/identityStorageContracts";

export type InMemoryIdentityPersistenceOptions = Readonly<{
  clock?: () => string;
}>;

/** Deterministic test adapter. Production code must never select it automatically. */
export class InMemoryIdentityPersistence implements IdentityPersistence {
  private readonly accounts = new Map<string, Account>();
  private readonly actorSubjects = new Map<string, string>();
  private readonly identities = new Map<string, ExternalIdentity>();
  private readonly identityOwners = new Map<string, string>();
  private readonly sessions = new Map<string, AccountSession>();
  private readonly events = new Map<string, AccountSecurityEvent[]>();
  private nextEventId = 1n;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: InMemoryIdentityPersistenceOptions = {}) {}

  createAccount(input: Parameters<IdentityPersistence["createAccount"]>[0]): Promise<Account> {
    return this.exclusive(() => {
      validateUuid(input.accountId, "Account ID");
      if (this.accounts.has(input.accountId)) throw new Error(`Account ${input.accountId} already exists.`);
      const now = input.createdAt ?? this.now();
      validateTimestamp(now, "Account creation time");
      const account: Account = Object.freeze({
        accountId: input.accountId,
        actorSubject: actorSubjectForAccount(input.accountId),
        status: "ACTIVE",
        version: 0n,
        createdAt: now,
        updatedAt: now,
      });
      this.accounts.set(account.accountId, account);
      this.actorSubjects.set(account.actorSubject, account.accountId);
      this.appendEventUnsafe(account, "ACCOUNT_CREATED", {}, now);
      return cloneAccount(account);
    });
  }

  async findAccount(accountId: string): Promise<Account | undefined> {
    const account = this.accounts.get(accountId);
    return account ? cloneAccount(account) : undefined;
  }

  async findAccountByActorSubject(actorSubject: string): Promise<Account | undefined> {
    const accountId = this.actorSubjects.get(actorSubject);
    return accountId ? cloneAccount(this.requireAccount(accountId)) : undefined;
  }

  updateAccountStatus(input: Parameters<IdentityPersistence["updateAccountStatus"]>[0]): Promise<Account> {
    return this.exclusive(() => {
      const account = this.requireVersion(input.accountId, input.expectedVersion);
      if (!ACCOUNT_STATUSES.includes(input.status)) throw new Error("Account status is invalid.");
      if (account.status === input.status) throw new Error("Account status must change.");
      const occurredAt = input.occurredAt ?? this.now();
      validateTimestamp(occurredAt, "Account status event time");
      const updated = Object.freeze({
        ...account,
        status: input.status,
        version: account.version + 1n,
        updatedAt: occurredAt,
      });
      this.accounts.set(account.accountId, updated);
      this.appendEventUnsafe(updated, "ACCOUNT_STATUS_CHANGED", {
        previousStatus: account.status,
        status: updated.status,
      }, occurredAt);
      return cloneAccount(updated);
    });
  }

  linkExternalIdentity(input: Parameters<IdentityPersistence["linkExternalIdentity"]>[0]): Promise<Readonly<{ account: Account; identity: ExternalIdentity }>> {
    return this.exclusive(() => {
      validateUuid(input.identityId, "Identity ID");
      validateExternalIdentity(input.issuer, input.subject);
      const account = this.requireVersion(input.accountId, input.expectedAccountVersion);
      const identityKey = externalIdentityKey(input.issuer, input.subject);
      if (this.identities.has(input.identityId) || this.identityOwners.has(identityKey)) {
        throw new ExternalIdentityConflictError(input.issuer, input.subject);
      }
      const linkedAt = input.linkedAt ?? this.now();
      validateTimestamp(linkedAt, "Identity link time");
      const identity: ExternalIdentity = Object.freeze({
        identityId: input.identityId,
        issuer: input.issuer,
        subject: input.subject,
        accountId: input.accountId,
        linkedAt,
      });
      const updated = this.incrementAccount(account, linkedAt);
      this.identities.set(identity.identityId, identity);
      this.identityOwners.set(identityKey, identity.identityId);
      this.appendEventUnsafe(updated, "EXTERNAL_IDENTITY_LINKED", {}, linkedAt, {
        identityId: identity.identityId,
      });
      return { account: cloneAccount(updated), identity: cloneIdentity(identity) };
    });
  }

  provisionExternalIdentity(input: Parameters<IdentityPersistence["provisionExternalIdentity"]>[0]): Promise<Readonly<{ account: Account; identity: ExternalIdentity; created: boolean }>> {
    return this.exclusive(() => {
      validateUuid(input.accountId, "Account ID");
      validateUuid(input.identityId, "Identity ID");
      validateExternalIdentity(input.issuer, input.subject);
      const key = externalIdentityKey(input.issuer, input.subject);
      const existingId = this.identityOwners.get(key);
      if (existingId) {
        const identity = this.identities.get(existingId) as ExternalIdentity;
        return { account: cloneAccount(this.requireAccount(identity.accountId)), identity: cloneIdentity(identity), created: false };
      }
      if (this.accounts.has(input.accountId) || this.identities.has(input.identityId)) {
        throw new Error("Provisioning identifiers already exist.");
      }
      const now = input.occurredAt ?? this.now();
      validateTimestamp(now, "Provisioning time");
      const base: Account = Object.freeze({
        accountId: input.accountId, actorSubject: actorSubjectForAccount(input.accountId),
        status: "ACTIVE", version: 0n, createdAt: now, updatedAt: now,
      });
      this.accounts.set(base.accountId, base);
      this.actorSubjects.set(base.actorSubject, base.accountId);
      this.appendEventUnsafe(base, "ACCOUNT_CREATED", {}, now);
      const identity: ExternalIdentity = Object.freeze({
        identityId: input.identityId, issuer: input.issuer, subject: input.subject,
        accountId: input.accountId, linkedAt: now,
      });
      const account = this.incrementAccount(base, now);
      this.identities.set(identity.identityId, identity);
      this.identityOwners.set(key, identity.identityId);
      this.appendEventUnsafe(account, "EXTERNAL_IDENTITY_LINKED", {}, now, { identityId: identity.identityId });
      return { account: cloneAccount(account), identity: cloneIdentity(identity), created: true };
    });
  }

  async findExternalIdentity(issuer: string, subject: string): Promise<ExternalIdentity | undefined> {
    const identityId = this.identityOwners.get(externalIdentityKey(issuer, subject));
    const identity = identityId ? this.identities.get(identityId) : undefined;
    return identity ? cloneIdentity(identity) : undefined;
  }

  async listExternalIdentities(accountId: string): Promise<ExternalIdentity[]> {
    return [...this.identities.values()]
      .filter((identity) => identity.accountId === accountId)
      .sort((left, right) => left.linkedAt.localeCompare(right.linkedAt) || left.identityId.localeCompare(right.identityId))
      .map(cloneIdentity);
  }

  createAccountSession(input: Parameters<IdentityPersistence["createAccountSession"]>[0]): Promise<Readonly<{ account: Account; session: AccountSession }>> {
    return this.exclusive(() => {
      validateUuid(input.sessionId, "Session ID");
      const account = this.requireVersion(input.accountId, input.expectedAccountVersion);
      if (this.sessions.has(input.sessionId)) throw new Error(`Session ${input.sessionId} already exists.`);
      const createdAt = input.createdAt ?? this.now();
      validateTimestamp(createdAt, "Session creation time");
      validateTimestamp(input.expiresAt, "Session expiry time");
      if (Date.parse(input.expiresAt) <= Date.parse(createdAt)) throw new Error("Session expiry must be after creation.");
      const session: AccountSession = Object.freeze({
        sessionId: input.sessionId,
        accountId: input.accountId,
        createdAt,
        expiresAt: input.expiresAt,
      });
      const updated = this.incrementAccount(account, createdAt);
      this.sessions.set(session.sessionId, session);
      this.appendEventUnsafe(updated, "SESSION_CREATED", {}, createdAt, { sessionId: session.sessionId });
      return { account: cloneAccount(updated), session: cloneSession(session) };
    });
  }

  async findAccountSession(sessionId: string): Promise<AccountSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  async listAccountSessions(accountId: string): Promise<AccountSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.accountId === accountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.sessionId.localeCompare(right.sessionId))
      .map(cloneSession);
  }

  revokeAccountSession(input: Parameters<IdentityPersistence["revokeAccountSession"]>[0]): Promise<Readonly<{ account: Account; session: AccountSession }>> {
    return this.exclusive(() => {
      const account = this.requireVersion(input.accountId, input.expectedAccountVersion);
      const current = this.sessions.get(input.sessionId);
      if (!current || current.accountId !== input.accountId) throw new Error(`Session ${input.sessionId} was not found.`);
      if (current.revokedAt) throw new Error(`Session ${input.sessionId} is already revoked.`);
      const revokedAt = input.revokedAt ?? this.now();
      validateTimestamp(revokedAt, "Session revocation time");
      if (Date.parse(revokedAt) < Date.parse(current.createdAt)) throw new Error("Session revocation cannot precede creation.");
      const session = Object.freeze({ ...current, revokedAt });
      const updated = this.incrementAccount(account, revokedAt);
      this.sessions.set(session.sessionId, session);
      this.appendEventUnsafe(updated, "SESSION_REVOKED", {}, revokedAt, { sessionId: session.sessionId });
      return { account: cloneAccount(updated), session: cloneSession(session) };
    });
  }

  async listAccountSecurityEvents(accountId: string): Promise<AccountSecurityEvent[]> {
    return (this.events.get(accountId) ?? []).map(cloneEvent);
  }

  private incrementAccount(account: Account, updatedAt: string): Account {
    const updated = Object.freeze({ ...account, version: account.version + 1n, updatedAt });
    this.accounts.set(account.accountId, updated);
    return updated;
  }

  private appendEventUnsafe(account: Account, eventType: AccountSecurityEventType, details: JsonObject,
    occurredAt: string, references: { sessionId?: string; identityId?: string } = {}): void {
    const existing = this.events.get(account.accountId) ?? [];
    const event: AccountSecurityEvent = Object.freeze({
      eventId: this.nextEventId++,
      accountId: account.accountId,
      sequenceNumber: existing.length + 1,
      eventType,
      accountVersion: account.version,
      ...references,
      details: cloneJsonObject(details),
      occurredAt,
    });
    existing.push(event);
    this.events.set(account.accountId, existing);
  }

  private requireAccount(accountId: string): Account {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Account ${accountId} was not found.`);
    return account;
  }

  private requireVersion(accountId: string, expectedVersion: bigint): Account {
    const account = this.requireAccount(accountId);
    if (account.version !== expectedVersion) throw new AccountVersionConflictError(accountId);
    return account;
  }

  private now(): string {
    return (this.options.clock ?? (() => new Date().toISOString()))();
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function externalIdentityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function cloneAccount(value: Account): Account { return Object.freeze({ ...value }); }
function cloneIdentity(value: ExternalIdentity): ExternalIdentity { return Object.freeze({ ...value }); }
function cloneSession(value: AccountSession): AccountSession { return Object.freeze({ ...value }); }
function cloneEvent(value: AccountSecurityEvent): AccountSecurityEvent {
  return Object.freeze({ ...value, details: cloneJsonObject(value.details) });
}
