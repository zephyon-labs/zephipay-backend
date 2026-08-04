export type AllowlistEntry = Readonly<{
  actorSubject: string;
  enabled: boolean;
  addedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  note?: string;
}>;

export type CreateAllowlistEntryInput = Readonly<{
  actorSubject: string;
  enabled?: boolean;
  expiresAt?: string;
  note?: string;
}>;

export function hasActivePaymentAccess(
  entry: AllowlistEntry | undefined,
  now: string,
): boolean {
  return Boolean(entry?.enabled && !entry.revokedAt &&
    (entry.expiresAt === undefined || Date.parse(entry.expiresAt) > Date.parse(now)));
}
