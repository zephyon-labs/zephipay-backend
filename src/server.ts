import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { executePayment } from "./services/payservice";
import { protocolRouter } from "./routes/protocol";
import { x402Middleware } from "./x402/x402Server";
import { agentRouter } from "./routes/agent";
import { verifyRouter } from "./routes/verify";
import { receiptsRouter } from "./routes/receipts";
import { entitlementsRouter } from "./routes/entitlements";
import {
  generalRateLimiter,
  sensitiveRateLimiter,
} from "./middleware/rateLimiter";
dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(generalRateLimiter);
app.use("/api/protocol", protocolRouter);
app.use("/api/verify", sensitiveRateLimiter, verifyRouter);
app.use("/api/receipts", sensitiveRateLimiter, receiptsRouter);
app.use("/api/entitlements", sensitiveRateLimiter, entitlementsRouter);
app.use(x402Middleware);
app.use("/api/agent", agentRouter);
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "ZephyPay backend online",
    network: "solana-devnet",
  });
});

app.post("/api/send", async (req, res) => {
  try {
    const { recipient, amount, purpose } = req.body;

    console.log("Incoming payment request:");
    console.log({
      recipient,
      amount,
      purpose,
    });

    if (!recipient || !amount) {
      return res.status(400).json({
        ok: false,
        error: "Recipient and amount are required.",
      });
    }

    const payment = await executePayment(recipient, amount.toString());

    return res.json({
      ok: true,
      status: "confirmed",
      receiptId: payment.receiptId,
      signature: payment.signature,
      recipient: payment.recipient,
      amount: payment.amountRaw,
      purpose: purpose || "General",
      treasury: payment.treasury,
      mint: payment.mint,
      payCountBefore: payment.payCountBefore,
      payCountAfter: payment.payCountAfter,
      network: "solana-devnet",
    });
  } catch (error) {
    console.error("API payment failure:", error);

    return res.status(500).json({
      ok: false,
      error: "Payment execution failed",
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`ZephyPay backend running on port ${PORT}`);
});