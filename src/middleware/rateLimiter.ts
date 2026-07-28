import rateLimit from "express-rate-limit";

import { environment } from "../config/environment";

export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "Too many requests. Please slow down.",
  },
});

export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error:
      "Too many verification or receipt requests. Please slow down.",
  },
});

export const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: environment.paymentRateLimitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: {
    ok: false,
    error:
      "Too many payment attempts. Please wait before trying again.",
  },
});
