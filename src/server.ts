import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { executePayment } from "./services/payservice";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "ZephiPay backend online",
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

    const receiptId = await executePayment(recipient, amount.toString());

    return res.json({
      ok: true,
      status: "confirmed",
      receiptId,
      recipient,
      amount,
      purpose,
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
  console.log(`ZephiPay backend running on port ${PORT}`);
});