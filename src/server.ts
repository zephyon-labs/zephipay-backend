import express from "express";
import cors from "cors";
import dotenv from "dotenv";

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

    // TEMP MOCK RESPONSE
    // Later this becomes real pay_devnet execution

    return res.json({
      ok: true,
      status: "confirmed",
      receiptId: "DEVNET-PLACEHOLDER-123456",
      recipient,
      amount,
      purpose,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "Backend execution failed",
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`ZephiPay backend running on port ${PORT}`);
});