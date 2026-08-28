import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";

import express, { type Express, type RequestHandler } from "express";

import { mountX402Surface } from "../src/x402/x402Surface";

const SVM_ADDRESS = "x402-test-svm-address";
const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server) continue;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

describe("x402 capability configuration", () => {
  it("defaults off and accepts strict explicit booleans without requiring SVM_ADDRESS while off", () => {
    for (const overrides of [{}, { X402_ENABLED: "false" }, { X402_ENABLED: "FALSE" }]) {
      const result = loadEnvironment(overrides);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { enabled: false, svmAddress: null });
    }

    for (const enabled of ["true", "TRUE"]) {
      const result = loadEnvironment({ X402_ENABLED: enabled, SVM_ADDRESS });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { enabled: true, svmAddress: SVM_ADDRESS });
    }
  });

  it("fails closed for malformed enablement and requires SVM_ADDRESS only when enabled", () => {
    for (const value of ["1", "yes", "on", "sometimes", ""]) {
      const result = loadEnvironment({ X402_ENABLED: value, SVM_ADDRESS });
      assert.notEqual(result.status, 0, value);
      assert.match(result.stderr, /Expected boolean environment value/);
    }

    const missingAddress = loadEnvironment({ X402_ENABLED: "true" });
    assert.notEqual(missingAddress.status, 0);
    assert.match(missingAddress.stderr, /SVM_ADDRESS is required when X402_ENABLED=true/);
  });
});

describe("x402 authority surface composition", () => {
  it("mounts nothing and constructs no registry or middleware when disabled", async () => {
    const app = canonicalTestApp();
    let middlewareConstructions = 0;
    let registryConstructions = 0;
    const mounted = mountX402Surface(app, { enabled: false }, {
      createMiddleware: () => {
        middlewareConstructions += 1;
        throw new Error("disabled x402 middleware construction");
      },
      createRegistry: () => {
        registryConstructions += 1;
        throw new Error("disabled x402 registry construction");
      },
    });

    assert.equal(mounted, false);
    assert.equal(middlewareConstructions, 0);
    assert.equal(registryConstructions, 0);

    const baseUrl = await listen(app);
    for (const path of x402Paths()) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 404, path);
    }

    assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/account/me`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/intent-1`)).status, 200);
    const canonicalReceipt = await fetch(`${baseUrl}/api/payment-intents/intent-1/receipt`);
    assert.equal(canonicalReceipt.status, 200);
    assert.deepEqual(await canonicalReceipt.json(), {
      ok: true,
      receipt: { receiptId: "receipt:canonical", source: "canonical-payment-intent" },
    });
  });

  it("preserves the existing experimental surface behind explicit enablement without facilitator contact", async () => {
    const app = canonicalTestApp();
    const constructedAddresses: string[] = [];
    const noPaymentTestMiddleware: RequestHandler = (_req, _res, next) => next();
    const mounted = mountX402Surface(app, { enabled: true, svmAddress: SVM_ADDRESS }, {
      createMiddleware: (address) => {
        constructedAddresses.push(address);
        return noPaymentTestMiddleware;
      },
    });

    assert.equal(mounted, true);
    assert.deepEqual(constructedAddresses, [SVM_ADDRESS]);
    const baseUrl = await listen(app);

    const agent = await fetch(`${baseUrl}/api/agent/costly-data`);
    assert.equal(agent.status, 200);
    const agentBody = await agent.json() as any;
    assert.equal(agentBody.payment, "x402-settled");
    assert.equal(agentBody.receiptMode, "x402-offchain-preview");
    assert.equal(agentBody.zephyonReceipt.payment.payTo, SVM_ADDRESS);
    assert.equal(agentBody.zephyonReceipt.ownership.owner, SVM_ADDRESS);

    const receiptId = String(agentBody.zephyonReceipt.localReceiptId);
    const verification = await fetch(`${baseUrl}/api/verify/${receiptId}`);
    assert.equal(verification.status, 200);
    assert.equal((await verification.json() as any).valid, true);

    const receipts = await fetch(`${baseUrl}/api/receipts`);
    assert.equal(receipts.status, 200);
    assert.equal((await receipts.json() as any).count, 1);

    const receipt = await fetch(`${baseUrl}/api/receipts/${receiptId}`);
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json() as any).receipt.localReceiptId, receiptId);

    const walletReceipts = await fetch(`${baseUrl}/api/receipts/wallet/${SVM_ADDRESS}`);
    assert.equal((await walletReceipts.json() as any).count, 1);

    const entitlement = await fetch(`${baseUrl}/api/entitlements/${SVM_ADDRESS}/check?resource=${encodeURIComponent("/api/agent/costly-data")}`);
    assert.equal((await entitlement.json() as any).authorized, true);

    const catalog = await fetch(`${baseUrl}/api/catalog/services`);
    assert.equal((await catalog.json() as any).services[0].paymentProtocol, "x402");

    const catalogService = await fetch(`${baseUrl}/api/catalog/services/costly-data`);
    assert.equal((await catalogService.json() as any).service.paymentProtocol, "x402");

    const catalogCategories = await fetch(`${baseUrl}/api/catalog/categories`);
    assert.equal((await catalogCategories.json() as any).categories[0].id, "data");

    const protocol = await fetch(`${baseUrl}/api/protocol/adapters`);
    assert.equal((await protocol.json() as any).adapters[0].name, "x402");

    const protocolStatus = await fetch(`${baseUrl}/api/protocol/status`);
    assert.equal((await protocolStatus.json() as any).paymentAdapters.x402, "active");
  });

  it("fails before construction if enabled composition lacks SVM_ADDRESS", () => {
    const app = canonicalTestApp();
    let constructed = false;
    assert.throws(() => mountX402Surface(app, { enabled: true }, {
      createMiddleware: () => {
        constructed = true;
        return (_req, _res, next) => next();
      },
    }), /SVM_ADDRESS is required when X402_ENABLED=true/);
    assert.equal(constructed, false);
  });
});

function canonicalTestApp(): Express {
  const app = express();
  app.get("/health/live", (_req, res) => res.json({ ok: true, status: "alive" }));
  app.get("/api/account/me", (_req, res) => res.status(401).json({ ok: false }));
  app.get("/api/payment-intents/:id/receipt", (_req, res) => res.json({
    ok: true,
    receipt: { receiptId: "receipt:canonical", source: "canonical-payment-intent" },
  }));
  app.get("/api/payment-intents/:id", (req, res) => res.json({ ok: true, paymentIntentId: req.params.id }));
  return app;
}

function x402Paths(): readonly string[] {
  return [
    "/api/agent/costly-data",
    "/api/verify/preview-receipt",
    "/api/receipts",
    "/api/receipts/preview-receipt",
    "/api/receipts/wallet/test-wallet",
    "/api/entitlements/test-wallet",
    "/api/entitlements/test-wallet/check?resource=%2Fapi%2Fagent%2Fcostly-data",
    "/api/catalog/services",
    "/api/catalog/services/costly-data",
    "/api/catalog/categories",
    "/api/protocol/status",
    "/api/protocol/adapters",
  ];
}

async function listen(app: Express): Promise<string> {
  const server = app.listen(0);
  openServers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function loadEnvironment(overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      "import('./src/config/environment.ts').then((module) => { const environment = module.environment ?? module.default?.environment; console.log(JSON.stringify({enabled:environment.x402Enabled,svmAddress:environment.x402SvmAddress ?? null})); })",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...overrides },
    },
  );
}
