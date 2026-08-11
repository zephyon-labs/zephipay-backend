import assert from "node:assert/strict";
import { test } from "node:test";
import { PaymentExecutionService } from "../src/executions/executionService";
import { PostgresActivityRepository } from "../src/storage/postgres/postgresActivityRepository";

const NOW="2026-08-07T12:00:00.000Z";
const actor={resolve:async(p:any)=>({account:{actorSubject:p.subject,accountId:"account-owner"}})} as any;

test("consolidated activity preserves the public contract for present and absent execution facts",async()=>{
  let calls=0;const activity={listByActor:async(subject:string,limit:number)=>{calls++;assert.equal(subject,"auth0|owner");assert.equal(limit,2);return[
    {paymentIntentId:"payment-2",userConfirmedAt:NOW,recipientSnapshot:{accountId:"recipient",username:"recipient",displayName:"Recipient",accountType:"PERSONAL",verificationState:"VERIFIED",payabilityState:"AVAILABLE",capturedAt:NOW,schemaVersion:1,resolutionSource:"RECIPIENT_DIRECTORY",trustOutcome:"ACKNOWLEDGED"},amountUnits:"1250000",asset:"USDC",memo:null,createdAt:"2026-08-07T12:00:01.000Z",executionId:"execution-2",executionStatus:"SETTLED",settledAt:"2026-08-07T12:00:02.000Z",receiptId:"receipt:execution-2"},
    {paymentIntentId:"payment-1",amountUnits:"1000000",asset:"USDC",memo:"Dinner",createdAt:NOW},
  ] as const;}};
  const forbidden=new Proxy({}, {get(){throw new Error("legacy activity query path used");}}) as any;
  const service=new PaymentExecutionService(actor,forbidden,forbidden,undefined,undefined,activity);
  const result=await service.activity({subject:"auth0|owner"} as any,2);
  assert.equal(calls,1);assert.deepEqual(result,[
    {paymentIntentId:"payment-2",executionId:"execution-2",receiptId:"receipt:execution-2",status:"completed",recipient:{type:"payment_identity",displayName:"Recipient",username:"recipient",verificationState:"verified",trustOutcome:"acknowledged"},amountRaw:"1250000",amount:"1.25",asset:"USDC",memo:null,createdAt:"2026-08-07T12:00:01.000Z",settledAt:"2026-08-07T12:00:02.000Z",receiptAvailable:true},
    {paymentIntentId:"payment-1",status:"awaiting_confirmation",recipient:{type:"direct_wallet",displayName:"Wallet recipient"},amountRaw:"1000000",amount:"1",asset:"USDC",memo:"Dinner",createdAt:NOW,receiptAvailable:false},
  ]);
});

test("PostgreSQL activity repository uses one owner-filtered limited query independently of N",async()=>{
  let calls=0;let sql="";let values:unknown[]=[];const pool={query:async(text:string,input:unknown[])=>{calls++;sql=text;values=input;return{rows:[]};}} as any;
  const repository=new PostgresActivityRepository(pool);await repository.listByActor("zp:account:owner",50);
  assert.equal(calls,1);assert.deepEqual(values,["zp:account:owner",50]);assert.match(sql,/WHERE actor_subject=\$1/);assert.match(sql,/LIMIT \$2/);assert.match(sql,/LEFT JOIN payment_executions/);assert.match(sql,/LEFT JOIN payment_execution_receipts/);assert.match(sql,/ORDER BY p\.created_at DESC,p\.id DESC/);
});
