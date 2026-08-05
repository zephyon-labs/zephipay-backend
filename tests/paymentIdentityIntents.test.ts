import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { parsePaymentIntentRequest } from "../src/payments/paymentIntentValidation";
import { PaymentIntentApplicationError,PaymentIntentService } from "../src/services/paymentIntentService";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";

const NOW="2026-08-05T12:00:00.000Z", RECIPIENT="00000000-0000-4000-8000-000000000902";
const principal={issuer:"https://tenant.example/",providerSubject:"auth0|identity",scopes:["write:payments"]} as const;

async function fixture(state:"VERIFIED"|"UNVERIFIED"|"PENDING"|"RESTRICTED"="UNVERIFIED") {
  const accounts=new AccountProvisioningService(new InMemoryIdentityPersistence({clock:()=>NOW}));
  const account=(await accounts.resolve(principal)).account;
  let destination="2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
  const payments=new InMemoryPaymentPersistence({clock:()=>NOW,resolvePaymentIdentity:async()=>({username:"recipient_01",displayName:"Recipient",accountType:"PERSONAL",verificationState:state,payabilityState:"AVAILABLE",destinationAddress:destination})});
  await payments.createAllowlistEntry({actorSubject:account.actorSubject}); let next=1;
  const service=new PaymentIntentService(accounts,payments,{clock:()=>NOW,createId:()=>`00000000-0000-4000-8000-${String(next++).padStart(12,"0")}`});
  return {service,payments,setDestination:(value:string)=>{destination=value;}};
}
const request=(ack=true)=>({idempotencyKey:"identity-key-00000001",recipientType:"payment_identity" as const,recipientAccountId:RECIPIENT,amount:"1",purpose:"Test",...(ack?{trustAcknowledgment:{acknowledged:true as const}}:{})});

describe("Payment Identity intents",()=>{
  it("accepts only the exact identity request",()=>{
    assert.deepEqual(parsePaymentIntentRequest({recipientType:"payment_identity",recipientAccountId:RECIPIENT,amount:"1",purpose:"Test"}),{recipientType:"payment_identity",recipientAccountId:RECIPIENT,amount:"1",purpose:"Test"});
    for(const extra of [{recipient:"wallet"},{walletAddress:"wallet"},{verificationState:"verified"},{snapshot:{}},{trustAcknowledgment:{acknowledged:false}}]) assert.throws(()=>parsePaymentIntentRequest({recipientType:"payment_identity",recipientAccountId:RECIPIENT,amount:"1",purpose:"Test",...extra}));
  });
  it("enforces trust, hides destination, converges, and conflicts on destination changes",async()=>{
    const {service,setDestination}=await fixture(); await assert.rejects(()=>service.create(principal,request(false)),(e)=>e instanceof PaymentIntentApplicationError&&e.kind==="CONFLICT");
    const first=await service.create(principal,request()); const replay=await service.create(principal,request()); assert.equal(replay.created,false);
    assert.equal(first.paymentIntent.recipientType,"payment_identity"); assert.equal("recipient" in first.paymentIntent,false);
    setDestination("4Nd1mYwRkXkYtGT7dQz4FzRzCQXDpGfVv3YJz7drGqPv");
    await assert.rejects(()=>service.create(principal,request()),(e)=>e instanceof PaymentIntentApplicationError&&e.kind==="CONFLICT");
  });
  it("uses NOT_REQUIRED for verified, blocks restricted, and derives only confirmed recents",async()=>{
    const verified=await fixture("VERIFIED"); const created=await verified.service.create(principal,request(false));
    assert.equal(created.paymentIntent.recipientType==="payment_identity"&&created.paymentIntent.recipientSnapshot.trustOutcome,"not_required");
    assert.deepEqual(await verified.service.recent(principal),[]);
    await verified.service.confirm(principal,{paymentId:created.paymentIntent.id,requestHash:created.paymentIntent.requestHash,expectedVersion:0n});
    assert.equal((await verified.service.recent(principal)).length,1);
    const restricted=await fixture("RESTRICTED"); await assert.rejects(()=>restricted.service.create(principal,request()),(e)=>e instanceof PaymentIntentApplicationError&&e.kind==="NOT_FOUND");
  });
});
