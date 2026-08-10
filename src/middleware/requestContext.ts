import { randomUUID } from "node:crypto";

import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { databaseOperationFor, elapsed, emitReliabilityLog, normalizeRouteFamily, recordCounter, recordTiming, runWithReliabilityContext } from "../observability/reliabilityObservability";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const suppliedRequestId = req.header("x-request-id")?.trim();

  const requestId =
    suppliedRequestId &&
    REQUEST_ID_PATTERN.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();

  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  const routeFamily = normalizeRouteFamily(req.originalUrl || req.url);
  const method = req.method.toUpperCase();
  const started = performance.now();
  runWithReliabilityContext({ requestId, routeFamily, method, dbOperation: databaseOperationFor(routeFamily, method) }, () => {
    res.once("finish", () => {
      const durationMs = elapsed(started);
      recordCounter("http.request", { method, routeFamily, status: String(res.statusCode) });
      recordTiming("http.request.duration", durationMs, { method, routeFamily, status: String(res.statusCode) });
      emitReliabilityLog("info", "http_request_completed", { requestId, routeFamily, method, status: res.statusCode, durationMs,
        ...(typeof res.locals.limiterCategory === "string" ? { limiterCategory: res.locals.limiterCategory } : {}),
        ...(typeof res.locals.safeErrorCategory === "string" ? { outcome: res.locals.safeErrorCategory } : {}),
      });
    });
    next();
  });
}
