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

function createSha256Hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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

  return createSha256Hash(raw);
}

export function createX402ReceiptPreview(input: X402ReceiptInput) {
  const createdAt = new Date().toISOString();
  const localReceiptId = createDeterministicReceiptId(input, createdAt);

  const resourceHash = createSha256Hash(input.resource);

  const receiptHash = createSha256Hash(
    [
      localReceiptId,
      input.resource,
      input.network,
      input.asset,
      input.amount,
      input.payTo,
      createdAt,
    ].join(":")
  );

  return {
    source: "x402",
    system: "zephyon",
    receiptMode: "offchain-preview",
    status: "settlement-proven-by-payment-response-header",
    localReceiptId,
    createdAt,

    paymentProtocol: {
      name: "x402",
      version: "preview",
      status: "active",
    },

    ownership: {
      owner: input.owner || "pending-settlement-proof",
      ownerSource: input.owner ? "x402-settlement-proof" : "pending",
    },

    entitlements: {
      resource: input.resource,
      accessGranted: true,
      usesRemaining: null,
      expiresAt: null,
      transferable: false,
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
      receiptHash,
      resourceHash,
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