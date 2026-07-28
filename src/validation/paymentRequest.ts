import { PublicKey } from "@solana/web3.js";

import { environment } from "../config/environment";

export type ValidatedPaymentRequest = {
  recipient: string;
  amount: string;
  purpose: string;
};

export type PaymentRequestValidationResult =
  | {
      valid: true;
      value: ValidatedPaymentRequest;
    }
  | {
      valid: false;
      error: string;
    };

const USDC_AMOUNT_PATTERN =
  /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

const ALLOWED_FIELDS = new Set([
  "recipient",
  "amount",
  "purpose",
]);

function normalizeAmount(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value.toString();
  }

  return undefined;
}

export function validatePaymentRequest(
  body: unknown,
): PaymentRequestValidationResult {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return {
      valid: false,
      error: "Request body must be a JSON object.",
    };
  }

  const record = body as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (field) => !ALLOWED_FIELDS.has(field),
  );

  if (unknownFields.length > 0) {
    return {
      valid: false,
      error: `Unsupported request field: ${unknownFields[0]}.`,
    };
  }

  if (typeof record.recipient !== "string") {
    return {
      valid: false,
      error: "Recipient must be a Solana wallet address.",
    };
  }

  const recipient = record.recipient.trim();

  try {
    const parsedRecipient = new PublicKey(recipient);

    if (parsedRecipient.toBase58() !== recipient) {
      return {
        valid: false,
        error: "Recipient must be a canonical Solana wallet address.",
      };
    }
  } catch {
    return {
      valid: false,
      error: "Recipient must be a valid Solana wallet address.",
    };
  }

  const amount = normalizeAmount(record.amount);

  if (!amount || !USDC_AMOUNT_PATTERN.test(amount)) {
    return {
      valid: false,
      error:
        "Amount must be a positive USDC value with no more than 6 decimal places.",
    };
  }

  const amountNumber = Number(amount);

  if (
    !Number.isFinite(amountNumber) ||
    amountNumber <= 0
  ) {
    return {
      valid: false,
      error: "Amount must be greater than zero.",
    };
  }

  if (amountNumber > environment.paymentMaxUsdc) {
    return {
      valid: false,
      error: `Amount exceeds the current ${environment.paymentMaxUsdc} USDC payment limit.`,
    };
  }

  if (typeof record.purpose !== "string") {
    return {
      valid: false,
      error: "Purpose must be a string.",
    };
  }

  const purpose = record.purpose.trim();
  const purposeBytes = Buffer.byteLength(
    purpose,
    "utf8",
  );

  if (purposeBytes === 0 || purposeBytes > 120) {
    return {
      valid: false,
      error:
        "Purpose must be between 1 and 120 UTF-8 bytes.",
    };
  }

  return {
    valid: true,
    value: {
      recipient,
      amount,
      purpose,
    },
  };
}
