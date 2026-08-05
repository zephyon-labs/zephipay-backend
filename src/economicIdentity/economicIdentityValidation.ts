import { PublicKey } from "@solana/web3.js";

import {
  DISCOVERABILITY_LEVELS,
  ECONOMIC_ACCOUNT_TYPES,
  type Discoverability,
  type EconomicAccountType,
} from "./economicIdentityTypes";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const DISPLAY_NAME_MAX_LENGTH = 80;
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,29}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED = new Set([
  "admin", "administrator", "api", "auth", "billing", "help", "official", "payments",
  "recipient", "recipients", "root", "security", "support", "system", "zephi", "zephipay", "zephyon",
]);

export class EconomicIdentityInputError extends Error {
  constructor(message: string) { super(message); this.name = "EconomicIdentityInputError"; }
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: unknown): Readonly<{ username: string; normalizedUsername: string }> {
  if (typeof value !== "string") throw new EconomicIdentityInputError("Username must be a string.");
  const username = value.trim();
  const normalizedUsername = normalizeUsername(username);
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH || !USERNAME_PATTERN.test(normalizedUsername)) {
    throw new EconomicIdentityInputError("Username must be 3 to 30 ASCII characters, begin with a letter, and contain only letters, numbers, or underscores.");
  }
  if (RESERVED.has(normalizedUsername)) throw new EconomicIdentityInputError("Username is reserved.");
  if (UUID_PATTERN.test(normalizedUsername) || normalizedUsername.startsWith("zp_account_") || normalizedUsername.startsWith("zp:account:")) {
    throw new EconomicIdentityInputError("Username resembles an internal identifier.");
  }
  try {
    if (new PublicKey(username).toBase58() === username) throw new EconomicIdentityInputError("Username resembles a wallet address.");
  } catch (error) {
    if (error instanceof EconomicIdentityInputError) throw error;
  }
  return { username, normalizedUsername };
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new EconomicIdentityInputError("Display name must be a string.");
  const displayName = value.trim().replace(/\s+/g, " ");
  const length = Array.from(displayName).length;
  if (length < 1 || length > DISPLAY_NAME_MAX_LENGTH) {
    throw new EconomicIdentityInputError("Display name must be between 1 and 80 characters.");
  }
  if (/\p{Cc}/u.test(displayName)) throw new EconomicIdentityInputError("Display name contains unsupported control characters.");
  return displayName;
}

export function validateAvatarUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) {
    throw new EconomicIdentityInputError("Avatar URL is invalid.");
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new EconomicIdentityInputError("Avatar URL is invalid."); }
  if (parsed.protocol !== "https:") throw new EconomicIdentityInputError("Avatar URL must use HTTPS.");
  return parsed.toString();
}

export function validateAccountType(value: unknown): EconomicAccountType {
  if (!ECONOMIC_ACCOUNT_TYPES.includes(value as EconomicAccountType)) throw new EconomicIdentityInputError("Account type is invalid.");
  return value as EconomicAccountType;
}

export function validateDiscoverability(value: unknown): Discoverability {
  if (!DISCOVERABILITY_LEVELS.includes(value as Discoverability)) throw new EconomicIdentityInputError("Discoverability is invalid.");
  return value as Discoverability;
}

export function validateSolanaAddress(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) throw new EconomicIdentityInputError("Destination must be a canonical Solana wallet address.");
  try {
    if (new PublicKey(value).toBase58() !== value) throw new Error("noncanonical");
  } catch { throw new EconomicIdentityInputError("Destination must be a canonical Solana wallet address."); }
  return value;
}

export function parseVersion(value: unknown, required: boolean): bigint | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new EconomicIdentityInputError("Expected version must be a nonnegative decimal integer string.");
  return BigInt(value);
}

export function requireExactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EconomicIdentityInputError("Request body must be a JSON object.");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new EconomicIdentityInputError(`Unsupported request field: ${unknown}.`);
  return record;
}

export function validateEconomicIdentityPersistenceInput(input: Readonly<{
  accountId: string; accountType: unknown; username: unknown; normalizedUsername: string;
  displayName: unknown; avatarUrl?: unknown; discoverability: unknown;
}>): void {
  if (!UUID_PATTERN.test(input.accountId)) throw new EconomicIdentityInputError("Account ID must be a canonical UUID.");
  const username = validateUsername(input.username);
  if (username.username !== input.username || username.normalizedUsername !== input.normalizedUsername) {
    throw new EconomicIdentityInputError("Username fields must be canonical and consistent.");
  }
  if (validateDisplayName(input.displayName) !== input.displayName) throw new EconomicIdentityInputError("Display name must be canonical.");
  validateAvatarUrl(input.avatarUrl);
  validateAccountType(input.accountType);
  validateDiscoverability(input.discoverability);
}

export function validateDestinationPersistenceInput(input: Readonly<{
  destinationId: string; accountId: string; address: unknown;
}>): void {
  if (!UUID_PATTERN.test(input.destinationId)) throw new EconomicIdentityInputError("Destination ID must be a canonical UUID.");
  if (!UUID_PATTERN.test(input.accountId)) throw new EconomicIdentityInputError("Account ID must be a canonical UUID.");
  validateSolanaAddress(input.address);
}
