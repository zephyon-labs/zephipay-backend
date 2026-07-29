import { createHash } from "node:crypto";

import cors from "cors";
import dotenv from "dotenv";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

dotenv.config();

import { environment } from "./config/environment";
import {
  generalRateLimiter,
  paymentRateLimiter,
  sensitiveRateLimiter,
} from "./middleware/rateLimiter";
import { requestContext } from "./middleware/requestContext";
import { agentRouter } from "./routes/agent";
import { catalogRouter } from "./routes/catalog";
import { entitlementsRouter } from "./routes/entitlements";
import { protocolRouter } from "./routes/protocol";
import { receiptsRouter } from "./routes/receipts";
import { verifyRouter } from "./routes/verify";
import { executePayment } from "./services/payservice";
import { validatePaymentRequest } from "./validation/paymentRequest";
import { x402Middleware } from "./x402/x402Server";

const app = express();

if (environment.trustProxy) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(requestContext);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (
        environment.corsAllowedOrigins.includes(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed."));
    },
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
    ],
    credentials: true,
    maxAge: 600,
  }),
);

app.use(
  express.json({
    limit: environment.jsonBodyLimit,
    strict: true,
    type: "application/json",
  }),
);

app.use(generalRateLimiter);

app.use("/api/protocol", protocolRouter);
app.use(
  "/api/verify",
  sensitiveRateLimiter,
  verifyRouter,
);
app.use(
  "/api/receipts",
  sensitiveRateLimiter,
  receiptsRouter,
);
app.use(
  "/api/entitlements",
  sensitiveRateLimiter,
  entitlementsRouter,
);
app.use("/api/catalog", catalogRouter);
app.use(x402Middleware);
app.use("/api/agent", agentRouter);

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "ZephiPay backend online",
    network: "solana-devnet",
    paymentsEnabled: environment.paymentsEnabled,
  });
});

app.post(
  "/api/send",
  paymentRateLimiter,
  async (req, res) => {
    const requestId = String(res.locals.requestId);

    if (!environment.paymentsEnabled) {
      return res.status(503).json({
        ok: false,
        error: "Payment execution is temporarily unavailable.",
        requestId,
      });
    }

    const validation = validatePaymentRequest(req.body);

    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
        requestId,
      });
    }

    const {
      recipient,
      amount,
      purpose,
    } = validation.value;

    const recipientFingerprint = createHash("sha256")
      .update(recipient)
      .digest("hex")
      .slice(0, 12);

    console.info("Payment request accepted for execution.", {
      requestId,
      recipientFingerprint,
      amount,
    });

    try {
      const payment = await executePayment({
        recipient,
        amount,
        purpose,
      });

      console.info("Payment execution completed.", {
        requestId,
        paymentId: payment.paymentId,
        transactionId: payment.transactionId,
        signature: payment.signature,
      });

      return res.json({
        ok: true,
        status: "confirmed",
        requestId,
        runtimeId: payment.runtimeId,
        paymentId: payment.paymentId,
        transactionId: payment.transactionId,
        receiptId: payment.receiptId,
        signature: payment.signature,
        recipient: payment.recipient,
        amount: payment.amountRaw,
        amountDisplay:
          Number(payment.amountRaw) / 1_000_000,
        asset: "USDC",
        purpose: payment.purpose,
        treasury: payment.treasury,
        mint: payment.mint,
        payCountBefore: payment.payCountBefore,
        payCountAfter: payment.payCountAfter,
        network: "solana-devnet",
      });
    } catch (error) {
      console.error("Payment execution failed.", {
        requestId,
        error:
          error instanceof Error
            ? error.message
            : "Unknown payment error",
      });

      return res.status(500).json({
        ok: false,
        error: "Payment execution failed.",
        requestId,
      });
    }
  },
);

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const requestId = String(
      res.locals.requestId || "unknown",
    );

    if (
      error instanceof SyntaxError &&
      "body" in error
    ) {
      return res.status(400).json({
        ok: false,
        error: "Request body contains invalid JSON.",
        requestId,
      });
    }

    if (
      error instanceof Error &&
      error.message === "Origin is not allowed."
    ) {
      return res.status(403).json({
        ok: false,
        error: "Request origin is not allowed.",
        requestId,
      });
    }

    console.error("Unhandled API error.", {
      requestId,
      error:
        error instanceof Error
          ? error.message
          : "Unknown server error",
    });

    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      requestId,
    });
  },
);

app.listen(environment.port, () => {
  console.log(
    `ZephiPay backend running on port ${environment.port}`,
  );
  console.log({
    environment: environment.nodeEnv,
    paymentsEnabled: environment.paymentsEnabled,
    trustProxy: environment.trustProxy,
    allowedOriginCount:
      environment.corsAllowedOrigins.length,
  });
});
