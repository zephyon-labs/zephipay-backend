import { createPaymentIdentityRequestHash } from "./requestHash";
import type { PaymentRecord } from "./paymentTypes";

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

  const reconstructedHash = createPaymentIdentityRequestHash({
    actorSubject: input.actorSubject,
    network: input.network,
    mintAddress: input.mintAddress,
    recipientAddress: payment.recipientAddress,
    amountRaw: input.amountRaw,
    purpose: input.purpose,
    recipientAccountId: input.recipientId,
    recipientSnapshot: snapshot,
    trustConfirmationOutcome: trustOutcome,
  });
  return payment.requestHash === reconstructedHash;
}
