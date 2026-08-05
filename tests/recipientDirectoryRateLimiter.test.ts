import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express, { type Request } from "express";

import {
  createRecipientDirectoryAccountRateLimiter,
  createRecipientDirectoryIpRateLimiter,
  RECIPIENT_DIRECTORY_ACCOUNT_LIMIT,
  RECIPIENT_DIRECTORY_IP_LIMIT,
} from "../src/middleware/recipientDirectoryRateLimiter";

describe("recipient directory abuse controls", () => {
  it("limits repeated lookups by canonical account", async () => {
    const app = express();
    app.use((req: Request & { recipientRequesterAccountId?: string }, _res, next) => {
      req.recipientRequesterAccountId = String(req.header("x-test-account")); next();
    });
    app.use(createRecipientDirectoryAccountRateLimiter());
    app.post("/", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (url) => {
      for (let index = 0; index < RECIPIENT_DIRECTORY_ACCOUNT_LIMIT; index += 1) {
        assert.equal((await fetch(url, { method: "POST", headers: { "X-Test-Account": "canonical-account-a" } })).status, 200);
      }
      assert.equal((await fetch(url, { method: "POST", headers: { "X-Test-Account": "canonical-account-a" } })).status, 429);
      assert.equal((await fetch(url, { method: "POST", headers: { "X-Test-Account": "canonical-account-b" } })).status, 200);
    });
  });

  it("limits aggregate lookups by IP independently of canonical account", async () => {
    const app = express();
    app.use(createRecipientDirectoryIpRateLimiter());
    app.post("/", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (url) => {
      for (let index = 0; index < RECIPIENT_DIRECTORY_IP_LIMIT; index += 1) {
        assert.equal((await fetch(url, { method: "POST", headers: { "X-Test-Account": `account-${index}` } })).status, 200);
      }
      const limited = await fetch(url, { method: "POST" });
      assert.equal(limited.status, 429);
      assert.match(await limited.text(), /Too many recipient lookups/);
    });
  });
});

async function withServer(app: express.Express, run: (url: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}/`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
