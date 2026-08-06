import { Router } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import {
  EconomicIdentityApplicationError,
  EconomicIdentityService,
  serializeCurrentIdentity,
  serializeIdentity,
} from "../economicIdentity/economicIdentityService";
import { EconomicIdentityInputError } from "../economicIdentity/economicIdentityValidation";

export function createEconomicIdentityRouter(service: EconomicIdentityService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store, private"); res.set("Pragma", "no-cache"); next();
  });
  router.get("/identity", async (_req, res) => {
    try { return res.json({ ok: true, ...serializeCurrentIdentity(await service.getCurrent(externalPrincipalFrom(res))) }); }
    catch (error) { return handle(error, res); }
  });
  router.put("/identity", async (req, res) => {
    try {
      const result = await service.upsertCurrent(externalPrincipalFrom(res), req.body);
      return res.status(result.created ? 201 : 200).json({ ok: true, identity: serializeIdentity(result.identity) });
    } catch (error) { return handle(error, res); }
  });
  router.put("/identity/destinations/solana", async (req, res) => {
    try {
      const result = await service.upsertSolanaDestination(externalPrincipalFrom(res), req.body);
      return res.status(result.created ? 201 : 200).json({ ok: true, destination: {
        id: result.destination.destinationId, type: "solana_wallet", address: result.destination.address,
        status: result.destination.status.toLowerCase(), ownershipState: result.destination.ownershipState.toLowerCase(),
        primary: result.destination.primary, version: result.destination.version.toString(),
        createdAt: result.destination.createdAt, updatedAt: result.destination.updatedAt,
      } });
    } catch (error) { return handle(error, res); }
  });
  return router;
}

function handle(error: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]) {
  if (error instanceof EconomicIdentityInputError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.message, requestId: res.locals.requestId });
  if (error instanceof EconomicIdentityApplicationError) {
    const status = error.kind === "ACCESS_DENIED" ? 403 : error.kind === "NOT_FOUND" ? 404 : 409;
    const code = error.kind === "ACCESS_DENIED" ? "ACCESS_DENIED" : error.kind === "NOT_FOUND" ? "NOT_FOUND" : error.kind;
    return res.status(status).json({ ok: false, code, error: error.message, requestId: res.locals.requestId });
  }
  throw error;
}
