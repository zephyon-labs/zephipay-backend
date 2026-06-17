import { Router } from "express";

export const protocolRouter = Router();

protocolRouter.get("/status", (_req, res) => {
  res.json({
    ok: true,
    protocol: "zephyon",
    app: "zephipay-backend",
    status: "online",
    environment: process.env.NODE_ENV || "development",
    network: "solana-devnet",
    modules: {
      x402: "active",
      receipts: "active",
      verification: "active",
      agentRoutes: "active",
    },
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});