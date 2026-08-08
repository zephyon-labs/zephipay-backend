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


/**
 * Controls whether an active beta_allowlist entry is required for payment access.
 *
 * Defaults to true so missing or malformed configuration preserves the
 * existing closed-beta behavior.
 *
 * Open Mock beta environments may explicitly set:
 * BETA_ALLOWLIST_REQUIRED=false
 */
export function betaAllowlistRequired(): boolean {
  const raw = process.env.BETA_ALLOWLIST_REQUIRED;

  if (raw === undefined || raw.trim() === "") return true;

  const normalized = raw.trim().toLowerCase();

  if (normalized === "false") return false;
  if (normalized === "true") return true;

  // Fail closed on malformed configuration.
  return true;
}

export function hasActivePaymentAccess(
  entry: AllowlistEntry | undefined,
  now: string,
): boolean {
  if (!betaAllowlistRequired()) return true;
  return Boolean(entry?.enabled && !entry.revokedAt &&
    (entry.expiresAt === undefined || Date.parse(entry.expiresAt) > Date.parse(now)));
}
