import rateLimit from "express-rate-limit";

export const RECIPIENT_DIRECTORY_WINDOW_MS = 60_000;
export const RECIPIENT_DIRECTORY_IP_LIMIT = 30;
export const RECIPIENT_DIRECTORY_ACCOUNT_LIMIT = 20;

const message = { ok: false, error: "Too many recipient lookups. Please wait before trying again." };

export function createRecipientDirectoryIpRateLimiter() { return rateLimit({
  windowMs: RECIPIENT_DIRECTORY_WINDOW_MS,
  limit: RECIPIENT_DIRECTORY_IP_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message,
}); }

export function createRecipientDirectoryAccountRateLimiter() { return rateLimit({
  windowMs: RECIPIENT_DIRECTORY_WINDOW_MS,
  limit: RECIPIENT_DIRECTORY_ACCOUNT_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req as typeof req & { recipientRequesterAccountId?: string }).recipientRequesterAccountId ?? "unresolved"),
  message,
}); }
