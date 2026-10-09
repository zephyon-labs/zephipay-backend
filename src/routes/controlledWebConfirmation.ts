import express from "express";
import type { ControlledWebConfirmation } from "../economic/web/controlledWebConfirmation";
import { webActions, type WebAction } from "../economic/web/handoffContract";

/** Mounted only in the explicit non-value service composition. No CORS/browser bearer authority.
 * The public Backend mounts the same closed router without a configured authority by default. */
export function createControlledWebConfirmationRouter(service?: Pick<ControlledWebConfirmation,"handle">) {
  const router=express.Router();
  router.use((_req,res,next)=>{res.set("Cache-Control","private, no-store");next();});
  router.post("/:action",express.json({limit:"40kb",strict:true}),async(req,res)=>{
    if(!service || !webActions.includes(req.params.action as WebAction)) {res.status(404).json({error:"Controlled confirmation unavailable."});return;}
    try {res.json(await service.handle(req.params.action as WebAction,req.body));}
    catch {res.status(409).json({error:"Controlled confirmation could not be authorized. Recover current state."});}
  });
  router.all("/{*path}",(_req,res)=>{res.status(405).json({error:"Method not allowed."});});
  return router;
}
