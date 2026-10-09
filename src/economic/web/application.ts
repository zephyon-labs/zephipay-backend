import express from "express";
import { createControlledWebConfirmationRouter } from "../../routes/controlledWebConfirmation";
import type { ControlledWebConfirmation } from "./controlledWebConfirmation";

/** Isolated non-value HTTP composition. Callers must supply an explicitly constructed
 * TEST-only identity service; no default credentials, wallet, Runtime or execution port. */
export function createControlledWebApplication(service: Pick<ControlledWebConfirmation,"handle">) {
  const app=express();app.disable("x-powered-by");
  app.use("/internal/controlled-confirmation",createControlledWebConfirmationRouter(service));
  return app;
}
