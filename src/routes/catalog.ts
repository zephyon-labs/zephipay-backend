import { Router } from "express";
import { serviceCatalog } from "../catalog/serviceCatalog";
import { catalogCategories } from "../catalog/categories";
export const catalogRouter = Router();

catalogRouter.get("/services", (req, res) => {
  const category = req.query.category as string | undefined;

  const services = category
    ? serviceCatalog.filter(service => service.category === category)
    : serviceCatalog;

  res.json({
    ok: true,
    count: services.length,
    category: category || "all",
    services,
  });
});
catalogRouter.get("/categories", (_req, res) => {
  res.json({
    ok: true,
    count: catalogCategories.length,
    categories: catalogCategories,
  });
});
catalogRouter.get("/services/:id", (req, res) => {
  const service = serviceCatalog.find(service => service.id === req.params.id);

  if (!service) {
    return res.status(404).json({
      ok: false,
      found: false,
      error: "Service not found",
    });
  }

  return res.json({
    ok: true,
    found: true,
    service,
  });
});