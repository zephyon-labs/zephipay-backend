import type { JsonObject } from "../payments/paymentTypes";

export const ACCOUNT_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "DELETION_PENDING",
  "DELETED",
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_SECURITY_EVENT_TYPES = [
  "ACCOUNT_CREATED",
  "ACCOUNT_STATUS_CHANGED",
  "EXTERNAL_IDENTITY_LINKED",
  "SESSION_CREATED",
  "SESSION_REVOKED",
] as const;

export type AccountSecurityEventType =
  (typeof ACCOUNT_SECURITY_EVENT_TYPES)[number];

export type Account = Readonly<{
  accountId: string;
  actorSubject: string;
  status: AccountStatus;
  version: bigint;
  createdAt: string;
  updatedAt: string;
}>;

export type ExternalIdentity = Readonly<{
  identityId: string;
  issuer: string;
  subject: string;
  accountId: string;
  linkedAt: string;
}>;

export type AccountSession = Readonly<{
  sessionId: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}>;

export type AccountSecurityEvent = Readonly<{
  eventId: bigint;
  accountId: string;
  sequenceNumber: number;
  eventType: AccountSecurityEventType;
  accountVersion: bigint;
  sessionId?: string;
  identityId?: string;
  details: JsonObject;
  occurredAt: string;
}>;

export type CreateAccountInput = Readonly<{
  accountId: string;
  createdAt?: string;
}>;

export type LinkExternalIdentityInput = Readonly<{
  identityId: string;
  accountId: string;
  expectedAccountVersion: bigint;
  issuer: string;
  subject: string;
  linkedAt?: string;
}>;

export type CreateAccountSessionInput = Readonly<{
  sessionId: string;
  accountId: string;
  expectedAccountVersion: bigint;
  expiresAt: string;
  createdAt?: string;
}>;

export function actorSubjectForAccount(accountId: string): string {
  validateUuid(accountId, "Account ID");
  return `zp:account:${accountId.toLowerCase()}`;
}

export function validateUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a canonical UUID.`);
  }
}

export function validateExternalIdentity(issuer: string, subject: string): void {
  if (issuer.trim() !== issuer || issuer.length < 1 || issuer.length > 512) {
    throw new Error("External identity issuer must be between 1 and 512 characters without surrounding whitespace.");
  }
  if (subject.trim() !== subject || subject.length < 1 || subject.length > 512) {
    throw new Error("External identity subject must be between 1 and 512 characters without surrounding whitespace.");
  }
}

export function validateTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp.`);
  }
}
