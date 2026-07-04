import {
  executeSolanaSplPay,
  type SolanaSplPayResult,
} from "../adapters/solana/solanaSplPayExecutor";

export type PaymentResult = SolanaSplPayResult;

export async function executePayment(
  recipient: string,
  amount: string
): Promise<PaymentResult> {
  try {
    return await executeSolanaSplPay({
      recipient,
      amount,
    });
  } catch (error) {
    console.error("executePayment failed:", error);
    throw error;
  }
}