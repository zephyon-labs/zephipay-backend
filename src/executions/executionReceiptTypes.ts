import type { JsonObject, PaymentIdentitySnapshot } from "../payments/paymentTypes";

export type ExecutionReceipt = Readonly<{
  receiptId: string;
  paymentIntentId: string;
  executionId: string;
  actorSubject: string;
  runtimeTransactionId: string;
  rail: "mock";
  asset: "USDC";
  amountUnits: string;
  amountDecimals?: number;
  senderId: string;
  recipientId: string;
  recipientSnapshot?: PaymentIdentitySnapshot;
  memo: string;
  providerReference?: string;
  settledAt: string;
  evidenceType: string;
  evidenceVersion: number;
  evidence: JsonObject;
  schemaVersion: 1;
  requestHash: string;
  createdAt: string;
}>;

export type PublicExecutionReceipt = Readonly<{
  receiptId: string;
  paymentIntentId: string;
  executionId: string;
  status: "settled";
  amountRaw: string;
  amount: string;
  asset: "USDC";
  sender: Readonly<{ displayName: "You" }>;
  recipient: Readonly<{ type: "payment_identity"; displayName: string; username: string; verificationState: string; trustOutcome: string } | { type: "direct_wallet"; displayName: "Wallet recipient" }>;
  memo: string;
  rail: Readonly<{ id: "mock"; label: "Mock Rail" }>;
  settledAt: string;
  providerReference?: string;
  verification: Readonly<{ receiptSchemaVersion: 1; evidenceType: string; evidenceVersion: number; requestHash: string }>;
}>;

export function toPublicReceipt(receipt: ExecutionReceipt): PublicExecutionReceipt {
  const amount = formatAmount(receipt.amountUnits, receipt.amountDecimals ?? 6);
  const recipient = receipt.recipientSnapshot
    ? Object.freeze({ type: "payment_identity" as const, displayName: receipt.recipientSnapshot.displayName, username: receipt.recipientSnapshot.username,
        verificationState: receipt.recipientSnapshot.verificationState.toLowerCase(), trustOutcome: receipt.recipientSnapshot.trustOutcome.toLowerCase() })
    : Object.freeze({ type: "direct_wallet" as const, displayName: "Wallet recipient" as const });
  return Object.freeze({ receiptId: receipt.receiptId, paymentIntentId: receipt.paymentIntentId, executionId: receipt.executionId,
    status: "settled", amountRaw: receipt.amountUnits, amount, asset: receipt.asset, sender: Object.freeze({ displayName: "You" as const }),
    recipient, memo: receipt.memo, rail: Object.freeze({ id: "mock" as const, label: "Mock Rail" as const }), settledAt: receipt.settledAt,
    ...(receipt.providerReference ? { providerReference: receipt.providerReference } : {}),
    verification: Object.freeze({ receiptSchemaVersion: 1 as const, evidenceType: receipt.evidenceType,
      evidenceVersion: receipt.evidenceVersion, requestHash: receipt.requestHash }) });
}

function formatAmount(units: string, decimals: number): string {
  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
