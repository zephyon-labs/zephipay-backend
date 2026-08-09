import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";

import { createOpenBetaActivityRouter } from "../src/routes/openBetaActivity";
import {
  OpenBetaActivityService,
  type OpenBetaActivityAggregate,
  type OpenBetaActivityRepository,
} from "../src/telemetry/openBetaActivity";

const NOW = new Date("2026-08-09T07:00:00.000Z");
const ZERO: OpenBetaActivityAggregate = Object.freeze({
  betaTesters: 0, paymentsCompleted: 0, mockUsdcAmountRaw: "0", durableReceipts: 0,
  executionsInitiated: 0, executionsSettled: 0,
});

describe("Open Beta activity service", () => {
  it("projects exact aggregate values and an honest null rate", async () => {
    const service = new OpenBetaActivityService(repository(ZERO), () => NOW);
    assert.deepEqual(await service.read(), {
      scope: "open_beta", rail: "mock", settlement: "simulated", generatedAt: NOW.toISOString(),
      betaTesters: 0, paymentsCompleted: 0,
      mockUsdcProcessed: { amountRaw: "0", decimals: 6 }, durableReceipts: 0,
      paymentCompletionRate: { completed: 0, initiated: 0, basisPoints: null },
    });
  });

  it("uses every initiated execution in the completion-rate denominator", async () => {
    const service = new OpenBetaActivityService(repository({ ...ZERO, executionsInitiated: 6, executionsSettled: 2 }), () => NOW);
    assert.deepEqual((await service.read()).paymentCompletionRate, { completed: 2, initiated: 6, basisPoints: 3333 });
  });

  it("caches successful snapshots for thirty seconds and never caches failures", async () => {
    let milliseconds = NOW.getTime(), calls = 0;
    const good = new OpenBetaActivityService({ aggregate: async () => { calls++; return ZERO; } }, () => new Date(milliseconds));
    await good.read(); milliseconds += 29_999; await good.read(); assert.equal(calls, 1);
    milliseconds += 1; await good.read(); assert.equal(calls, 2);

    let failures = 0;
    const bad = new OpenBetaActivityService({ aggregate: async () => { failures++; throw new Error("private database detail"); } }, () => NOW);
    await assert.rejects(() => bad.read()); await assert.rejects(() => bad.read()); assert.equal(failures, 2);
  });
});

describe("Open Beta activity HTTP projection", () => {
  let base = "", close: (() => Promise<void>) | undefined;
  let service: OpenBetaActivityService;
  before(async () => {
    service = new OpenBetaActivityService(repository({ ...ZERO, betaTesters: 2, paymentsCompleted: 3, mockUsdcAmountRaw: "900719925474099312345", durableReceipts: 3, executionsInitiated: 5, executionsSettled: 3 }), () => NOW);
    const app = express(); app.use("/api/telemetry", createOpenBetaActivityRouter(service));
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object"); base = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  after(async () => close?.());

  it("returns only the aggregate allowlist and public cache policy", async () => {
    const response = await fetch(`${base}/api/telemetry/open-beta`); const body = await response.json() as any;
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "public, max-age=30, stale-while-revalidate=120");
    assert.deepEqual(Object.keys(body).sort(), ["data", "ok"]);
    assert.deepEqual(Object.keys(body.data).sort(), ["betaTesters", "durableReceipts", "generatedAt", "mockUsdcProcessed", "paymentCompletionRate", "paymentsCompleted", "rail", "scope", "settlement"]);
    const serialized = JSON.stringify(body);
    for (const privateName of ["actorSubject", "accountId", "username", "recipient", "paymentIntentId", "executionId", "receiptId", "providerReference", "requestHash", "evidence", "requestId"]) assert.equal(serialized.includes(privateName), false);
  });

  it("returns a generic unavailable response without caching failures", async () => {
    const app = express(); app.use("/api/telemetry", createOpenBetaActivityRouter(new OpenBetaActivityService({ aggregate: async () => { throw new Error("password=secret"); } })));
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
    try { const response = await fetch(`http://127.0.0.1:${address.port}/api/telemetry/open-beta`); assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store"); assert.deepEqual(await response.json(), { ok: false, error: "Open Beta activity is temporarily unavailable." }); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});

function repository(value: OpenBetaActivityAggregate): OpenBetaActivityRepository {
  return { aggregate: async (epoch) => { assert.equal(epoch, "OPEN_BETA"); return value; } };
}
