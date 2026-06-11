import { Router } from "express";

export const agentRouter = Router();

agentRouter.get("/costly-data", (_req, res) => {
  res.json({
    ok: true,
    resource: "Zephyon agentic payment test resource",
    payment: "x402-settled",
    receiptMode: "stubbed",
    network: "solana-devnet",
    message:
      "This protected resource was accessed through an experimental x402 payment flow.",
  });
});