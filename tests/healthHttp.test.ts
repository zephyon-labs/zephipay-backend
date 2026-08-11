import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { after, before, test } from "node:test";
import { ReadinessService } from "../src/health/readiness";
import { createHealthRouter } from "../src/routes/health";

let server:http.Server,base="";before(async()=>{const app=express(),readiness=new ReadinessService({query:async()=>{throw new Error("database unavailable");},idleCount:1,totalCount:1,options:{max:10}} as any);app.use("/health",createHealthRouter(readiness));server=app.listen(0);await new Promise<void>(resolve=>server.once("listening",resolve));const address=server.address();assert.ok(address&&typeof address==="object");base=`http://127.0.0.1:${address.port}`;});after(async()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
test("liveness is independent from database readiness",async()=>{const live=await fetch(`${base}/health/live`),ready=await fetch(`${base}/health/ready`);assert.equal(live.status,200);assert.deepEqual(await live.json(),{ok:true,status:"alive"});assert.equal(ready.status,503);assert.deepEqual(await ready.json(),{ok:false,status:"unavailable"});assert.equal(live.headers.get("cache-control"),"no-store");});
