import { Router } from "express";
import type { ReadinessService } from "../health/readiness";

export function createHealthRouter(readiness: ReadinessService): Router {
  const router=Router();
  router.get("/live",(_req,res)=>res.status(200).set("Cache-Control","no-store").json({ok:true,status:"alive"}));
  router.get("/ready",async(_req,res)=>{
    const result=await readiness.check();
    return res.status(result.ready?200:503).set("Cache-Control","no-store").json({ok:result.ready,status:result.ready?"ready":"unavailable"});
  });
  return router;
}
