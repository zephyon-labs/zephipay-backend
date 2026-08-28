import { Router } from "express";
import { createX402ReceiptPreview } from "../receipts/x402ReceiptAdapter";
import type { ReceiptRegistry } from "../receipts/receiptRegistry";
import { CIRCLE_SOLANA_DEVNET_USDC_MINT } from "../devnet/canonicalDevnetAsset";

export function createAgentRouter(input: Readonly<{
  receiptRegistry: ReceiptRegistry;
  svmAddress: string;
}>): Router {
  const agentRouter = Router();

  agentRouter.get("/costly-data", (_req, res) => {
    const zephyonReceipt = createX402ReceiptPreview({
      resource: "/api/agent/costly-data",
      description: "Zephyon agentic payment test resource",
      network: "solana-devnet",
      asset: CIRCLE_SOLANA_DEVNET_USDC_MINT,
      amount: "1000",
      payTo: input.svmAddress,
      owner: input.svmAddress,
    });

    input.receiptRegistry.registerReceipt(zephyonReceipt);

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

  return agentRouter;
}
