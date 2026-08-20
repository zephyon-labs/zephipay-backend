import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  GROWTH_PROJECTION_BATCH_LIMIT,
  GrowthZpProjectionCoordinator,
  GrowthZpProjectionWorker,
  ZP_ACCOUNT_BATCH_LIMIT,
  ZP_EVENT_BATCH_LIMIT,
} from "../src/growth/growthZpProjectionWorker";

type Scheduled = Readonly<{
  callback: () => void;
  delay: number;
}> & { cancelled: boolean };

function projectionResult(accountId: string, processedEvents = 1) {
  return Object.freeze({
    accountId,
    processedEvents,
    priorLastGrowthEventId: 0n,
    lastGrowthEventId: BigInt(processedEvents),
    totalPoints: 10n,
    sentCount: 1n,
    receivedCount: 0n,
  });
}

function growthResult() {
  return Object.freeze({
    paymentIntentId: "internal-payment",
    receiptId: "internal-receipt",
    senderCreated: true,
    recipientCreated: false,
    synthetic: false,
  });
}

describe("downstream Growth/ZP projection coordinator", () => {
  it("keeps the two projection switches independent", async () => {
    for (const configuration of [
      { growthEnabled: false, zpEnabled: false },
      { growthEnabled: true, zpEnabled: false },
      { growthEnabled: false, zpEnabled: true },
      { growthEnabled: true, zpEnabled: true },
    ]) {
      let growthCalls = 0;
      let discoveryCalls = 0;
      let zpCalls = 0;
      const coordinator = new GrowthZpProjectionCoordinator(
        { async projectPending() { growthCalls += 1; return [growthResult()]; } },
        {
          async listPendingAccounts() { discoveryCalls += 1; return ["account"]; },
          async projectAccount(accountId) { zpCalls += 1; return projectionResult(accountId); },
        },
        configuration,
      );

      await coordinator.runOnce();
      assert.equal(growthCalls, configuration.growthEnabled ? 1 : 0);
      assert.equal(discoveryCalls, configuration.zpEnabled ? 1 : 0);
      assert.equal(zpCalls, configuration.zpEnabled ? 1 : 0);
    }
  });

  it("runs Growth first and independently discovers and projects stale ZP", async () => {
    const calls: string[] = [];
    const coordinator = new GrowthZpProjectionCoordinator(
      {
        async projectPending(limit) {
          assert.equal(limit, GROWTH_PROJECTION_BATCH_LIMIT);
          calls.push("growth");
          return [growthResult()];
        },
      },
      {
        async listPendingAccounts(limit) {
          assert.equal(limit, ZP_ACCOUNT_BATCH_LIMIT);
          calls.push("discover");
          return ["account-a", "account-b"];
        },
        async projectAccount(accountId, limit) {
          assert.equal(limit, ZP_EVENT_BATCH_LIMIT);
          calls.push(`project:${accountId}`);
          return projectionResult(accountId);
        },
      },
      { growthEnabled: true, zpEnabled: true },
    );

    const outcome = await coordinator.runOnce();

    assert.deepEqual(calls, [
      "growth",
      "discover",
      "project:account-a",
      "project:account-b",
    ]);
    assert.equal(outcome.growthProjectedReceipts, 1);
    assert.equal(outcome.zpDiscoveredAccounts, 2);
    assert.equal(outcome.zpProjectedAccounts, 2);
    assert.equal(outcome.zpProcessedEvents, 2);
    assert.equal(outcome.zpFailedAccounts, 0);
  });

  it("discovers ZP independently when Growth is idle", async () => {
    let projected = 0;
    const coordinator = new GrowthZpProjectionCoordinator(
      { async projectPending() { return []; } },
      {
        async listPendingAccounts() { return ["stale-account"]; },
        async projectAccount(accountId) {
          projected += 1;
          return projectionResult(accountId);
        },
      },
      { growthEnabled: true, zpEnabled: true },
    );

    const outcome = await coordinator.runOnce();
    assert.equal(projected, 1);
    assert.equal(outcome.growthProjectedReceipts, 0);
    assert.equal(outcome.zpProjectedAccounts, 1);
  });

  it("repairs stale ZP even when the Growth sweep fails", async () => {
    const coordinator = new GrowthZpProjectionCoordinator(
      { async projectPending() { throw new Error("private growth failure"); } },
      {
        async listPendingAccounts() { return ["stale-account"]; },
        async projectAccount(accountId) { return projectionResult(accountId); },
      },
      { growthEnabled: true, zpEnabled: true },
    );

    const outcome = await coordinator.runOnce();
    assert.equal(outcome.growthFailed, true);
    assert.equal(outcome.zpProjectedAccounts, 1);
  });

  it("isolates one account failure and attempts remaining candidates", async () => {
    const attempted: string[] = [];
    const coordinator = new GrowthZpProjectionCoordinator(
      { async projectPending() { return []; } },
      {
        async listPendingAccounts() {
          return ["failing-account", "healthy-account"];
        },
        async projectAccount(accountId) {
          attempted.push(accountId);
          if (accountId === "failing-account") {
            throw new Error("private account failure");
          }
          return projectionResult(accountId);
        },
      },
      { growthEnabled: false, zpEnabled: true },
    );

    const outcome = await coordinator.runOnce();
    assert.deepEqual(attempted, ["failing-account", "healthy-account"]);
    assert.equal(outcome.zpProjectedAccounts, 1);
    assert.equal(outcome.zpFailedAccounts, 1);
    assert.equal("accountIds" in outcome, false);
  });

  it("retries and repairs durable Growth after a temporary ZP failure", async () => {
    let attempts = 0;
    const coordinator = new GrowthZpProjectionCoordinator(
      { async projectPending() { return []; } },
      {
        async listPendingAccounts() { return ["stale-account"]; },
        async projectAccount(accountId) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary private failure");
          }
          return projectionResult(accountId);
        },
      },
      { growthEnabled: true, zpEnabled: true },
    );

    const failed = await coordinator.runOnce();
    const repaired = await coordinator.runOnce();

    assert.equal(failed.zpFailedAccounts, 1);
    assert.equal(failed.zpProjectedAccounts, 0);
    assert.equal(repaired.zpFailedAccounts, 0);
    assert.equal(repaired.zpProjectedAccounts, 1);
    assert.equal(attempts, 2);
  });

  it("returns a bounded disabled outcome without invoking dependencies", async () => {
    let calls = 0;
    const coordinator = new GrowthZpProjectionCoordinator(
      { async projectPending() { calls += 1; return []; } },
      {
        async listPendingAccounts() { calls += 1; return []; },
        async projectAccount(accountId) { calls += 1; return projectionResult(accountId); },
      },
      { growthEnabled: false, zpEnabled: false },
    );

    const outcome = await coordinator.runOnce();
    assert.equal(calls, 0);
    assert.equal(outcome.growthEnabled, false);
    assert.equal(outcome.zpEnabled, false);
  });
});

describe("downstream Growth/ZP adaptive worker", () => {
  function harness(outcomes: Array<"idle" | "work" | "failure" | "deferred">) {
    const scheduled: Scheduled[] = [];
    const observed: Array<{ delay: number; outcome: string }> = [];
    let release: (() => void) | undefined;
    const coordinator = {
      async runOnce() {
        const next = outcomes.shift() ?? "idle";
        if (next === "deferred") {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return Object.freeze({
          growthEnabled: true,
          growthProjectedReceipts: next === "work" ? 1 : 0,
          growthFailed: next === "failure",
          zpEnabled: true,
          zpDiscoveredAccounts: 0,
          zpProjectedAccounts: 0,
          zpProcessedEvents: 0,
          zpFailedAccounts: 0,
          zpDiscoveryFailed: false,
          durationMs: 1,
        });
      },
    } as GrowthZpProjectionCoordinator;
    const worker = new GrowthZpProjectionWorker(
      coordinator,
      { growthEnabled: true, zpEnabled: true },
      () => undefined,
      (delay, outcome) => observed.push({ delay, outcome }),
      ((callback: () => void, delay: number) => {
        const item = { callback, delay, cancelled: false };
        scheduled.push(item);
        return item as unknown as ReturnType<typeof setTimeout>;
      }),
      ((item: ReturnType<typeof setTimeout>) => {
        (item as unknown as Scheduled).cancelled = true;
      }),
    );
    return { worker, scheduled, observed, release: () => release?.() };
  }

  async function fire(item: Scheduled) {
    item.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it("starts no timer when both phases are disabled", () => {
    const scheduled: Scheduled[] = [];
    const coordinator = { runOnce: async () => { throw new Error("must not run"); } } as GrowthZpProjectionCoordinator;
    const worker = new GrowthZpProjectionWorker(
      coordinator,
      { growthEnabled: false, zpEnabled: false },
      undefined,
      undefined,
      ((callback: () => void, delay: number) => {
        const item = { callback, delay, cancelled: false };
        scheduled.push(item);
        return item as unknown as ReturnType<typeof setTimeout>;
      }),
    );
    worker.start();
    assert.equal(scheduled.length, 0);
  });

  it("backs off while idle and resets cadence after work", async () => {
    const h = harness(["idle", "work"]);
    h.worker.start();
    assert.equal(h.scheduled[0].delay, 1_000);
    await fire(h.scheduled[0]);
    await fire(h.scheduled[1]);
    assert.deepEqual(h.observed, [
      { delay: 2_000, outcome: "idle" },
      { delay: 1_000, outcome: "work" },
    ]);
    h.worker.stop();
  });

  it("backs off after failure without a tight loop", async () => {
    const h = harness(["failure", "failure"]);
    h.worker.start();
    await fire(h.scheduled[0]);
    await fire(h.scheduled[1]);
    assert.deepEqual(h.observed, [
      { delay: 2_000, outcome: "failure" },
      { delay: 5_000, outcome: "failure" },
    ]);
    h.worker.stop();
  });

  it("stop prevents future work and stopAndDrain waits in-flight", async () => {
    const h = harness(["deferred"]);
    h.worker.start();
    h.scheduled[0].callback();
    let drained = false;
    const drain = h.worker.stopAndDrain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    h.release();
    await drain;
    assert.equal(h.scheduled.length, 1);

    const stopped = harness(["work"]);
    stopped.worker.start();
    stopped.worker.stop();
    assert.equal(stopped.scheduled[0].cancelled, true);
  });
});

describe("downstream Growth/ZP projection configuration", () => {
  function loadEnvironment(overrides: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        "import('./src/config/environment.ts').then((module) => { const environment = module.environment ?? module.default?.environment; console.log(JSON.stringify({growth:environment.growthProjectionEnabled,zp:environment.zpProjectionEnabled,payments:environment.paymentsEnabled})); })",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          ...overrides,
        },
      },
    );
  }

  it("defaults both projection capabilities off", () => {
    const result = loadEnvironment();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      growth: false,
      zp: false,
      payments: false,
    });
  });

  it("accepts explicit false and every PostgreSQL-backed enablement combination", () => {
    const cases = [
      ["false", "false", false, false],
      ["true", "false", true, false],
      ["false", "true", false, true],
      ["true", "true", true, true],
    ] as const;

    for (const [growth, zp, expectedGrowth, expectedZp] of cases) {
      const result = loadEnvironment({
        POSTGRES_ENABLED: "true",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/zephipay_test",
        GROWTH_PROJECTION_ENABLED: growth,
        ZP_PROJECTION_ENABLED: zp,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        growth: expectedGrowth,
        zp: expectedZp,
        payments: false,
      });
    }
  });

  it("fails closed for malformed values", () => {
    for (const key of ["GROWTH_PROJECTION_ENABLED", "ZP_PROJECTION_ENABLED"]) {
      const malformed = loadEnvironment({ [key]: "sometimes" });
      assert.notEqual(malformed.status, 0);
      assert.match(malformed.stderr, /Expected boolean environment value/);
    }
  });

  it("requires PostgreSQL independently for either projection capability", () => {
    for (const key of ["GROWTH_PROJECTION_ENABLED", "ZP_PROJECTION_ENABLED"]) {
      const withoutPostgres = loadEnvironment({ [key]: "true" });
      assert.notEqual(withoutPostgres.status, 0);
      assert.match(withoutPostgres.stderr, /requires POSTGRES_ENABLED=true/);
    }
  });
});
