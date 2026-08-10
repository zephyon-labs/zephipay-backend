import { Router, type RequestHandler } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import {
  parseConfirmPaymentIntentRequest,
  parseIdempotencyKey,
  parsePaymentIntentId,
  parsePaymentIntentRequest,
  PaymentIntentInputError,
} from "../payments/paymentIntentValidation";
import {
  PaymentIntentApplicationError,
  PaymentIntentService,
} from "../services/paymentIntentService";

export function createPaymentIntentsRouter(input: Readonly<{
  service: PaymentIntentService;
  readAuth: readonly RequestHandler[];
  writeAuth: readonly RequestHandler[];
  mutationLimiter?: RequestHandler;
  readLimiter?: RequestHandler;
}>): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store, private");
    res.set("Pragma", "no-cache");
    next();
  });
  router.post("/", ...input.writeAuth, ...(input.mutationLimiter ? [input.mutationLimiter] : []), async (req, res) => {
    try {
      const body = parsePaymentIntentRequest(req.body);
      const result = await input.service.create(externalPrincipalFrom(res), {
        ...body,
        idempotencyKey: parseIdempotencyKey(req.header("idempotency-key")),
      });
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        paymentIntent: result.paymentIntent,
        requestId: res.locals.requestId,
      });
    } catch (error) {
      return handlePaymentIntentError(error, res);
    }
  });

  router.get("/:id", ...input.readAuth, ...(input.readLimiter ? [input.readLimiter] : []), async (req, res) => {
    try {
      const paymentIntent = await input.service.find(
        externalPrincipalFrom(res),
        parsePaymentIntentId(String(req.params.id)),
      );
      return res.json({ ok: true, paymentIntent, requestId: res.locals.requestId });
    } catch (error) {
      return handlePaymentIntentError(error, res);
    }
  });

  router.post("/:id/confirm", ...input.writeAuth, ...(input.mutationLimiter ? [input.mutationLimiter] : []), async (req, res) => {
    try {
      const confirmation = parseConfirmPaymentIntentRequest(req.body);
      const result = await input.service.confirm(externalPrincipalFrom(res), {
        paymentId: parsePaymentIntentId(String(req.params.id)),
        ...confirmation,
        requestId: String(res.locals.requestId),
      });
      return res.json({
        ok: true,
        applied: result.applied,
        paymentIntent: result.paymentIntent,
        requestId: res.locals.requestId,
      });
    } catch (error) {
      return handlePaymentIntentError(error, res);
    }
  });

  return router;
}

export const paymentIntentServiceUnavailable: RequestHandler = (_req, res) => {
  res.status(503).set("Cache-Control", "no-store, private").set("Pragma", "no-cache").json({
    ok: false,
    error: "Payment intent service is not configured.",
    requestId: res.locals.requestId,
  });
};

function handlePaymentIntentError(error: unknown, res: Parameters<RequestHandler>[1]) {
  if (error instanceof PaymentIntentInputError) {
    return res.status(400).json({ ok: false, error: error.message, requestId: res.locals.requestId });
  }
  if (error instanceof PaymentIntentApplicationError) {
    const status = error.kind === "ACCESS_DENIED" ? 403 : error.kind === "NOT_FOUND" ? 404 : 409;
    return res.status(status).json({ ok: false, error: error.message, requestId: res.locals.requestId });
  }
  throw error;
}
