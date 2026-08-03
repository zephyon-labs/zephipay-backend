import { PublicKey } from "@solana/web3.js";

const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export type PaymentIntentRequest = Readonly<{
  recipient: string;
  amount: string;
  purpose: string;
}>;

export type ConfirmPaymentIntentRequest = Readonly<{
  requestHash: string;
  expectedVersion: bigint;
}>;

export class PaymentIntentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentIntentInputError";
  }
}

export function parsePaymentIntentRequest(body: unknown): PaymentIntentRequest {
  const record = requireObject(body);
  rejectUnknownFields(record, ["recipient", "amount", "purpose"]);
  if (typeof record.recipient !== "string") throw new PaymentIntentInputError("Recipient must be a Solana wallet address.");
  const recipient = record.recipient.trim();
  try {
    if (new PublicKey(recipient).toBase58() !== recipient) throw new Error("noncanonical");
  } catch {
    throw new PaymentIntentInputError("Recipient must be a canonical Solana wallet address.");
  }
  if (typeof record.amount !== "string" || !AMOUNT_PATTERN.test(record.amount)) {
    throw new PaymentIntentInputError("Amount must be a decimal USDC string with no more than 6 decimal places.");
  }
  const amountRaw = usdcAmountToRaw(record.amount);
  if (amountRaw <= 0n) throw new PaymentIntentInputError("Amount must be greater than zero.");
  if (amountRaw > POSTGRES_BIGINT_MAX) throw new PaymentIntentInputError("Amount exceeds the supported USDC range.");
  if (typeof record.purpose !== "string") throw new PaymentIntentInputError("Purpose must be a string.");
  const purpose = record.purpose.trim();
  const purposeBytes = Buffer.byteLength(purpose, "utf8");
  if (purposeBytes < 1 || purposeBytes > 120) {
    throw new PaymentIntentInputError("Purpose must be between 1 and 120 UTF-8 bytes.");
  }
  return { recipient, amount: record.amount, purpose };
}

export function parseConfirmPaymentIntentRequest(body: unknown): ConfirmPaymentIntentRequest {
  const record = requireObject(body);
  rejectUnknownFields(record, ["requestHash", "expectedVersion"]);
  if (typeof record.requestHash !== "string" || !HASH_PATTERN.test(record.requestHash)) {
    throw new PaymentIntentInputError("Request hash must be a lowercase 32-byte SHA-256 hex value.");
  }
  if (typeof record.expectedVersion !== "string" || !VERSION_PATTERN.test(record.expectedVersion)) {
    throw new PaymentIntentInputError("Expected version must be a nonnegative decimal integer string.");
  }
  return { requestHash: record.requestHash, expectedVersion: BigInt(record.expectedVersion) };
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new PaymentIntentInputError("Idempotency-Key must contain 16 to 128 visible ASCII characters.");
  }
  return value;
}

export function parsePaymentIntentId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new PaymentIntentInputError("Payment intent ID must be a canonical UUID.");
  return value.toLowerCase();
}

export function usdcAmountToRaw(value: string): bigint {
  if (!AMOUNT_PATTERN.test(value)) throw new PaymentIntentInputError("Amount must be an exact decimal USDC string.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
}

export function rawUsdcToDisplay(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PaymentIntentInputError("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).find((field) => !allowed.includes(field));
  if (unknown) throw new PaymentIntentInputError(`Unsupported request field: ${unknown}.`);
}
