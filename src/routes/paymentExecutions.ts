import { Router, type RequestHandler, type Response } from "express";
import { externalPrincipalFrom } from "../auth/authMiddleware";
import { ExecutionApplicationError, PaymentExecutionService } from "../executions/executionService";
import { parsePaymentIntentId } from "../payments/paymentIntentValidation";

export function createPaymentExecutionsRouter(input: { service: PaymentExecutionService; readAuth: readonly RequestHandler[]; writeAuth: readonly RequestHandler[]; mutationLimiter?: RequestHandler; readLimiter?: RequestHandler }): Router {
  const router=Router(); router.use(privateNoStore);
  router.post("/:id/execute",...input.writeAuth,...(input.mutationLimiter?[input.mutationLimiter]:[]),async(req,res)=>{try{const result=await input.service.execute(externalPrincipalFrom(res),parsePaymentIntentId(String(req.params.id)),req.body);return res.status(result.created?202:200).json({ok:true,created:result.created,execution:result.execution,requestId:res.locals.requestId});}catch(error){return handle(error,res);}});
  router.get("/:id/execution",...input.readAuth,...(input.readLimiter?[input.readLimiter]:[]),async(req,res)=>{try{return res.json({ok:true,execution:await input.service.find(externalPrincipalFrom(res),parsePaymentIntentId(String(req.params.id))),requestId:res.locals.requestId});}catch(error){return handle(error,res);}});
  router.get("/:id/receipt",...input.readAuth,...(input.readLimiter?[input.readLimiter]:[]),async(req,res)=>{try{return res.json({ok:true,receipt:await input.service.receipt(externalPrincipalFrom(res),parsePaymentIntentId(String(req.params.id))),requestId:res.locals.requestId});}catch(error){return handle(error,res);}});
  return router;
}

export function createActivityRouter(input: { service: PaymentExecutionService; readAuth: readonly RequestHandler[]; readLimiter?: RequestHandler }): Router {
  const router=Router(); router.use(privateNoStore);
  router.get("/",...input.readAuth,...(input.readLimiter?[input.readLimiter]:[]),async(req,res)=>{try{const limit=req.query.limit===undefined?20:Number(req.query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ExecutionApplicationError("INVALID","Activity limit must be between 1 and 50.");return res.json({ok:true,items:await input.service.activity(externalPrincipalFrom(res),limit),requestId:res.locals.requestId});}catch(error){return handle(error,res);}});
  return router;
}

const privateNoStore: RequestHandler = (_req,res,next) => { res.set("Cache-Control","no-store, private"); res.set("Pragma","no-cache"); next(); };
function handle(error: unknown, res: Response) { if(error instanceof ExecutionApplicationError){const status=error.kind==="INVALID"?400:error.kind==="ACCESS_DENIED"?403:error.kind==="NOT_FOUND"?404:409;return res.status(status).json({ok:false,error:error.message,requestId:res.locals.requestId});}throw error; }
