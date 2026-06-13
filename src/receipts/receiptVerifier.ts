import type { ZephyonReceiptPreview } from "./receiptTypes";

type VerificationResult = {
  valid: boolean;
  errors: string[];
};

export function verifyX402ReceiptPreview(
  receipt: ZephyonReceiptPreview
): VerificationResult {
  const errors: string[] = [];

  if (receipt.system !== "zephyon") {
    errors.push("Receipt system must be zephyon.");
  }

  if (receipt.source !== "x402") {
    errors.push("Receipt source must be x402.");
  }

  if (!receipt.localReceiptId) {
    errors.push("Missing localReceiptId.");
  }

  if (!receipt.createdAt) {
    errors.push("Missing createdAt timestamp.");
  }

  if (!receipt.payment?.asset) {
    errors.push("Missing payment asset.");
  }

  if (!receipt.payment?.amount) {
    errors.push("Missing payment amount.");
  }

  if (!receipt.payment?.payTo) {
    errors.push("Missing payment receiver.");
  }

  if (!receipt.resource?.path) {
    errors.push("Missing resource path.");
  }

  if (!receipt.settlementProof) {
    errors.push("Missing settlement proof.");
  } else {
    if (receipt.settlementProof.success !== true) {
      errors.push("Settlement proof must indicate success.");
    }

    if (!receipt.settlementProof.transaction) {
      errors.push("Missing settlement transaction.");
    }

    if (!receipt.settlementProof.network) {
      errors.push("Missing settlement network.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}