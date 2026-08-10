import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";

import express from "express";
import { Pool } from "pg";

import { requestContext } from "../src/middleware/requestContext";
import {
  DB_OPERATION_FAMILIES, classifyDatabaseError, emitReliabilityLog, instrumentPostgresPool,
  normalizeRouteFamily, observeDatabaseFailure, observeTransaction, poolSnapshot, processInstance,
  reliabilityMetricsSnapshot, resetReliabilityMetricsForTest, runWithReliabilityContext,
  setReliabilityLogSinkForTest,
} from "../src/observability/reliabilityObservability";

type Captured = { level: string; event: string; fields: Record<string, unknown> };
const captured: Captured[] = [];

afterEach(async () => { captured.length=0;setReliabilityLogSinkForTest();resetReliabilityMetricsForTest(); });

describe("reliability observability", () => {
  it("reports bounded pool state and a safe stable process identity", () => {
    assert.deepEqual(poolSnapshot({totalCount:7,idleCount:2,waitingCount:3}),{totalCount:7,idleCount:2,waitingCount:3});
    assert.match(processInstance.id,/^(?:railway:[A-Za-z0-9._:-]{1,64}|process:[0-9a-f]{8})$/);
    assert.ok(["railway-replica","random-process"].includes(processInstance.source));
  });

  it("classifies stable PostgreSQL codes and the two historical pg-pool timeout strings", () => {
    assert.equal(classifyDatabaseError(new Error("Connection terminated due to connection timeout")),"DB_CONNECT_TIMEOUT");
    assert.equal(classifyDatabaseError(new Error("timeout exceeded when trying to connect")),"DB_POOL_ACQUIRE_TIMEOUT");
    assert.equal(classifyDatabaseError(Object.assign(new Error("cancelled"),{code:"57014"})),"DB_QUERY_TIMEOUT");
    assert.equal(classifyDatabaseError(Object.assign(new Error("lock"),{code:"55P03"})),"DB_LOCK_TIMEOUT");
    assert.equal(classifyDatabaseError(Object.assign(new Error("serialization"),{code:"40001"})),"DB_SERIALIZATION_FAILURE");
    assert.equal(classifyDatabaseError(Object.assign(new Error("deadlock"),{code:"40P01"})),"DB_DEADLOCK");
    assert.equal(classifyDatabaseError(Object.assign(new Error("reset"),{code:"ECONNRESET"})),"DB_CONNECTION_RESET");
  });

  it("keeps operation families low-cardinality and normalizes dynamic route identifiers", () => {
    assert.equal(new Set(DB_OPERATION_FAMILIES).size,DB_OPERATION_FAMILIES.length);
    assert.ok(DB_OPERATION_FAMILIES.length<32);
    assert.equal(normalizeRouteFamily("/api/payment-intents/00000000-0000-4000-8000-000000000001/execution?x=1"),"/api/payment-intents/:intentId/execution");
    assert.equal(normalizeRouteFamily("/api/payment-intents/private-value/receipt"),"/api/payment-intents/:intentId/receipt");
    assert.equal(normalizeRouteFamily("/api/recipients/00000000-0000-4000-8000-000000000001"),"/api/recipients/:accountId");
    assert.equal(normalizeRouteFamily("/api/payment-requests/00000000-0000-4000-8000-000000000001/accept"),"/api/payment-requests/:requestId/accept");
  });

  it("records successful acquisition timing and distinguishes a saturated checkout timeout", async () => {
    useCapture();
    const pool=instrumentPostgresPool(new Pool({max:1,connectionTimeoutMillis:25,Client:FakeClient as never}));
    const first=await runWithReliabilityContext({requestId:"request-observe-0001",routeFamily:"/api/payment-intents/:intentId",method:"GET",dbOperation:"PAYMENT_INTENT_READ"},()=>pool.connect());
    const keepAlive=setInterval(()=>undefined,10);
    try{await assert.rejects(()=>runWithReliabilityContext({requestId:"request-observe-0002",routeFamily:"/api/payment-intents/:intentId",method:"GET",dbOperation:"PAYMENT_INTENT_READ"},()=>pool.connect()),/timeout exceeded when trying to connect/)}finally{clearInterval(keepAlive)}
    const failure=captured.find(entry=>entry.fields.dbFailure==="DB_POOL_ACQUIRE_TIMEOUT");
    assert.ok(failure);assert.equal(failure.fields.totalCount,1);assert.equal(failure.fields.idleCount,0);
    assert.equal(failure.fields.dbOperation,"PAYMENT_INTENT_READ");assert.equal(failure.fields.requestId,"request-observe-0002");
    assert.equal(failure.fields.processId,processInstance.id);assert.equal(typeof failure.fields.waitingCount,"number");
    assert.match(JSON.stringify(reliabilityMetricsSnapshot()),/db\.pool\.acquisition/);
    first.release(new Error("test cleanup"));await pool.end();
  });

  it("captures physical failure and pool error categories without sensitive error material", async () => {
    useCapture();const fake={totalCount:0,idleCount:0,waitingCount:0};
    const unsafe=Object.assign(new Error("Connection terminated due to connection timeout"),{email:"email@example.com",token:"token-secret",subject:"auth0|subject",accountId:"00000000-0000-4000-8000-000000000001",parameters:["private"]});
    runWithReliabilityContext({requestId:"request-observe-0003",routeFamily:"/api/account",method:"GET",dbOperation:"ACCOUNT_RESOLUTION"},()=>observeDatabaseFailure(unsafe,fake,"pool_error"));
    const encoded=JSON.stringify(captured);
    assert.match(encoded,/DB_CONNECT_TIMEOUT/);assert.doesNotMatch(encoded,/email@example|token-secret|auth0\|subject|00000000|private/);
  });

  it("records transaction duration for commit and rollback without changing outcomes", async () => {
    const fake={totalCount:1,idleCount:0,waitingCount:0};
    assert.equal(await runWithReliabilityContext({dbOperation:"PAYMENT_INTENT_CONFIRM"},()=>observeTransaction(fake,async()=>"committed")),"committed");
    await assert.rejects(()=>runWithReliabilityContext({dbOperation:"PAYMENT_INTENT_CONFIRM"},()=>observeTransaction(fake,async()=>{throw new Error("rollback")})),/rollback/);
    const metrics=JSON.stringify(reliabilityMetricsSnapshot());assert.match(metrics,/db\.transaction\.duration/);assert.match(metrics,/outcome=commit/);assert.match(metrics,/outcome=rollback/);
  });

  it("preserves request IDs and cannot fail a request when instrumentation throws", async () => {
    setReliabilityLogSinkForTest(()=>{throw new Error("sink unavailable")});
    assert.doesNotThrow(()=>emitReliabilityLog("info","test"));
    const app=express();app.use(requestContext);app.get("/api/account",(_req,res)=>res.json({ok:true}));
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    try{const address=server.address();assert.ok(address&&typeof address==="object");const response=await fetch(`http://127.0.0.1:${address.port}/api/account`,{headers:{"X-Request-Id":"request-preserved-0001"}});assert.equal(response.status,200);assert.equal(response.headers.get("x-request-id"),"request-preserved-0001");}
    finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  });

  it("observes pool error lifecycle events", async () => {
    useCapture();const pool=instrumentPostgresPool(new Pool({max:1,Client:FakeClient as never}));
    pool.emit("error",Object.assign(new Error("connection reset"),{code:"ECONNRESET"}),{} as never);
    assert.ok(captured.some(entry=>entry.event==="database_operation_failed"&&entry.fields.dbFailure==="DB_CONNECTION_RESET"));
    assert.match(JSON.stringify(reliabilityMetricsSnapshot()),/event=error/);await pool.end();
  });
});

function useCapture(){setReliabilityLogSinkForTest((level,event,fields)=>captured.push({level,event,fields:fields as Record<string,unknown>}))}
class FakeClient extends EventEmitter{
  _queryable=true;_ending=false;connection={stream:{destroy:()=>undefined}};release!:()=>void;
  connect(callback:(error?:Error)=>void){queueMicrotask(()=>callback())}
  query(_text:unknown,_values:unknown,callback?:(error:null,result:{rows:never[]})=>void){const result={rows:[] as never[]};if(typeof _values==="function")queueMicrotask(()=>void(_values as typeof callback)?.(null,result));else if(callback)queueMicrotask(()=>callback(null,result));else return Promise.resolve(result)}
  end(callback?:()=>void){queueMicrotask(()=>callback?.())}ref(){}unref(){}
}
