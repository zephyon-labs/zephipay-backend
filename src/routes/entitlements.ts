import { Router } from "express";
import type { ReceiptRegistry } from "../receipts/receiptRegistry";

function isExpired(expiresAt: string | null | undefined) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

function hasUsesRemaining(usesRemaining: number | null | undefined) {
  if (usesRemaining === null || usesRemaining === undefined) return true;
  return usesRemaining > 0;
}
export function createEntitlementsRouter(receiptRegistry: ReceiptRegistry): Router {
  const entitlementsRouter = Router();

  entitlementsRouter.get("/:wallet/check", (req, res) => {
    const wallet = req.params.wallet;
    const resource = req.query.resource as string | undefined;

    if (!resource) {
      return res.status(400).json({
        ok: false,
        error: "Missing required query parameter: resource",
      });
    }

    const receipts = receiptRegistry.listReceipts();

    const matchingEntitlement = receipts
      .filter((receipt: any) => {
        const owner = receipt?.ownership?.owner;
        const payTo = receipt?.payment?.payTo;
        const payer = receipt?.settlementProof?.payer;

        return owner === wallet || payTo === wallet || payer === wallet;
      })
      .map((receipt: any) => {
        const entitlement = receipt?.entitlements;

        const active =
          Boolean(entitlement?.accessGranted) &&
          !isExpired(entitlement?.expiresAt) &&
          hasUsesRemaining(entitlement?.usesRemaining);

        return {
          receipt,
          entitlement,
          active,
        };
      })
      .find(({ entitlement, active }) => {
        return active && entitlement?.resource === resource;
      });

    if (!matchingEntitlement) {
      return res.json({
        ok: true,
        wallet,
        resource,
        authorized: false,
        reason: "No active entitlement found for this wallet and resource.",
      });
    }

    return res.json({
      ok: true,
      wallet,
      resource,
      authorized: true,
      receiptId: matchingEntitlement.receipt.localReceiptId,
      entitlement: matchingEntitlement.entitlement,
    });
  });

  entitlementsRouter.get("/:wallet", (req, res) => {
    const wallet = req.params.wallet;

    const receipts = receiptRegistry.listReceipts();

    const entitlements = receipts
      .filter((receipt: any) => {
        const owner = receipt?.ownership?.owner;
        const payTo = receipt?.payment?.payTo;
        const payer = receipt?.settlementProof?.payer;

        return owner === wallet || payTo === wallet || payer === wallet;
      })
      .map((receipt: any) => {
        const entitlement = receipt?.entitlements || null;

        const active =
          Boolean(entitlement?.accessGranted) &&
          !isExpired(entitlement?.expiresAt) &&
          hasUsesRemaining(entitlement?.usesRemaining);

        return {
          receiptId: receipt.localReceiptId,
          owner: receipt?.ownership?.owner,
          paymentProtocol: receipt?.paymentProtocol,
          resource: entitlement?.resource || receipt?.resource?.path,
          entitlement,
          active,
          createdAt: receipt.createdAt,
        };
      });

    res.json({
      ok: true,
      wallet,
      count: entitlements.length,
      entitlements,
    });
  });

  return entitlementsRouter;
}
