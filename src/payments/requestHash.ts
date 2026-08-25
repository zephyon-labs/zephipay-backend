import { createHash } from "node:crypto";
import type { PaymentIdentitySnapshot } from "./paymentTypes";

const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type CanonicalPaymentRequest = Readonly<{
  actorSubject: string;
  network: "solana-devnet";
  mintAddress: string;
  recipientAddress: string;
  amountRaw: bigint;
  purpose: string | null;
}>;

export function validateRequestHash(requestHash: string): void {
  if (!REQUEST_HASH_PATTERN.test(requestHash)) {
    throw new Error("Request hash must be a lowercase 32-byte SHA-256 hex value.");
  }
}

export function createPaymentRequestHash(input: CanonicalPaymentRequest): string {
  if (input.amountRaw <= 0n) {
    throw new Error("Payment amountRaw must be positive.");
  }

  const canonical = JSON.stringify({
    actorSubject: input.actorSubject,
    network: input.network,
    mintAddress: input.mintAddress,
    recipientAddress: input.recipientAddress,
    amountRaw: input.amountRaw.toString(),
    purpose: input.purpose,
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createPaymentIdentityRequestHash(input: CanonicalPaymentRequest & Readonly<{
  recipientAccountId: string;
  recipientSnapshot: PaymentIdentitySnapshot;
  trustConfirmationOutcome: "NOT_REQUIRED" | "ACKNOWLEDGED";
}>): string {
  if (input.amountRaw <= 0n) throw new Error("Payment amountRaw must be positive.");
  const canonical = JSON.stringify({
    actorSubject: input.actorSubject, recipientType: "PAYMENT_IDENTITY",
    recipientAccountId: input.recipientAccountId, network: input.network,
    mintAddress: input.mintAddress, recipientAddress: input.recipientAddress,
    recipientSnapshot: canonicalPaymentIdentitySnapshot(input.recipientSnapshot),
    trustConfirmationOutcome: input.trustConfirmationOutcome,
    amountRaw: input.amountRaw.toString(), purpose: input.purpose,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalPaymentIdentitySnapshot(snapshot: PaymentIdentitySnapshot): PaymentIdentitySnapshot {
  return {
    accountId: snapshot.accountId,
    username: snapshot.username,
    displayName: snapshot.displayName,
    accountType: snapshot.accountType,
    verificationState: snapshot.verificationState,
    payabilityState: snapshot.payabilityState,
    capturedAt: snapshot.capturedAt,
    schemaVersion: snapshot.schemaVersion,
    ...(snapshot.identitySource ? { identitySource: snapshot.identitySource } : {}),
    resolutionSource: snapshot.resolutionSource,
    trustOutcome: snapshot.trustOutcome,
  };
}
