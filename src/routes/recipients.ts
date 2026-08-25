import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import { EconomicIdentityInputError } from "../economicIdentity/economicIdentityValidation";
import { AccountAccessDeniedError, AccountProvisioningService } from "../identity/accountProvisioningService";
import {
  createRecipientDirectoryAccountRateLimiter,
} from "../middleware/recipientDirectoryRateLimiter";
import {
  parseExactSearchRequest,
  RecipientDirectoryError,
  RecipientDirectoryService,
  serializePublicRecipient,
} from "../recipients/recipientDirectoryService";
import { PaymentIntentApplicationError, type PaymentIntentService } from "../services/paymentIntentService";

type RecipientRequest = Request & { recipientRequesterAccountId?: string };

export function createRecipientsRouter(input: Readonly<{
  accounts: AccountProvisioningService;
  directory: RecipientDirectoryService;
  payments?: PaymentIntentService;
  directoryReadAuth: readonly RequestHandler[];
  historyReadAuth: readonly RequestHandler[];
}>): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store, private"); res.set("Pragma", "no-cache"); next();
  });
  const resolveRequester = async (req: RecipientRequest, res: Response, next: NextFunction) => {
    try {
      req.recipientRequesterAccountId = (await input.accounts.resolve(externalPrincipalFrom(res))).account.accountId;
      next();
    } catch (error) {
      if (error instanceof AccountAccessDeniedError) return res.status(403).json({ ok: false, error: "Recipient access is unavailable.", requestId: res.locals.requestId });
      next(error);
    }
  };
  const accountLimiter = createRecipientDirectoryAccountRateLimiter();

  router.post("/search", ...input.directoryReadAuth, resolveRequester, accountLimiter, async (req: RecipientRequest, res) => {
    try {
      const recipients = await input.directory.searchExactUsername(requireRequester(req), parseExactSearchRequest(req.body));
      return res.json({ ok: true, recipients: recipients.map(serializePublicRecipient) });
    } catch (error) { return handle(error, res); }
  });

  router.get("/recent", ...input.historyReadAuth, resolveRequester, accountLimiter, async (_req: RecipientRequest, res) => {
    if (!input.payments) return res.status(503).json({ ok: false, error: "Recent recipients are unavailable.", requestId: res.locals.requestId });
    try {
      return res.json({ ok: true, recipients: await input.payments.recent(externalPrincipalFrom(res)) });
    } catch (error) { return handle(error, res); }
  });

  router.get("/:accountId", ...input.directoryReadAuth, resolveRequester, accountLimiter, async (req: RecipientRequest, res) => {
    try {
      const recipient = await input.directory.resolvePublicRecipient(requireRequester(req), String(req.params.accountId));
      return res.json({ ok: true, recipient: serializePublicRecipient(recipient) });
    } catch (error) { return handle(error, res); }
  });
  return router;
}

function requireRequester(req: RecipientRequest): string {
  if (!req.recipientRequesterAccountId) throw new Error("Canonical requester account is unavailable.");
  return req.recipientRequesterAccountId;
}

function handle(error: unknown, res: Response) {
  if (error instanceof PaymentIntentApplicationError) {
    return res.status(error.kind === "ACCESS_DENIED" ? 403 : 404).json({ ok: false, error: "Recipient access is unavailable.", requestId: res.locals.requestId });
  }
  if (error instanceof EconomicIdentityInputError || error instanceof RecipientDirectoryError && error.kind === "INVALID") {
    return res.status(400).json({ ok: false, error: "A valid exact username is required.", requestId: res.locals.requestId });
  }
  if (error instanceof RecipientDirectoryError) {
    return res.status(404).json({ ok: false, error: "Recipient was not found.", requestId: res.locals.requestId });
  }
  throw error;
}
