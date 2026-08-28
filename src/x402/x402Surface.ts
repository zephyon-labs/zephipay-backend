import type { Express, RequestHandler } from "express";

import { createReceiptRegistry, type ReceiptRegistry } from "../receipts/receiptRegistry";
import { createAgentRouter } from "../routes/agent";
import { catalogRouter } from "../routes/catalog";
import { createEntitlementsRouter } from "../routes/entitlements";
import { protocolRouter } from "../routes/protocol";
import { createReceiptsRouter } from "../routes/receipts";
import { createVerifyRouter } from "../routes/verify";
import { sensitiveRateLimiter } from "../middleware/rateLimiter";
import { createX402Middleware } from "./x402Server";

export type X402SurfaceConfiguration = Readonly<{
  enabled: boolean;
  svmAddress?: string;
}>;

export type X402SurfaceDependencies = Readonly<{
  createMiddleware?: (svmAddress: string) => RequestHandler;
  createRegistry?: () => ReceiptRegistry;
}>;

export function mountX402Surface(
  app: Express,
  configuration: X402SurfaceConfiguration,
  dependencies: X402SurfaceDependencies = {},
): boolean {
  if (!configuration.enabled) {
    return false;
  }

  const svmAddress = configuration.svmAddress?.trim();
  if (!svmAddress) {
    throw new Error("SVM_ADDRESS is required when X402_ENABLED=true.");
  }

  const receiptRegistry = (dependencies.createRegistry ?? createReceiptRegistry)();
  const middleware = (dependencies.createMiddleware ?? createX402Middleware)(svmAddress);

  app.use("/api/protocol", protocolRouter);
  app.use("/api/verify", sensitiveRateLimiter, createVerifyRouter(receiptRegistry));
  app.use("/api/receipts", sensitiveRateLimiter, createReceiptsRouter(receiptRegistry));
  app.use("/api/entitlements", sensitiveRateLimiter, createEntitlementsRouter(receiptRegistry));
  app.use("/api/catalog", catalogRouter);
  app.use(middleware);
  app.use("/api/agent", createAgentRouter({ receiptRegistry, svmAddress }));

  return true;
}
