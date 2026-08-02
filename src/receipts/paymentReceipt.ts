export type PaymentReceipt = Readonly<{
  id: string;
  paymentId: string;
  network: "solana-devnet";
  programId: string;
  receiptPda: string;
  solanaSignature: string;
  slot: bigint;
  mintAddress: string;
  recipientAddress: string;
  amountRaw: bigint;
  onchainReference: string;
  rawReceipt: JsonObject;
  verifiedAt: string;
  createdAt: string;
}>;

export type CreatePaymentReceiptInput = Omit<PaymentReceipt, "createdAt"> & {
  createdAt?: string;
};
import type { JsonObject } from "../payments/paymentTypes";
