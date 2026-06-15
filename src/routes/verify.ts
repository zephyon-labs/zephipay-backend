import { Router } from "express";
import { getReceipt } from "../receipts/receiptRegistry";

export const verifyRouter = Router();

verifyRouter.get("/:receiptId", (req, res) => {
  const receipt = getReceipt(req.params.receiptId);

  if (!receipt) {
    return res.status(404).json({
      valid: false,
      error: "Receipt not found",
    });
  }

  return res.json({
    valid: true,
    receipt,
  });
});