import { randomUUID } from "node:crypto";

import type {
  NextFunction,
  Request,
  Response,
} from "express";

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

  next();
}
