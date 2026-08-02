import { createHash } from "node:crypto";

const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type CanonicalPaymentRequest = Readonly<{
  actorSubject: string;
  network: "solana-devnet";
  mintAddress: string;
  recipientAddress: string;
  amountRaw: bigint;
  purpose: string;
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
