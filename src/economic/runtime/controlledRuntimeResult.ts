import type { RuntimePolicyDecisionV1 } from "zephyon-protocol";
import { machineId, requireCondition } from "../foundation/database";
import { exactObject } from "../foundation/strictJson";
import { frozen } from "../readiness/signedArtifact";

export type ControlledRuntimeAction = "runtime-evaluate" | "runtime-recover";
export type ControlledRuntimeResult = Readonly<{
  paymentId: string;
  mode: "non-value";
  productionReady: false;
  executionAuthorized: false;
  state: "NOT_EVALUATED" | "APPROVED" | "REJECTED" | "EXPIRED" | "NO_LONGER_CURRENT" | "UNAVAILABLE";
  historicalStatus: "NONE" | "APPROVED" | "REJECTED";
  currentApproval: boolean;
  decisionId: string | null;
  expiresAt: string | null;
}>;
const uuid=(v:unknown)=>typeof v==="string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);

/** Presentation only. The accepted adapter/Protocol must supply currentApproval; no policy is evaluated here. */
export function controlledRuntimeResult(paymentId:string, decision:RuntimePolicyDecisionV1|undefined,
  currentApproval:boolean, databaseTime:string, unavailable=false):ControlledRuntimeResult {
  const state:ControlledRuntimeResult["state"]=!decision?"NOT_EVALUATED":decision.status==="REJECTED"?"REJECTED":
    unavailable?"UNAVAILABLE":databaseTime>=decision.expiresAt?"EXPIRED":
    currentApproval && databaseTime>=decision.issuedAt?"APPROVED":"NO_LONGER_CURRENT";
  return validateControlledRuntimeResult({paymentId,mode:"non-value",productionReady:false,executionAuthorized:false,state,
    historicalStatus:decision?.status??"NONE",currentApproval:state==="APPROVED",decisionId:decision?.decisionId??null,expiresAt:decision?.expiresAt??null});
}

/** Strict, bounded signed-response contract; no envelope, evidence, provider artifacts or execution capability. */
export function validateControlledRuntimeResult(value:ControlledRuntimeResult):ControlledRuntimeResult {
  exactObject(value,["paymentId","mode","productionReady","executionAuthorized","state","historicalStatus","currentApproval","decisionId","expiresAt"]);
  requireCondition(uuid(value.paymentId) && value.mode==="non-value" && value.productionReady===false && value.executionAuthorized===false &&
    ["NOT_EVALUATED","APPROVED","REJECTED","EXPIRED","NO_LONGER_CURRENT","UNAVAILABLE"].includes(value.state) &&
    typeof value.currentApproval==="boolean" && value.currentApproval===(value.state==="APPROVED"),"Invalid non-value Runtime result.");
  if(value.state==="NOT_EVALUATED")requireCondition(value.historicalStatus==="NONE" && value.decisionId===null && value.expiresAt===null,"Unexpected historical Runtime decision.");
  else {
    machineId(value.decisionId);
    requireCondition(typeof value.expiresAt==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt) &&
      Number.isFinite(Date.parse(value.expiresAt)) && value.historicalStatus===(value.state==="REJECTED"?"REJECTED":"APPROVED"),"Invalid historical Runtime result.");
  }
  return frozen({...value});
}
