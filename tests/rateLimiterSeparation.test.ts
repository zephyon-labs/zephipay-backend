import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import express from "express";

import { authenticatedReadRateLimiter, paymentMutationRateLimiter } from "../src/middleware/rateLimiter";
import { requestContext } from "../src/middleware/requestContext";
import { setReliabilityLogSinkForTest } from "../src/observability/reliabilityObservability";

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
const reliabilityLogs: Array<{event:string;fields:Record<string,unknown>}>=[];

before(async () => {
  setReliabilityLogSinkForTest((_level,event,fields)=>reliabilityLogs.push({event,fields:fields as Record<string,unknown>}));
  const app = express();
  app.use(requestContext, (req, res, next) => {
    res.locals.externalPrincipal = { issuer: "https://issuer.example/", providerSubject: String(req.header("x-test-principal")), scopes: [] };
    next();
  });
  app.get("/read", authenticatedReadRateLimiter, (_req, res) => res.json({ ok: true }));
  app.post("/mutate", paymentMutationRateLimiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

after(async () => {await closeServer?.();setReliabilityLogSinkForTest()});

describe("authenticated payment limiter separation", () => {
  it("does not let one principal consume another principal's mutation allowance", async () => {
    for (let index = 0; index < 5; index++) assert.equal((await request("/mutate", "POST", "principal-a")).status, 200);
    const limited = await request("/mutate", "POST", "principal-a");
    assert.equal(limited.status, 429);
    const body = await limited.json() as { requestId?: string };
    assert.equal(typeof body.requestId, "string");
    assert.ok(reliabilityLogs.some(entry=>entry.event==="http_request_completed"&&entry.fields.status===429&&entry.fields.limiterCategory==="payment-mutation"));
    assert.equal((await request("/mutate", "POST", "principal-b")).status, 200);
  });

  it("does not charge authoritative reads against mutation allowance", async () => {
    for (let index = 0; index < 20; index++) assert.equal((await request("/read", "GET", "principal-c")).status, 200);
    assert.equal((await request("/mutate", "POST", "principal-c")).status, 200);
  });
});

function request(path: string, method: string, principal: string) {
  return fetch(`${baseUrl}${path}`, { method, headers: { "X-Test-Principal": principal } });
}
