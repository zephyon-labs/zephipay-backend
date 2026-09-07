import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserDevnetExecutionService } from "../src/devnet/browserDevnetExecution";

for(const evidence of ["none","receipt-only","time-only","complete"] as const){
 test(`finalized preparation read requires authoritative settlement and receipt (${evidence})`,async()=>{
  const aggregate={executionId:"execution",paymentIntentId:"payment",actorSubject:"account:owner",providerIdempotencyKey:"key",amountRaw:"1000000",recipientWallet:"recipient",purpose:null,createdAt:"2026-09-07T12:00:00.000Z",
    ...(["receipt-only","complete"].includes(evidence)?{receiptId:"receipt:execution"}:{}),
    ...(["time-only","complete"].includes(evidence)?{settledAt:"2026-09-07T12:01:00.000Z"}:{})};
  const payment={id:"payment",actorSubject:"account:owner",amountRaw:1000000n,recipientAddress:"recipient"};
  const service=new BrowserDevnetExecutionService(
    {async resolve(){return{account:{actorSubject:"account:owner"}};}} as any,
    {async findPayment(){return payment;}} as any,
    {async find(){return aggregate;},async applyLifecycle(){throw new Error("read must not mutate");}} as any,
    {async findPreparation(){return{state:"SETTLED",artifact:{signature:"public-signature"}};},async listSubmissionObservations(){return[{outcome:"SETTLED"}];},async listReconciliationObservations(){return[{outcome:"SETTLED",confirmationStatus:"finalized",slot:"199"}];}} as any,
    undefined,undefined,{} as any,"unused",{exposureEnabled:true,preparationEnabled:false,submissionEnabled:false,reconciliationEnabled:false,policyHash:"unused",maxRawAmount:5000000n});
  const result=await service.find({issuer:"https://issuer.invalid",providerSubject:"owner",scopes:[]},"payment");
  assert.equal(result.status,evidence==="complete"?"settled":"unknown_reconciliation_required");
  assert.equal(result.reconciliationPending,evidence!=="complete");
  assert.equal(result.providerStatus,evidence==="complete"?"settled":"unknown");
  assert.equal(result.transactionSignature,"public-signature");
 });
}
