import { Router, type RequestHandler } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import {
  EconomicIdentityApplicationError,
  EconomicIdentityService,
  serializeCurrentIdentity,
  serializeIdentity,
} from "../economicIdentity/economicIdentityService";
import { EconomicIdentityInputError } from "../economicIdentity/economicIdentityValidation";

export function createEconomicIdentityRouter(input: Readonly<{
  service: EconomicIdentityService;
  readAuth: readonly RequestHandler[];
  writeAuth: readonly RequestHandler[];
  limiter?: RequestHandler;
}>): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store, private"); res.set("Pragma", "no-cache"); next();
  });
  router.get("/identity", ...input.readAuth, ...(input.limiter ? [input.limiter] : []), async (_req, res) => {
    try { return res.json({ ok: true, ...serializeCurrentIdentity(await input.service.getCurrent(externalPrincipalFrom(res))) }); }
    catch (error) { return handle(error, res); }
  });
  router.put("/identity", ...input.writeAuth, ...(input.limiter ? [input.limiter] : []), async (req, res) => {
    try {
      const result = await input.service.upsertCurrent(externalPrincipalFrom(res), req.body);
      return res.status(result.created ? 201 : 200).json({ ok: true, identity: serializeIdentity(result.identity) });
    } catch (error) { return handle(error, res); }
  });
  router.put("/identity/destinations/solana", ...input.writeAuth, ...(input.limiter ? [input.limiter] : []), async (req, res) => {
    try {
      const result = await input.service.upsertSolanaDestination(externalPrincipalFrom(res), req.body);
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
