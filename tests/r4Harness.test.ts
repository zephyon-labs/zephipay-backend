import assert from "node:assert/strict";
import { test } from "node:test";
import { configureLocalHarnessAuth, localHarnessAuth, resetLocalHarnessAuthForTest } from "../src/auth/localHarnessAuth";
import { verifyEconomicInvariants } from "../scripts/r4/invariants";
import { certificationReport } from "../scripts/r4/report";
import { controlDisposableDatabase, signalGracefulShutdown, transientFailure } from "../scripts/r4/faults";

test("deterministic auth cannot be configured by production composition",()=>{const prior=process.env.NODE_ENV;process.env.NODE_ENV="production";try{assert.throws(()=>configureLocalHarnessAuth({publicKey:{} as any}),/NODE_ENV=test/);assert.equal(localHarnessAuth(),undefined);}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;}});

test("deterministic auth is constructor-only, test-only, and single assignment",()=>{const prior=process.env.NODE_ENV;process.env.NODE_ENV="test";try{resetLocalHarnessAuthForTest();configureLocalHarnessAuth({publicKey:{kid:"r4"} as any});assert.equal((localHarnessAuth()?.publicKey as any).kid,"r4");assert.throws(()=>configureLocalHarnessAuth({publicKey:{} as any}),/already configured/);resetLocalHarnessAuthForTest();}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;}});

test("economic invariant checker passes clean state and reports intentional corruption",async()=>{const clean={query:async(sql:string)=>({rows:[{n:sql.includes("status NOT IN")?0:0}]})} as any;assert.equal((await verifyEconomicInvariants(clean,{crossAccountReadsDenied:true})).passed,true);let call=0;const corrupt={query:async()=>({rows:[{n:++call===1?2:0}]})} as any;const report=await verifyEconomicInvariants(corrupt,{crossAccountReadsDenied:false});assert.equal(report.passed,false);assert.deepEqual(report.violations.map(v=>v.name),["duplicate_actor_idempotency","cross_account_read_exposed"]);});

test("test-only transient decorator fails deterministically and then delegates",async()=>{const decorated=transientFailure({read:async()=>"ok"},"read",1);await assert.rejects(()=>decorated.read(),/deterministic transient/);assert.equal(await decorated.read(),"ok");});

test("destructive database faults are restricted to explicitly disposable R4 containers",async()=>{await assert.rejects(()=>controlDisposableDatabase("production-postgres","stop"),/R4 disposable/);let signal="";signalGracefulShutdown({kill:(value?:string|number)=>{signal=String(value);return true;}} as any);assert.equal(signal,"SIGTERM");});

test("certification report is explicitly limited to Tier 0",()=>{const text=certificationReport({commit:"abc",nodeVersion:"v1",k6Version:"v1",postgresVersion:"16",scenario:"stage0",seed:"one",vus:1,arrivalRate:0,duration:"functional",pool:{}},{requests:3},{passed:true,violations:[]});assert.match(text,/TIER 0/);assert.match(text,/No Tier 1\+ capacity claim/);});
