import { Router } from "express";
import type { ReceiptRegistry } from "../receipts/receiptRegistry";

export function createVerifyRouter(receiptRegistry: ReceiptRegistry): Router {
  const verifyRouter = Router();

  verifyRouter.get("/:receiptId", (req, res) => {
    const receipt = receiptRegistry.getReceipt(req.params.receiptId);

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

  return verifyRouter;
}
