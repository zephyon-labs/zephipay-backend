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
