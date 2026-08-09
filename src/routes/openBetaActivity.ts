import { Router, type Response } from "express";

import type { OpenBetaActivityService } from "../telemetry/openBetaActivity";

export function createOpenBetaActivityRouter(service?: OpenBetaActivityService): Router {
  const router = Router();
  router.get("/open-beta", async (_req, res) => {
    if (!service) return unavailable(res);
    try {
      const data = await service.read();
      return res
        .set("Cache-Control", "public, max-age=30, stale-while-revalidate=120")
        .json({ ok: true, data });
    } catch {
      return unavailable(res);
    }
  });
  return router;
}

function unavailable(res: Response) {
  return res.status(503).set("Cache-Control", "no-store").json({
    ok: false,
    error: "Open Beta activity is temporarily unavailable.",
  });
}
