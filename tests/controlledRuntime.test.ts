import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { createControlledWebConfirmationRouter } from "../src/routes/controlledWebConfirmation";
import { validateControlledRuntimeResult, type ControlledRuntimeResult } from "../src/economic/runtime/controlledRuntimeResult";
import { signRuntimeResponse, signWebRequest, verifyRuntimeResponse } from "../src/economic/web/handoffContract";

test("controlled Runtime response forbids execution claims, contradictory current/history states and unbounded additions",()=>{
  const result:ControlledRuntimeResult={paymentId:randomUUID(),mode:"non-value",productionReady:false,executionAuthorized:false,
    state:"APPROVED",historicalStatus:"APPROVED",currentApproval:true,decisionId:randomUUID(),expiresAt:"2026-10-10T12:00:00.000Z"};
  assert.deepEqual(validateControlledRuntimeResult(result),result);
  for(const change of [{executionAuthorized:true},{productionReady:true},{mode:"value"},{state:"SENT"},{state:"APPROVED",currentApproval:false},
    {state:"EXPIRED",currentApproval:true},{historicalStatus:"REJECTED"},{decisionId:"x".repeat(1000)},{expiresAt:"tomorrow"},
    {evidence:[]},{envelopeDigest:"aa".repeat(32)}])assert.throws(()=>validateControlledRuntimeResult({...result,...change} as ControlledRuntimeResult));
  for(const state of ["EXPIRED","NO_LONGER_CURRENT","UNAVAILABLE"] as const)
    assert.equal(validateControlledRuntimeResult({...result,state,currentApproval:false}).historicalStatus,"APPROVED");
});

test("controlled Runtime signed response is bound to payment, action, exact request and pinned response key",()=>{
  const site=generateKeyPairSync("ed25519"),backend=generateKeyPairSync("ed25519");
  const context={environment:"TEST",configuration:"ab".repeat(32),siteOrigin:"https://site.invalid",backendOrigin:"https://backend.invalid",issuer:"https://issuer.invalid/",clientId:"test-client"};
  const body={paymentId:randomUUID(),session:{reference:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+60,subject:"test",accessToken:"test",idToken:"test"}};
  const request=signWebRequest(context,"runtime-recover",body,site.privateKey);
  const result:ControlledRuntimeResult={paymentId:body.paymentId,mode:"non-value",productionReady:false,executionAuthorized:false,state:"NOT_EVALUATED",
    historicalStatus:"NONE",currentApproval:false,decisionId:null,expiresAt:null};
  const response=signRuntimeResponse(request,result,backend.privateKey);
  assert.deepEqual(verifyRuntimeResponse(request,response,backend.publicKey),result);
  assert.throws(()=>verifyRuntimeResponse(request,response,site.publicKey));
  assert.throws(()=>verifyRuntimeResponse(signWebRequest(context,"runtime-evaluate",body,site.privateKey),response,backend.publicKey));
  assert.throws(()=>verifyRuntimeResponse(request,signRuntimeResponse(request,{...result,paymentId:randomUUID()},backend.privateKey),backend.publicKey));
  const nonRuntime=signWebRequest(context,"recover",body,site.privateKey);
  assert.throws(()=>verifyRuntimeResponse(nonRuntime,signRuntimeResponse(nonRuntime,result,backend.privateKey),backend.publicKey));
});

test("ordinary unconfigured Backend private router stays closed for both Runtime actions",async()=>{
  const app=express();app.use("/internal/controlled-confirmation",createControlledWebConfirmationRouter());
  const server=app.listen(0,"127.0.0.1");
  try {
    await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
    for(const action of ["runtime-evaluate","runtime-recover"]) {
      const result=await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/internal/controlled-confirmation/${action}`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({paymentId:randomUUID()})});
      assert.equal(result.status,404);assert.equal(result.headers.get("cache-control"),"private, no-store");
    }
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
