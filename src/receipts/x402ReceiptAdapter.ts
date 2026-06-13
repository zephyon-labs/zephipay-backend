type X402ReceiptInput = {
  resource: string;
  description: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
};

export function createX402ReceiptPreview(input: X402ReceiptInput) {
  const createdAt = new Date().toISOString();

  return {
    source: "x402",
    receiptMode: "offchain-preview",
    status: "settlement-proven-by-payment-response-header",
    createdAt,
    resource: input.resource,
    description: input.description,
    network: input.network,
    asset: input.asset,
    amount: input.amount,
    payTo: input.payTo,
    note:
      "This is a Zephyon-style receipt preview for an x402-settled payment. Future versions should bind this settlement to a Zephyon receipt PDA without double-charging the payer.",
  };
}