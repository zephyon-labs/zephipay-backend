import { Router } from "express";
import { listReceipts } from "../receipts/receiptRegistry";

export const receiptsRouter = Router();

receiptsRouter.get("/", (_req, res) => {
  const receipts = listReceipts();

  res.json({
    ok: true,
    count: receipts.length,
    receipts,
  });
});