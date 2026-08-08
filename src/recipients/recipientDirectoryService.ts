import type { AccountRepository } from "../identity/identityStorageContracts";
import type { EconomicIdentityPersistence } from "../economicIdentity/economicIdentityStorageContracts";
import type { EconomicIdentity, PaymentDestination, PublicRecipient } from "../economicIdentity/economicIdentityTypes";
import { normalizeUsername, validateUsername } from "../economicIdentity/economicIdentityValidation";

export class RecipientDirectoryError extends Error {
  constructor(public readonly kind: "NOT_FOUND" | "INVALID", message: string) {
    super(message); this.name = "RecipientDirectoryError";
  }
}

export type ResolvedPaymentDestination = Readonly<{
  recipient: PublicRecipient;
  destination: PaymentDestination;
}>;

export class RecipientDirectoryService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly identities: EconomicIdentityPersistence,
  ) {}

  async searchExactUsername(requesterAccountId: string, rawUsername: unknown): Promise<PublicRecipient[]> {
    const { normalizedUsername } = validateUsername(rawUsername);
    const identity = await this.identities.findEconomicIdentityByUsername(normalizedUsername);
    if (!identity || identity.accountId === requesterAccountId || !await this.isPubliclyResolvable(identity)) return [];
    return [toPublicRecipient(identity)];
  }

  async resolvePublicRecipient(requesterAccountId: string, accountId: string): Promise<PublicRecipient> {
    if (!UUID.test(accountId) || accountId.toLowerCase() === requesterAccountId.toLowerCase()) throw notFound();
    const identity = await this.identities.findEconomicIdentity(accountId.toLowerCase());
    if (!identity || !await this.isPubliclyResolvable(identity)) throw notFound();
    return toPublicRecipient(identity);
  }

  async resolveOwnPayableRecipient(accountId: string): Promise<PublicRecipient> {
    const identity = await this.identities.findEconomicIdentity(accountId.toLowerCase());
    if (!identity || !await this.isPubliclyResolvable(identity)) throw notFound();
    return toPublicRecipient(identity);
  }

  async resolvePaymentDestination(requesterAccountId: string, accountId: string): Promise<ResolvedPaymentDestination> {
    const recipient = await this.resolvePublicRecipient(requesterAccountId, accountId);
    const destinations = await this.identities.listPaymentDestinations(recipient.accountId);
    const destination = destinations.find((candidate) => candidate.destinationType === "SOLANA_WALLET" &&
      candidate.primary && candidate.status === "ACTIVE" && candidate.ownershipState !== "REJECTED");
    if (!destination) throw notFound();
    return { recipient, destination };
  }

  private async isPubliclyResolvable(identity: EconomicIdentity): Promise<boolean> {
    if (identity.publicIdentityStatus !== "ACTIVE" || identity.discoverability === "PRIVATE" ||
        identity.payabilityState !== "AVAILABLE" || identity.verificationState === "RESTRICTED") return false;
    const account = await this.accounts.findAccount(identity.accountId);
    return account?.status === "ACTIVE";
  }
}

export function toPublicRecipient(identity: EconomicIdentity): PublicRecipient {
  return Object.freeze({
    accountId: identity.accountId, username: identity.username, displayName: identity.displayName,
    accountType: identity.accountType, verificationState: identity.verificationState,
    payabilityState: identity.payabilityState, ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
  });
}

export function serializePublicRecipient(recipient: PublicRecipient) {
  return {
    accountId: recipient.accountId, username: recipient.username, displayName: recipient.displayName,
    accountType: recipient.accountType.toLowerCase(), verificationState: recipient.verificationState.toLowerCase(),
    payabilityState: recipient.payabilityState.toLowerCase(), ...(recipient.avatarUrl ? { avatarUrl: recipient.avatarUrl } : {}),
  };
}

export function parseExactSearchRequest(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("username" in value)) {
    throw new RecipientDirectoryError("INVALID", "A username-only search request is required.");
  }
  const username = (value as { username?: unknown }).username;
  if (typeof username !== "string") throw new RecipientDirectoryError("INVALID", "A valid username is required.");
  return normalizeUsername(username);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function notFound() { return new RecipientDirectoryError("NOT_FOUND", "Recipient was not found."); }
