import type {
  EconomicIdentity,
  PaymentDestination,
  UpsertEconomicIdentityInput,
  UpsertSolanaDestinationInput,
} from "../../economicIdentity/economicIdentityTypes";
import type { EconomicIdentityPersistence } from "../../economicIdentity/economicIdentityStorageContracts";
import {
  EconomicIdentityVersionConflictError,
  PaymentDestinationConflictError,
  UsernameConflictError,
} from "../../economicIdentity/economicIdentityStorageContracts";
import { validateDestinationPersistenceInput, validateEconomicIdentityPersistenceInput } from "../../economicIdentity/economicIdentityValidation";

export class InMemoryEconomicIdentityPersistence implements EconomicIdentityPersistence {
  private readonly identities = new Map<string, EconomicIdentity>();
  private readonly destinations = new Map<string, PaymentDestination>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: Readonly<{
    clock?: () => string;
    accountExists?: (accountId: string) => Promise<boolean>;
  }> = {}) {}

  async findEconomicIdentity(accountId: string): Promise<EconomicIdentity | undefined> {
    return this.identities.get(accountId);
  }

  async findEconomicIdentityByUsername(normalizedUsername: string): Promise<EconomicIdentity | undefined> {
    return [...this.identities.values()].find((identity) => identity.normalizedUsername === normalizedUsername);
  }

  upsertEconomicIdentity(input: UpsertEconomicIdentityInput): Promise<Readonly<{ identity: EconomicIdentity; created: boolean }>> {
    return this.serialize(async () => {
      validateEconomicIdentityPersistenceInput(input);
      await this.requireAccount(input.accountId);
      const current = this.identities.get(input.accountId);
      const collision = [...this.identities.values()].find((identity) =>
        identity.normalizedUsername === input.normalizedUsername && identity.accountId !== input.accountId);
      if (collision) throw new UsernameConflictError();
      const now = input.occurredAt ?? this.now();
      if (!current) {
        if (input.expectedVersion !== undefined) throw new EconomicIdentityVersionConflictError(input.accountId);
        const identity = Object.freeze({
          accountId: input.accountId, accountType: input.accountType,
          username: input.username, normalizedUsername: input.normalizedUsername,
          displayName: input.displayName, avatarUrl: input.avatarUrl,
          publicIdentityStatus: "ACTIVE" as const, discoverability: input.discoverability,
          verificationState: "UNVERIFIED" as const, payabilityState: "UNAVAILABLE" as const,
          version: 0n, createdAt: now, updatedAt: now,
        });
        this.identities.set(input.accountId, identity);
        return { identity, created: true };
      }
      if (input.expectedVersion === undefined || input.expectedVersion !== current.version) {
        throw new EconomicIdentityVersionConflictError(input.accountId);
      }
      const identity = Object.freeze({
        ...current, username: input.username,
        normalizedUsername: input.normalizedUsername, displayName: input.displayName,
        avatarUrl: input.avatarUrl, discoverability: input.discoverability,
        version: current.version + 1n, updatedAt: now,
      });
      this.identities.set(input.accountId, identity);
      return { identity, created: false };
    });
  }

  updateEconomicIdentityState(input: Parameters<EconomicIdentityPersistence["updateEconomicIdentityState"]>[0]): Promise<EconomicIdentity> {
    return this.serialize(async () => {
      const current = this.identities.get(input.accountId);
      if (!current || current.version !== input.expectedVersion) throw new EconomicIdentityVersionConflictError(input.accountId);
      const identity = Object.freeze({ ...current, publicIdentityStatus: input.publicIdentityStatus,
        verificationState: input.verificationState, payabilityState: input.payabilityState,
        version: current.version + 1n, updatedAt: input.occurredAt ?? this.now() });
      this.identities.set(input.accountId, identity);
      return identity;
    });
  }

  async findPaymentDestination(destinationId: string): Promise<PaymentDestination | undefined> {
    return this.destinations.get(destinationId);
  }

  async listPaymentDestinations(accountId: string): Promise<PaymentDestination[]> {
    return [...this.destinations.values()].filter((destination) => destination.accountId === accountId)
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.createdAt.localeCompare(b.createdAt));
  }

  upsertSolanaDestination(input: UpsertSolanaDestinationInput): Promise<Readonly<{ destination: PaymentDestination; created: boolean }>> {
    return this.serialize(async () => {
      await this.requireAccount(input.accountId);
      validateDestinationPersistenceInput(input);
      const current = this.destinations.get(input.destinationId);
      const collision = [...this.destinations.values()].find((destination) =>
        destination.destinationType === "SOLANA_WALLET" && destination.address === input.address && destination.destinationId !== input.destinationId);
      if (collision) throw new PaymentDestinationConflictError();
      const now = input.occurredAt ?? this.now();
      if (!current) {
        if (input.expectedVersion !== undefined) throw new PaymentDestinationConflictError("Payment destination version is stale.");
        if (input.primary) this.demotePrimary(input.accountId, now);
        const destination = Object.freeze({
          destinationId: input.destinationId, accountId: input.accountId,
          destinationType: "SOLANA_WALLET" as const, address: input.address,
          status: "ACTIVE" as const, ownershipState: "UNVERIFIED" as const,
          primary: input.primary, version: 0n, createdAt: now, updatedAt: now,
        });
        this.destinations.set(input.destinationId, destination);
        return { destination, created: true };
      }
      if (current.accountId !== input.accountId || current.address !== input.address) {
        throw new PaymentDestinationConflictError("Payment destination cannot be reassigned or changed.");
      }
      if (input.expectedVersion === undefined || input.expectedVersion !== current.version) {
        throw new PaymentDestinationConflictError("Payment destination version is stale.");
      }
      if (input.primary) this.demotePrimary(input.accountId, now, input.destinationId);
      const destination = Object.freeze({ ...current, primary: input.primary, version: current.version + 1n, updatedAt: now });
      this.destinations.set(input.destinationId, destination);
      return { destination, created: false };
    });
  }

  updatePaymentDestinationState(input: Parameters<EconomicIdentityPersistence["updatePaymentDestinationState"]>[0]): Promise<PaymentDestination> {
    return this.serialize(async () => {
      const current = this.destinations.get(input.destinationId);
      if (!current || current.accountId !== input.accountId || current.version !== input.expectedVersion) {
        throw new PaymentDestinationConflictError("Payment destination version is stale or destination is unavailable.");
      }
      const destination = Object.freeze({ ...current, status: input.status, ownershipState: input.ownershipState,
        version: current.version + 1n, updatedAt: input.occurredAt ?? this.now() });
      this.destinations.set(input.destinationId, destination);
      return destination;
    });
  }

  private demotePrimary(accountId: string, updatedAt: string, except?: string): void {
    for (const [id, destination] of this.destinations) {
      if (id !== except && destination.accountId === accountId && destination.destinationType === "SOLANA_WALLET" && destination.primary) {
        this.destinations.set(id, Object.freeze({ ...destination, primary: false, version: destination.version + 1n, updatedAt }));
      }
    }
  }

  private async requireAccount(accountId: string): Promise<void> {
    if (this.options.accountExists && !await this.options.accountExists(accountId)) throw new Error(`Account ${accountId} was not found.`);
  }

  private now(): string { return this.options.clock?.() ?? new Date().toISOString(); }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
