import {
  createLegacyPreMigration009PaymentIdentityRequestHash,
  createPaymentIdentityRequestHash,
} from "./requestHash";
import type { PaymentIdentitySnapshot, PaymentRecord } from "./paymentTypes";

export type PaymentIdentityReplayRequest = Readonly<{
  actorSubject: string;
  idempotencyKey: string;
  recipientId: string;
  trustAcknowledged: boolean;
  network: "solana-devnet";
  rail: "solana";
  asset: "USDC";
  mintAddress: string;
  amountRaw: bigint;
  purpose: string | null;
}>;

/**
 * Compares caller-controlled replay semantics with an existing payment while
 * sourcing all historical recipient meaning from the frozen payment itself.
 */
export function matchesFrozenPaymentIdentityRequest(
  payment: PaymentRecord,
  input: PaymentIdentityReplayRequest,
): boolean {
  const frozenRecipientId = payment.recipientAccountId ?? payment.recipientSyntheticId;
  const snapshot = payment.recipientSnapshot;
  const trustOutcome = payment.trustConfirmationOutcome;

  if (
    payment.recipientType !== "PAYMENT_IDENTITY" ||
    frozenRecipientId !== input.recipientId ||
    !snapshot ||
    payment.recipientSnapshotVersion !== 1 ||
    !trustOutcome ||
    snapshot.accountId !== frozenRecipientId ||
    snapshot.trustOutcome !== trustOutcome ||
    payment.actorSubject !== input.actorSubject ||
    payment.idempotencyKey !== input.idempotencyKey ||
    payment.network !== input.network ||
    payment.rail !== input.rail ||
    payment.asset !== input.asset ||
    payment.mintAddress !== input.mintAddress ||
    payment.amountRaw !== input.amountRaw ||
    payment.purpose !== input.purpose
  ) return false;

  if (trustOutcome === "ACKNOWLEDGED" && !input.trustAcknowledged) return false;

  const hashInput = {
    actorSubject: input.actorSubject,
    network: input.network,
    mintAddress: input.mintAddress,
    recipientAddress: payment.recipientAddress,
    amountRaw: input.amountRaw,
    purpose: input.purpose,
    recipientAccountId: input.recipientId,
    recipientSnapshot: snapshot,
    trustConfirmationOutcome: trustOutcome,
  };
  if (payment.requestHash === createPaymentIdentityRequestHash(hashInput)) return true;

  if (!isKnownMigration009CanonicalBackfill(payment, snapshot)) return false;
  return payment.requestHash === createLegacyPreMigration009PaymentIdentityRequestHash(hashInput);
}

const MIGRATION_009_CANONICAL_SNAPSHOT_KEYS = [
  "accountId", "accountType", "capturedAt", "displayName", "identitySource", "payabilityState",
  "resolutionSource", "schemaVersion", "trustOutcome", "username", "verificationState",
] as const;
const CANONICAL_ACCOUNT_TYPES = new Set<unknown>(["PERSONAL", "CREATOR", "BUSINESS", "AI_AGENT"]);
const CANONICAL_VERIFICATION_STATES = new Set<unknown>(["UNVERIFIED", "PENDING", "VERIFIED"]);

function isKnownMigration009CanonicalBackfill(
  payment: PaymentRecord,
  snapshot: PaymentIdentitySnapshot,
): boolean {
  if (
    !payment.recipientAccountId ||
    payment.recipientSyntheticId !== undefined ||
    snapshot.identitySource !== "RECIPIENT_DIRECTORY" ||
    snapshot.resolutionSource !== "RECIPIENT_DIRECTORY" ||
    snapshot.schemaVersion !== 1 ||
    snapshot.payabilityState !== "AVAILABLE" ||
    typeof snapshot.username !== "string" || !snapshot.username ||
    typeof snapshot.displayName !== "string" || !snapshot.displayName ||
    typeof snapshot.capturedAt !== "string" || !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    !CANONICAL_ACCOUNT_TYPES.has(snapshot.accountType) ||
    !CANONICAL_VERIFICATION_STATES.has(snapshot.verificationState)
  ) return false;

  const keys = Object.keys(snapshot).sort();
  return keys.length === MIGRATION_009_CANONICAL_SNAPSHOT_KEYS.length &&
    keys.every((key, index) => key === MIGRATION_009_CANONICAL_SNAPSHOT_KEYS[index]);
}
