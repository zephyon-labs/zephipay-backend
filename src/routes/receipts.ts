import { Router } from "express";
import { getReceipt, listReceipts } from "../receipts/receiptRegistry";

export const receiptsRouter = Router();

receiptsRouter.get("/", (_req, res) => {
  const receipts = listReceipts();

  res.json({
    ok: true,
    count: receipts.length,
    receipts,
  });
});

receiptsRouter.get("/wallet/:wallet", (req, res) => {
  const wallet = req.params.wallet;

  const receipts = listReceipts().filter((receipt: any) => {
    const owner = receipt?.ownership?.owner;
    const payTo = receipt?.payment?.payTo;
    const payer = receipt?.settlementProof?.payer;

    return owner === wallet || payTo === wallet || payer === wallet;
  });

  res.json({
    ok: true,
    wallet,
    count: receipts.length,
    receipts,
  });
});

receiptsRouter.get("/:receiptId", (req, res) => {
  const receipt = getReceipt(req.params.receiptId);

  if (!receipt) {
    return res.status(404).json({
      ok: false,
      found: false,
      error: "Receipt not found",
    });
  }

  return res.json({
    ok: true,
    found: true,
    receipt,
  });
});