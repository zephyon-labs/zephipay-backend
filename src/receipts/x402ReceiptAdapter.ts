import crypto from "node:crypto";

type X402ReceiptInput = {
  resource: string;
  description: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  owner?: string;
};

function createDeterministicReceiptId(input: X402ReceiptInput, createdAt: string) {
  const raw = [
    "zephyon",
    "x402",
    input.resource,
    input.network,
    input.asset,
    input.amount,
    input.payTo,
    createdAt,
  ].join(":");

  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function createX402ReceiptPreview(input: X402ReceiptInput) {
  const createdAt = new Date().toISOString();
  const localReceiptId = createDeterministicReceiptId(input, createdAt);

  return {
    source: "x402",
    system: "zephyon",
    receiptMode: "offchain-preview",
    status: "settlement-proven-by-payment-response-header",
    localReceiptId,
    createdAt,

        ownership: {
      owner: input.owner || "pending-settlement-proof",
      ownerSource: input.owner ? "x402-settlement-proof" : "pending",
    },

    payment: {
      source: "x402",
      settlementProvider: "payai",
      settlementProofLocation: "PAYMENT-RESPONSE header",
      network: input.network,
      asset: input.asset,
      amount: input.amount,
      payTo: input.payTo,
    },

    resource: {
      path: input.resource,
      description: input.description,
      access: "granted-after-settlement",
    },

    futureProtocolBinding: {
      pdaBacked: false,
      target: "Zephyon receipt PDA",
      note:
        "Future versions should bind x402 settlement metadata to a Zephyon receipt PDA without triggering a second payment.",
    },

    audit: {
      schemaVersion: "x402-preview-v1",
      generatedBy: "zephipay-backend",
      environment: "local-devnet-hybrid",
    },
  };
}