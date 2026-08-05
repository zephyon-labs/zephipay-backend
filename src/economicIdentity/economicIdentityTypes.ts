export const ECONOMIC_ACCOUNT_TYPES = ["PERSONAL", "CREATOR", "BUSINESS", "AI_AGENT"] as const;
export type EconomicAccountType = (typeof ECONOMIC_ACCOUNT_TYPES)[number];

export const DISCOVERABILITY_LEVELS = ["PRIVATE", "USERNAME_ONLY", "PUBLIC"] as const;
export type Discoverability = (typeof DISCOVERABILITY_LEVELS)[number];

export const IDENTITY_VERIFICATION_STATES = ["UNVERIFIED", "PENDING", "VERIFIED", "RESTRICTED"] as const;
export type IdentityVerificationState = (typeof IDENTITY_VERIFICATION_STATES)[number];

export const PAYABILITY_STATES = ["AVAILABLE", "UNAVAILABLE", "RESTRICTED"] as const;
export type PayabilityState = (typeof PAYABILITY_STATES)[number];

export const PUBLIC_IDENTITY_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type PublicIdentityStatus = (typeof PUBLIC_IDENTITY_STATUSES)[number];

export const DESTINATION_TYPES = ["SOLANA_WALLET"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const DESTINATION_STATUSES = ["ACTIVE", "INACTIVE", "RESTRICTED"] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

export const DESTINATION_OWNERSHIP_STATES = ["UNVERIFIED", "VERIFIED", "REJECTED"] as const;
export type DestinationOwnershipState = (typeof DESTINATION_OWNERSHIP_STATES)[number];

export type EconomicIdentity = Readonly<{
  accountId: string;
  accountType: EconomicAccountType;
  username: string;
  normalizedUsername: string;
  displayName: string;
  avatarUrl?: string;
  publicIdentityStatus: PublicIdentityStatus;
  discoverability: Discoverability;
  verificationState: IdentityVerificationState;
  payabilityState: PayabilityState;
  version: bigint;
  createdAt: string;
  updatedAt: string;
}>;

export type PaymentDestination = Readonly<{
  destinationId: string;
  accountId: string;
  destinationType: DestinationType;
  address: string;
  status: DestinationStatus;
  ownershipState: DestinationOwnershipState;
  primary: boolean;
  version: bigint;
  createdAt: string;
  updatedAt: string;
}>;

export type PublicRecipient = Readonly<{
  accountId: string;
  username: string;
  displayName: string;
  accountType: EconomicAccountType;
  verificationState: IdentityVerificationState;
  payabilityState: PayabilityState;
  avatarUrl?: string;
}>;

export type UpsertEconomicIdentityInput = Readonly<{
  accountId: string;
  expectedVersion?: bigint;
  accountType: EconomicAccountType;
  username: string;
  normalizedUsername: string;
  displayName: string;
  avatarUrl?: string;
  discoverability: Discoverability;
  occurredAt?: string;
}>;

export type UpsertSolanaDestinationInput = Readonly<{
  destinationId: string;
  accountId: string;
  expectedVersion?: bigint;
  address: string;
  primary: boolean;
  occurredAt?: string;
}>;
