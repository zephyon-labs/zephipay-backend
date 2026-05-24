import crypto from "crypto";

export async function executePayment(
  recipient: string,
  amount: string
): Promise<string> {
  console.log("Production validation payment request:");
  console.log({
    recipient,
    amount,
    mode: "railway-cloud-validation",
  });

  const receiptId = `DEMO-${crypto.randomUUID()}`;

  return receiptId;
}