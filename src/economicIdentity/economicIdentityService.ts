import { randomUUID } from "node:crypto";

import type { ExternalPrincipal } from "../auth/externalPrincipal";
import { AccountAccessDeniedError, AccountProvisioningService } from "../identity/accountProvisioningService";
import type { EconomicIdentityPersistence } from "./economicIdentityStorageContracts";
import {
  EconomicIdentityVersionConflictError,
  PaymentDestinationConflictError,
  UsernameConflictError,
} from "./economicIdentityStorageContracts";
import type { EconomicIdentity, PaymentDestination } from "./economicIdentityTypes";
import {
  EconomicIdentityInputError,
  parseVersion,
  requireExactObject,
  validateAccountType,
  validateAvatarUrl,
  validateDiscoverability,
  validateDisplayName,
  validateSolanaAddress,
  validateUsername,
} from "./economicIdentityValidation";

export class EconomicIdentityApplicationError extends Error {
  constructor(public readonly kind: "ACCESS_DENIED" | "NOT_FOUND" | "CONFLICT", message: string) {
    super(message); this.name = "EconomicIdentityApplicationError";
  }
}

export class EconomicIdentityService {
  constructor(
    private readonly accounts: AccountProvisioningService,
    private readonly persistence: EconomicIdentityPersistence,
  ) {}

  async getCurrent(principal: ExternalPrincipal): Promise<Readonly<{ identity?: EconomicIdentity; destinations: PaymentDestination[] }>> {
    const accountId = await this.resolveAccountId(principal);
    return {
      identity: await this.persistence.findEconomicIdentity(accountId),
      destinations: await this.persistence.listPaymentDestinations(accountId),
    };
  }

  async upsertCurrent(principal: ExternalPrincipal, raw: unknown): Promise<Readonly<{ identity: EconomicIdentity; created: boolean }>> {
    const accountId = await this.resolveAccountId(principal);
    const body = requireExactObject(raw, ["expectedVersion", "accountType", "username", "displayName", "avatarUrl", "discoverability"]);
    const username = validateUsername(body.username);
    try {
      return await this.persistence.upsertEconomicIdentity({
        accountId, expectedVersion: parseVersion(body.expectedVersion, false),
        accountType: validateAccountType(body.accountType), ...username,
        displayName: validateDisplayName(body.displayName), avatarUrl: validateAvatarUrl(body.avatarUrl),
        discoverability: validateDiscoverability(body.discoverability),
      });
    } catch (error) {
      if (error instanceof UsernameConflictError) throw new EconomicIdentityApplicationError("CONFLICT", "Username is unavailable.");
      if (error instanceof EconomicIdentityVersionConflictError) throw new EconomicIdentityApplicationError("CONFLICT", "Economic identity version is stale.");
      throw error;
    }
  }

  async upsertSolanaDestination(principal: ExternalPrincipal, raw: unknown): Promise<Readonly<{ destination: PaymentDestination; created: boolean }>> {
    const accountId = await this.resolveAccountId(principal);
    const body = requireExactObject(raw, ["destinationId", "expectedVersion", "address", "primary"]);
    if (body.destinationId !== undefined && (typeof body.destinationId !== "string" || !UUID.test(body.destinationId))) {
      throw new EconomicIdentityInputError("Payment destination ID is invalid.");
    }
    if (typeof body.primary !== "boolean") throw new EconomicIdentityInputError("Primary must be a boolean.");
    try {
      return await this.persistence.upsertSolanaDestination({
        destinationId: typeof body.destinationId === "string" ? body.destinationId.toLowerCase() : randomUUID(),
        accountId, expectedVersion: parseVersion(body.expectedVersion, false),
        address: validateSolanaAddress(body.address), primary: body.primary,
      });
    } catch (error) {
      if (error instanceof PaymentDestinationConflictError) throw new EconomicIdentityApplicationError("CONFLICT", error.message);
      throw error;
    }
  }

  private async resolveAccountId(principal: ExternalPrincipal): Promise<string> {
    try { return (await this.accounts.resolve(principal)).account.accountId; }
    catch (error) {
      if (error instanceof AccountAccessDeniedError) throw new EconomicIdentityApplicationError("ACCESS_DENIED", "Account access is unavailable.");
      throw error;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serializeCurrentIdentity(result: Awaited<ReturnType<EconomicIdentityService["getCurrent"]>>) {
  return {
    identity: result.identity ? serializeIdentity(result.identity) : null,
    destinations: result.destinations.map((destination) => ({
      id: destination.destinationId, type: destination.destinationType.toLowerCase(),
      address: destination.address, status: destination.status.toLowerCase(),
      ownershipState: destination.ownershipState.toLowerCase(), primary: destination.primary,
      version: destination.version.toString(), createdAt: destination.createdAt, updatedAt: destination.updatedAt,
    })),
  };
}

export function serializeIdentity(identity: EconomicIdentity) {
  return {
    accountId: identity.accountId, accountType: identity.accountType.toLowerCase(),
    username: identity.username, displayName: identity.displayName,
    ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
    publicIdentityStatus: identity.publicIdentityStatus.toLowerCase(),
    discoverability: identity.discoverability.toLowerCase(),
    verificationState: identity.verificationState.toLowerCase(),
    payabilityState: identity.payabilityState.toLowerCase(),
    version: identity.version.toString(), createdAt: identity.createdAt, updatedAt: identity.updatedAt,
  };
}
