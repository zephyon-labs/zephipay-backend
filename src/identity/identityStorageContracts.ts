import type {
  Account,
  AccountSecurityEvent,
  AccountSession,
  AccountStatus,
  CreateAccountInput,
  CreateAccountSessionInput,
  ExternalIdentity,
  LinkExternalIdentityInput,
} from "./identityTypes";

export interface AccountRepository {
  createAccount(input: CreateAccountInput): Promise<Account>;
  findAccount(accountId: string): Promise<Account | undefined>;
  findAccountByActorSubject(actorSubject: string): Promise<Account | undefined>;
  updateAccountStatus(input: Readonly<{
    accountId: string;
    expectedVersion: bigint;
    status: AccountStatus;
    occurredAt?: string;
  }>): Promise<Account>;
}

export interface ExternalIdentityRepository {
  linkExternalIdentity(input: LinkExternalIdentityInput): Promise<Readonly<{
    account: Account;
    identity: ExternalIdentity;
  }>>;
  findExternalIdentity(issuer: string, subject: string): Promise<ExternalIdentity | undefined>;
  listExternalIdentities(accountId: string): Promise<ExternalIdentity[]>;
}

export interface AccountSessionRepository {
  createAccountSession(input: CreateAccountSessionInput): Promise<Readonly<{
    account: Account;
    session: AccountSession;
  }>>;
  findAccountSession(sessionId: string): Promise<AccountSession | undefined>;
  listAccountSessions(accountId: string): Promise<AccountSession[]>;
  revokeAccountSession(input: Readonly<{
    sessionId: string;
    accountId: string;
    expectedAccountVersion: bigint;
    revokedAt?: string;
  }>): Promise<Readonly<{ account: Account; session: AccountSession }>>;
}

export interface AccountSecurityEventRepository {
  listAccountSecurityEvents(accountId: string): Promise<AccountSecurityEvent[]>;
}

export interface IdentityPersistence
  extends AccountRepository,
    ExternalIdentityRepository,
    AccountSessionRepository,
    AccountSecurityEventRepository {}

export class AccountVersionConflictError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} was modified by another operation.`);
    this.name = "AccountVersionConflictError";
  }
}

export class ExternalIdentityConflictError extends Error {
  constructor(issuer: string, subject: string) {
    super(`External identity (${issuer}, ${subject}) is already linked.`);
    this.name = "ExternalIdentityConflictError";
  }
}
