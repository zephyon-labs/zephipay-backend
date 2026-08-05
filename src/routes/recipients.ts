import { Router, type Request, type Response } from "express";

import { externalPrincipalFrom } from "../auth/authMiddleware";
import { EconomicIdentityInputError } from "../economicIdentity/economicIdentityValidation";
import { AccountAccessDeniedError, AccountProvisioningService } from "../identity/accountProvisioningService";
import {
  createRecipientDirectoryAccountRateLimiter,
  createRecipientDirectoryIpRateLimiter,
} from "../middleware/recipientDirectoryRateLimiter";
import {
  parseExactSearchRequest,
  RecipientDirectoryError,
  RecipientDirectoryService,
  serializePublicRecipient,
} from "../recipients/recipientDirectoryService";

type RecipientRequest = Request & { recipientRequesterAccountId?: string };

export function createRecipientsRouter(accounts: AccountProvisioningService, directory: RecipientDirectoryService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store, private"); res.set("Pragma", "no-cache"); next();
  });
  router.use(createRecipientDirectoryIpRateLimiter());
  router.use(async (req: RecipientRequest, res, next) => {
    try {
      req.recipientRequesterAccountId = (await accounts.resolve(externalPrincipalFrom(res))).account.accountId;
      next();
    } catch (error) {
      if (error instanceof AccountAccessDeniedError) return res.status(403).json({ ok: false, error: "Recipient access is unavailable.", requestId: res.locals.requestId });
      next(error);
    }
  });
  router.use(createRecipientDirectoryAccountRateLimiter());

  router.post("/search", async (req: RecipientRequest, res) => {
    try {
      const recipients = await directory.searchExactUsername(requireRequester(req), parseExactSearchRequest(req.body));
      return res.json({ ok: true, recipients: recipients.map(serializePublicRecipient) });
    } catch (error) { return handle(error, res); }
  });

  router.get("/:accountId", async (req: RecipientRequest, res) => {
    try {
      const recipient = await directory.resolvePublicRecipient(requireRequester(req), String(req.params.accountId));
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
  if (error instanceof EconomicIdentityInputError || error instanceof RecipientDirectoryError && error.kind === "INVALID") {
    return res.status(400).json({ ok: false, error: "A valid exact username is required.", requestId: res.locals.requestId });
  }
  if (error instanceof RecipientDirectoryError) {
    return res.status(404).json({ ok: false, error: "Recipient was not found.", requestId: res.locals.requestId });
  }
  throw error;
}
