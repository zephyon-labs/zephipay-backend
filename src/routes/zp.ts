import { Router, type RequestHandler } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import type { ZpProgressService } from "../growth/zpProgressService";
import { AccountAccessDeniedError } from "../identity/accountProvisioningService";

export function createZpRouter(input: Readonly<{
  service: ZpProgressService;
  projectionEnabled: boolean;
  readAuth: readonly RequestHandler[];
  readLimiter?: RequestHandler;
}>): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store, private");
    res.set("Pragma", "no-cache");
    next();
  });

  router.get("/zp", ...input.readAuth, ...(input.readLimiter ? [input.readLimiter] : []), async (_req, res) => {
    if (!input.projectionEnabled) {
      return res.status(503).json({
        ok: false,
        code: "ZP_PROJECTION_UNAVAILABLE",
        error: "ZP projection is unavailable.",
        requestId: res.locals.requestId,
      });
    }

    try {
      const zp = await input.service.getCurrent(externalPrincipalFrom(res));

      return res.json({
        ok: true,
        zp,
        requestId: res.locals.requestId,
      });
    } catch (error) {
      if (error instanceof AccountAccessDeniedError) {
        return res.status(403).json({
          ok: false,
          error: "Account access is unavailable.",
          requestId: res.locals.requestId,
        });
      }

      throw error;
    }
  });

  return router;
}
