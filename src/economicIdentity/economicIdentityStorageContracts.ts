import type {
  DestinationOwnershipState,
  DestinationStatus,
  EconomicIdentity,
  IdentityVerificationState,
  PayabilityState,
  PaymentDestination,
  PublicIdentityStatus,
  UpsertEconomicIdentityInput,
  UpsertSolanaDestinationInput,
} from "./economicIdentityTypes";

export interface EconomicIdentityPersistence {
  findEconomicIdentity(accountId: string): Promise<EconomicIdentity | undefined>;
  findEconomicIdentityByUsername(normalizedUsername: string): Promise<EconomicIdentity | undefined>;
  upsertEconomicIdentity(input: UpsertEconomicIdentityInput): Promise<Readonly<{ identity: EconomicIdentity; created: boolean }>>;
  updateEconomicIdentityState(input: Readonly<{
    accountId: string; expectedVersion: bigint; publicIdentityStatus: PublicIdentityStatus;
    verificationState: IdentityVerificationState; payabilityState: PayabilityState; occurredAt?: string;
  }>): Promise<EconomicIdentity>;
  findPaymentDestination(destinationId: string): Promise<PaymentDestination | undefined>;
  listPaymentDestinations(accountId: string): Promise<PaymentDestination[]>;
  upsertSolanaDestination(input: UpsertSolanaDestinationInput): Promise<Readonly<{ destination: PaymentDestination; created: boolean }>>;
  updatePaymentDestinationState(input: Readonly<{
    destinationId: string; accountId: string; expectedVersion: bigint;
    status: DestinationStatus; ownershipState: DestinationOwnershipState; occurredAt?: string;
  }>): Promise<PaymentDestination>;
}

export class EconomicIdentityVersionConflictError extends Error {
  constructor(accountId: string) { super(`Economic identity for ${accountId} was modified by another operation.`); this.name = "EconomicIdentityVersionConflictError"; }
}

export class UsernameConflictError extends Error {
  constructor() { super("Username is unavailable."); this.name = "UsernameConflictError"; }
}

export class PaymentDestinationConflictError extends Error {
  constructor(message = "Payment destination conflicts with an existing destination.") { super(message); this.name = "PaymentDestinationConflictError"; }
}
