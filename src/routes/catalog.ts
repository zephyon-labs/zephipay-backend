import { Router } from "express";
import { serviceCatalog } from "../catalog/serviceCatalog";

export const catalogRouter = Router();

catalogRouter.get("/services", (_req, res) => {
  res.json({
    ok: true,
    count: serviceCatalog.length,
    services: serviceCatalog,
  });
});