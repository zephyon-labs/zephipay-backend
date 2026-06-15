import { Router } from "express";
import { createX402ReceiptPreview } from "../receipts/x402ReceiptAdapter";
import { registerReceipt } from "../receipts/receiptRegistry";
export const agentRouter = Router();

agentRouter.get("/costly-data", (_req, res) => {
  const zephyonReceipt = createX402ReceiptPreview({
    resource: "/api/agent/costly-data",
    description: "Zephyon agentic payment test resource",
    network: "solana-devnet",
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    amount: "1000",
    payTo: process.env.SVM_ADDRESS || "unknown",
  });

    registerReceipt(zephyonReceipt);

  res.json({
    ok: true,
    resource: "Zephyon agentic payment test resource",
    payment: "x402-settled",
    receiptMode: "x402-offchain-preview",
    network: "solana-devnet",
    zephyonReceipt,
        verificationUrl: `/api/verify/${zephyonReceipt.localReceiptId}`,
    message:
      "This protected resource was accessed through an experimental x402 payment flow and returned a Zephyon-style receipt preview.",
  });
});