import { Router } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import { AccountAccessDeniedError, AccountProvisioningService } from "../identity/accountProvisioningService";

export function createAccountRouter(service: AccountProvisioningService): Router {
  const router = Router();
  router.get("/me", async (_req, res) => {
    res.set("Cache-Control", "no-store, private");
    res.set("Pragma", "no-cache");
    try {
      const result = await service.resolve(externalPrincipalFrom(res));
      return res.json({
        ok: true,
        account: {
          id: result.account.accountId,
          actorSubject: result.account.actorSubject,
          status: result.account.status.toLowerCase(),
          createdAt: result.account.createdAt,
          identities: result.identities.map((identity) => ({
            providerType: providerType(identity.issuer),
            email: null,
            emailVerified: false,
            linkedAt: identity.linkedAt,
          })),
        },
      });
    } catch (error) {
      if (error instanceof AccountAccessDeniedError) {
        return res.status(403).json({ ok: false, error: "Account access is unavailable.", requestId: res.locals.requestId });
      }
      throw error;
    }
  });
  return router;
}

function providerType(issuer: string): string {
  try { return new URL(issuer).hostname; } catch { return "external"; }
}
