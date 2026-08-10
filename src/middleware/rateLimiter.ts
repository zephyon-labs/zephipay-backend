import { createHash } from "node:crypto";

import rateLimit, { type Options } from "express-rate-limit";

import type { ExternalPrincipal } from "../auth/externalPrincipal";
import { environment } from "../config/environment";

function safeHandler(category: string, error: string): NonNullable<Options["handler"]> {
  return (req, res, _next, options) => {
    const requestId = String(res.locals.requestId || "unknown");
    console.warn("Request rate limited.", {
      category,
      method: req.method,
      requestId,
      routeFamily: req.baseUrl || "unknown",
      status: options.statusCode,
    });
    return res.status(options.statusCode).json({ ok: false, error, requestId });
  };
}

function principalKey(_req: Parameters<NonNullable<Options["keyGenerator"]>>[0], res: Parameters<NonNullable<Options["keyGenerator"]>>[1]): string {
  const principal = res.locals.externalPrincipal as ExternalPrincipal | undefined;
  if (!principal) return "authenticated-principal-unavailable";
  return createHash("sha256").update(`${principal.issuer}\0${principal.providerSubject}`).digest("hex");
}

export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  handler: safeHandler("public", "Too many requests. Please slow down."),
});

export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  handler: safeHandler("public-sensitive", "Too many verification or receipt requests. Please slow down."),
});

export const paymentMutationRateLimiter = rateLimit({
  windowMs: 60 * 1000, limit: environment.paymentRateLimitPerMinute,
  standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: false,
  keyGenerator: principalKey,
  handler: safeHandler("payment-mutation", "Too many payment attempts. Please wait before trying again."),
});

export const authenticatedReadRateLimiter = rateLimit({
  windowMs: 60 * 1000, limit: environment.authenticatedReadRateLimitPerMinute,
  standardHeaders: true, legacyHeaders: false, keyGenerator: principalKey,
  handler: safeHandler("authenticated-read", "Too many status checks. Please wait before checking again."),
});
