import assert from"node:assert/strict";
import{test}from"node:test";
import{DevnetRecoveryWorker}from"../src/devnet/devnetRecoveryWorker";
import type{DevnetRecoveryRecord}from"../src/devnet/devnetRecoveryRepository";
import type{PersistedDevnetPreparation}from"../src/devnet/devnetExecutionState";
import{InMemoryDevnetRecoveryRepository}from"../src/storage/memory/inMemoryDevnetRecoveryRepository";

function advancingClock(){let now=Date.parse("2026-08-13T12:00:00.000Z");return()=>new Date(now+=1_000).toISOString();}
const NOW="2026-08-13T12:00:00.000Z",INTENT="11111111-1111-4111-8111-111111111111",ACTOR="account:owner";
function preparation(executionId:string,state:PersistedDevnetPreparation["state"]):PersistedDevnetPreparation{return{preparationId:`prep-${executionId}`,executionId,paymentIntentId:INTENT,actorSubject:ACTOR,generation:1,state,encryptedSignedTransaction:{algorithm:"aes-256-gcm",keyVersion:"v1",initializationVector:Buffer.alloc(12),authenticationTag:Buffer.alloc(16),ciphertext:Buffer.from("x")},artifact:{signature:`sig-${executionId}`,signedTransactionDigest:"a".repeat(64),cluster:"solana-devnet",mint:"mint",rawAmount:"1",destination:"destination",sourceTokenAccount:"source",decimals:6,recentBlockhash:"blockhash",lastValidBlockHeight:"10",signerKeyId:"key",signerKeyVersion:"1",signerPublicKey:"public",policyHash:"b".repeat(64),submissionProviderId:"submit",reconciliationProviderId:"reconcile"},preparedAt:NOW,...(["SUBMISSION_COMMITTED_RECONCILE_ONLY","ACCEPTED_PENDING","UNKNOWN_RECONCILIATION_REQUIRED","SETTLED","FAILED"].includes(state)?{committedAt:NOW}:{})};}
function record(id:string,options:{state?:PersistedDevnetPreparation["state"];mode?:"mock_beta"|"devnet_validation";status?:DevnetRecoveryRecord["executionStatus"]}={}):DevnetRecoveryRecord{return{executionId:id,paymentIntentId:INTENT,actorSubject:ACTOR,providerIdempotencyKey:`key-${id}`,executionMode:options.mode??"devnet_validation",selectedRail:options.mode==="mock_beta"?"mock":"solana",settlementNetwork:options.mode==="mock_beta"?"simulated":"solana-devnet",executionStatus:options.status??"READY",...(options.state?{preparation:preparation(id,options.state)}:{})};}

test("candidate rules isolate initial/expired Devnet preparation and reconciliation without a submission kind",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01"));repo.add(record("03",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));repo.add(record("04",{state:"ACCEPTED_PENDING"}));repo.add(record("05",{state:"UNKNOWN_RECONCILIATION_REQUIRED"}));repo.add(record("06",{state:"SETTLED",status:"SETTLED"}));repo.add(record("07",{state:"FAILED",status:"FAILED"}));repo.add(record("08",{mode:"mock_beta"}));assert.equal((await repo.claimPreparation("one",NOW,"2026-08-13T12:01:00.000Z","10"))?.executionId,"01");assert.equal((await repo.claimReconciliation("two",NOW,"2026-08-13T12:01:00.000Z"))?.executionId,"03");const prepared=new InMemoryDevnetRecoveryRepository();prepared.add(record("02",{state:"PREPARED_NOT_CONTACTED"}));assert.equal(await prepared.claimPreparation("valid",NOW,"2026-08-13T12:01:00.000Z","10"),undefined);assert.equal((await prepared.claimPreparation("expired",NOW,"2026-08-13T12:01:00.000Z","11"))?.executionId,"02");assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter(name=>/submi/i.test(name)),[]);});

test("lease exclusivity and expiry reclaim only operational work",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));assert(await repo.claimReconciliation("one",NOW,"2026-08-13T12:00:01.000Z"));assert.equal(await repo.claimReconciliation("two",NOW,"2026-08-13T12:00:02.000Z"),undefined);const reclaimed=await repo.claimReconciliation("two","2026-08-13T12:00:01.000Z","2026-08-13T12:00:02.000Z");assert.equal(reclaimed?.preparation?.state,"SUBMISSION_COMMITTED_RECONCILE_ONLY");assert.equal(await repo.claimPreparation("three","2026-08-13T12:00:01.000Z","2026-08-13T12:00:02.000Z","999"),undefined);});

test("exact-execution reconciliation claim is exclusive and never selects a different execution",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));repo.add(record("02",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));const[a,b]=await Promise.all([repo.claimReconciliationExecution("02","one",NOW,"2026-08-13T12:00:01.000Z"),repo.claimReconciliationExecution("02","two",NOW,"2026-08-13T12:00:01.000Z")]);assert.equal([a,b].filter(Boolean).length,1);assert.equal((a??b)?.executionId,"02");assert.equal(await repo.claimReconciliationExecution("missing","three",NOW,"2026-08-13T12:00:01.000Z"),undefined);});

test("lease renewal and release are fenced by owner and original claim",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));const first=await repo.claimReconciliation("one",NOW,"2026-08-13T12:00:01.000Z");assert(first?.recoveryLease);assert.equal(await repo.renew("01","RECONCILIATION","one",first.recoveryLease.claimedAt,"2026-08-13T12:00:00.500Z","2026-08-13T12:00:02.000Z"),true);assert.equal(await repo.claimReconciliation("two","2026-08-13T12:00:01.000Z","2026-08-13T12:00:03.000Z"),undefined);const second=await repo.claimReconciliation("two","2026-08-13T12:00:02.000Z","2026-08-13T12:00:03.000Z");assert(second?.recoveryLease);assert.equal(await repo.renew("01","RECONCILIATION","one",first.recoveryLease.claimedAt,"2026-08-13T12:00:02.000Z","2026-08-13T12:00:04.000Z"),false);await repo.release("01","RECONCILIATION","one",first.recoveryLease.claimedAt);assert.equal(await repo.renew("01","RECONCILIATION","two",second.recoveryLease.claimedAt,"2026-08-13T12:00:02.500Z","2026-08-13T12:00:04.000Z"),true);assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter(name=>/submi/i.test(name)),[]);});

test("worker supplies a renewable reconciliation fence",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));let renewed=false;const worker=new DevnetRecoveryWorker(repo,{async currentBlockHeight(){return"10";},async prepare(){return false;},async reconcile(_candidate,lease){renewed=await lease.renew();return true;}} ,"worker",{reconciliationEnabled:true},advancingClock());assert.equal(await worker.iterate(),true);assert.equal(renewed,true);});

test("worker gates phases independently and reconciliation performed reports work",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01"));repo.add(record("02",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));let prepared=0,reconciled=0,submitted=0;const handlers={async currentBlockHeight(){return"10";},async prepare(){prepared++;return true;},async reconcile(){reconciled++;return false;}};const off=new DevnetRecoveryWorker(repo,handlers,"off",{},advancingClock());assert.equal(await off.iterate(),false);const reconciliationOnly=new DevnetRecoveryWorker(repo,handlers,"reconcile",{reconciliationEnabled:true},advancingClock());assert.equal(await reconciliationOnly.iterate(),true);assert.equal(reconciled,1);assert.equal(prepared,0);assert.equal(submitted,0);assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(reconciliationOnly)).filter(name=>/submi/i.test(name)),[]);});

test("idle, failure, recovery, and heartbeat stay observable without exposing identifiers",async()=>{const repo=new InMemoryDevnetRecoveryRepository(),events:unknown[]=[];repo.add(record("sensitive-execution",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));let fail=true,calls=0;const worker=new DevnetRecoveryWorker(repo,{async currentBlockHeight(){return"10";},async prepare(){return false;},async reconcile(){calls++;if(fail){fail=false;throw new Error(`secret ${ACTOR} sensitive-execution`);}return true;}},"worker",{reconciliationEnabled:true},advancingClock(),30_000,event=>events.push(event));await assert.rejects(()=>worker.iterate(),/secret/);assert.equal(await worker.iterate(),true);assert.equal(calls,2);assert.deepEqual((events as Array<{event:string;outcome:string}>).filter(value=>value.event==="iteration").map(value=>value.outcome),["failure","work"]);const encoded=JSON.stringify(events);assert.doesNotMatch(encoded,/account:owner|sensitive-execution|secret/);assert.match(encoded,/heartbeat/);});

test("observer and backlog inspection failures cannot stop recovery",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));const worker=new DevnetRecoveryWorker(repo,{async currentBlockHeight(){return"10";},async prepare(){return false;},async reconcile(){return true;}},"worker",{reconciliationEnabled:true},advancingClock(),30_000,()=>{throw new Error("observer unavailable");});assert.equal(await worker.iterate(),true);repo.inspectUnresolvedBacklog=async()=>{throw new Error("backlog unavailable");};assert.equal(await worker.iterate(),true);});

test("unresolved backlog aggregate includes old commitments and excludes terminal executions",async()=>{const repo=new InMemoryDevnetRecoveryRepository(),later="2026-08-13T12:10:00.000Z";repo.add(record("01",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));repo.add(record("02",{state:"SETTLED",status:"SETTLED"}));repo.add(record("03",{state:"FAILED",status:"FAILED"}));const backlog=await repo.inspectUnresolvedBacklog(later);assert.equal(backlog.unresolvedCount,1);assert.equal(backlog.oldestCommittedAt,NOW);assert.equal(backlog.oldestUnresolvedAgeMs,600_000);});

test("long-lived UNKNOWN is intentional beta state and backlog age cannot terminalize or authorize submission",async()=>{const repo=new InMemoryDevnetRecoveryRepository(),later="2027-08-13T12:00:00.000Z";repo.add(record("unknown",{state:"UNKNOWN_RECONCILIATION_REQUIRED"}));const backlog=await repo.inspectUnresolvedBacklog(later),candidate=await repo.claimReconciliation("reconcile-only",later,"2027-08-13T12:01:00.000Z");assert.equal(backlog.unresolvedCount,1);assert(backlog.oldestUnresolvedAgeMs!>31_000_000_000);assert.equal(candidate?.preparation?.state,"UNKNOWN_RECONCILIATION_REQUIRED");assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter(name=>/submi|terminal/i.test(name)),[]);});

test("concurrent workers cannot process one item and shutdown gates new claims",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01"));let entered=0,release!:()=>void;const handlers={async currentBlockHeight(){return"10";},prepare:async()=>{entered++;await new Promise<void>(resolve=>{release=resolve;});return true;},reconcile:async()=>false},a=new DevnetRecoveryWorker(repo,handlers,"a",{preparationEnabled:true},advancingClock()),b=new DevnetRecoveryWorker(repo,handlers,"b",{preparationEnabled:true},advancingClock());const active=a.iterate();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(await b.iterate(),false);a.stop();release();assert.equal(await active,true);assert.equal(await a.iterate(),false);assert.equal(entered,1);});

test("active preparation drains and shutdown prevents starting reconciliation",async()=>{const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01"));repo.add(record("02",{state:"SUBMISSION_COMMITTED_RECONCILE_ONLY"}));let release!:()=>void,reconciled=0;const worker=new DevnetRecoveryWorker(repo,{async currentBlockHeight(){return"10";},prepare:()=>new Promise<boolean>(resolve=>{release=()=>resolve(true);}),async reconcile(){reconciled++;return true;}},"worker",{preparationEnabled:true,reconciliationEnabled:true},advancingClock());const active=worker.iterate();await new Promise<void>(resolve=>setImmediate(resolve));worker.stop();release();assert.equal(await active,true);assert.equal(reconciled,0);});


test("UNKNOWN cannot monopolize reconciliation and remains eligible after bounded revisits",async()=>{
  const repo=new InMemoryDevnetRecoveryRepository();
  repo.add(record("01",{state:"UNKNOWN_RECONCILIATION_REQUIRED",status:"UNKNOWN"}));
  repo.add(record("02",{state:"ACCEPTED_PENDING",status:"PROCESSING"}));
  const visited:string[]=[];
  for(let tick=0;tick<4;tick++){
    const now=new Date(Date.parse(NOW)+tick*1_000).toISOString();
    const candidate=await repo.claimReconciliation("worker",now,new Date(Date.parse(now)+30_000).toISOString());
    assert(candidate?.recoveryLease);visited.push(candidate.executionId);
    await repo.release(candidate.executionId,"RECONCILIATION","worker",candidate.recoveryLease.claimedAt);
    assert.equal(await repo.renew(candidate.executionId,"RECONCILIATION","worker",candidate.recoveryLease.claimedAt,now,new Date(Date.parse(now)+30_000).toISOString()),false);
  }
  assert.deepEqual(visited,["01","02","01","02"]);
  const unknown=await repo.claimReconciliation("later","2027-08-13T12:00:00.000Z","2027-08-13T12:01:00.000Z");
  assert.equal(unknown?.preparation?.state,"UNKNOWN_RECONCILIATION_REQUIRED");
});

test("reconciliation cooldown survives release while concurrent claims remain exclusive",async()=>{
  const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"UNKNOWN_RECONCILIATION_REQUIRED"}));
  const first=await repo.claimReconciliation("first",NOW,"2026-08-13T12:01:00.000Z");assert(first?.recoveryLease);
  await repo.release("01","RECONCILIATION","first",first.recoveryLease.claimedAt);
  assert.equal(await repo.claimReconciliation("early",NOW,"2026-08-13T12:01:00.000Z"),undefined);
  const[a,b]=await Promise.all([repo.claimReconciliation("a","2026-08-13T12:00:01.000Z","2026-08-13T12:01:00.000Z"),repo.claimReconciliation("b","2026-08-13T12:00:01.000Z","2026-08-13T12:01:00.000Z")]);
  assert.equal([a,b].filter(Boolean).length,1);
});

for(const failure of ["block-height","preparation"] as const)test(`${failure} failure does not suppress reconciliation`,async()=>{
  const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01"));repo.add(record("02",{state:"ACCEPTED_PENDING"}));
  const events:Array<{event:string;outcome:string;phase:string}>=[];let reconciled=0;
  const worker=new DevnetRecoveryWorker(repo,{
    async currentBlockHeight(){if(failure==="block-height")throw new Error("preparation unavailable");return"10";},
    async prepare(){throw new Error("preparation unavailable");},
    async reconcile(candidate,lease){assert.equal(candidate.executionId,"02");assert(await lease.renew());reconciled++;return true;},
  },"worker",{preparationEnabled:true,reconciliationEnabled:true},advancingClock(),30_000,event=>events.push(event));
  await assert.rejects(()=>worker.iterate(),/preparation unavailable/);
  assert.equal(reconciled,1);
  assert(events.some(event=>event.outcome==="failure"&&event.phase==="preparation"));
  assert(events.some(event=>event.event==="heartbeat"&&event.outcome==="failure"));
});


test("an expired lease can be reclaimed even before the normal revisit deadline",async()=>{
  const repo=new InMemoryDevnetRecoveryRepository();repo.add(record("01",{state:"UNKNOWN_RECONCILIATION_REQUIRED"}));
  const first=await repo.claimReconciliation("old",NOW,"2026-08-13T12:00:00.040Z");assert(first?.recoveryLease);
  assert.equal(await repo.claimReconciliation("early","2026-08-13T12:00:00.039Z","2026-08-13T12:01:00.000Z"),undefined);
  const second=await repo.claimReconciliation("new","2026-08-13T12:00:00.041Z","2026-08-13T12:01:00.000Z");assert(second?.recoveryLease);
  await repo.release("01","RECONCILIATION","old",first.recoveryLease.claimedAt);
  assert(await repo.renew("01","RECONCILIATION","new",second.recoveryLease.claimedAt,"2026-08-13T12:00:00.042Z","2026-08-13T12:01:00.000Z"));
});
