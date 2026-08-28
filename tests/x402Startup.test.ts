import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";

test("default-off backend starts without SVM_ADDRESS and preserves canonical route registration", async () => {
  const port = await availablePort();
  const previous = snapshotEnvironment([
    "NODE_ENV",
    "PORT",
    "X402_ENABLED",
    "SVM_ADDRESS",
    "AUTH_ENABLED",
    "POSTGRES_ENABLED",
    "DATABASE_URL",
  ]);
  process.env.NODE_ENV = "test";
  process.env.PORT = String(port);
  delete process.env.X402_ENABLED;
  delete process.env.SVM_ADDRESS;
  delete process.env.AUTH_ENABLED;
  delete process.env.POSTGRES_ENABLED;
  delete process.env.DATABASE_URL;

  let server: HttpServer | undefined;
  try {
    const module = await import("../src/server");
    const runningBackend = module.runningBackend;
    server = runningBackend.server;
    if (!server.listening) {
      await new Promise<void>((resolve) => server?.once("listening", resolve));
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/account/me`)).status, 503);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/00000000-0000-4000-8000-000000000001/receipt`)).status, 503);
    assert.equal((await fetch(`${baseUrl}/api/send`, { method: "POST" })).status, 410);

    for (const path of [
      "/api/agent/costly-data",
      "/api/verify/preview-receipt",
      "/api/receipts",
      "/api/entitlements/test-wallet",
      "/api/catalog/services",
      "/api/protocol/status",
    ]) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 404, path);
    }
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    }
    restoreEnvironment(previous);
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function snapshotEnvironment(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
