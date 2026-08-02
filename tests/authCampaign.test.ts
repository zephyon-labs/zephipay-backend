import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import express from "express";
import { exportJWK, SignJWT } from "jose";

import { createAuthPipeline, externalPrincipalFrom } from "../src/auth/authMiddleware";
import { AccountAccessDeniedError, AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const issuer = "https://tenant.example/";
const audience = "https://api.zephipay.test";

describe("account provisioning", () => {
  it("creates exactly one canonical account under concurrent first login", async () => {
    const storage = new InMemoryIdentityPersistence();
    const service = new AccountProvisioningService(storage);
    const principal = { issuer, providerSubject: "auth0|one", scopes: ["read:account"] } as const;
    const results = await Promise.all(Array.from({ length: 12 }, () => service.resolve(principal)));
    assert.equal(new Set(results.map(({ account }) => account.accountId)).size, 1);
    assert.equal(new Set(results.map(({ account }) => account.actorSubject)).size, 1);
    assert.equal((await storage.listExternalIdentities(results[0].account.accountId)).length, 1);
    assert.deepEqual((await storage.listAccountSecurityEvents(results[0].account.accountId)).map((event) => event.eventType), [
      "ACCOUNT_CREATED", "EXTERNAL_IDENTITY_LINKED",
    ]);
  });

  it("never merges matching email evidence and rejects suspended accounts", async () => {
    const storage = new InMemoryIdentityPersistence();
    const service = new AccountProvisioningService(storage);
    const first = await service.resolve({ issuer, providerSubject: "one", email: "same@example.com", scopes: [] });
    const second = await service.resolve({ issuer, providerSubject: "two", email: "same@example.com", scopes: [] });
    assert.notEqual(first.account.accountId, second.account.accountId);
    await storage.updateAccountStatus({ accountId: first.account.accountId, expectedVersion: first.account.version, status: "SUSPENDED" });
    await assert.rejects(() => service.resolve({ issuer, providerSubject: "one", scopes: [] }), AccountAccessDeniedError);
  });
});

describe("JWT verification", () => {
  it("accepts only exact RS256 issuer, audience, and scope without trusting identity headers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const unknown = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const jwk = await exportJWK(publicKey);
    const app = express();
    app.get("/", ...createAuthPipeline({ issuer, audience, requiredScope: "read:account", publicKey: { ...jwk, alg: "RS256", kid: "test" } }),
      (_req, res) => res.json({ principal: externalPrincipalFrom(res) }));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status((error as { status?: number }).status ?? 500).json({ error: "rejected" }));
    const server = app.listen(0);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/`;
    const valid = await token(privateKey, { iss: issuer, aud: audience, sub: "auth0|subject", scope: "read:account" });
    try {
      const accepted = await fetch(url, { headers: { Authorization: `Bearer ${valid}`, "X-Actor-Subject": "zp:account:forged" } });
      assert.equal(accepted.status, 200);
      const body = await accepted.json() as { principal: { providerSubject: string } };
      assert.equal(body.principal.providerSubject, "auth0|subject");
      for (const claims of [
        { iss: "https://wrong.example/", aud: audience, sub: "x", scope: "read:account" },
        { iss: issuer, aud: "wrong", sub: "x", scope: "read:account" },
        { iss: issuer, aud: audience, sub: "x", scope: "other" },
      ]) {
        const rejected = await fetch(url, { headers: { Authorization: `Bearer ${await token(privateKey, claims)}` } });
        assert.ok(rejected.status === 401 || rejected.status === 403);
        assert.doesNotMatch(await rejected.text(), new RegExp(valid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      for (const rejectedToken of [
        await token(privateKey, { iss: issuer, aud: audience, sub: "expired", scope: "read:account" }, { expiration: -60 }),
        await token(privateKey, { iss: issuer, aud: audience, sub: "future", scope: "read:account", nbf: Math.floor(Date.now() / 1000) + 60 }),
        await token(unknown, { iss: issuer, aud: audience, sub: "unknown-key", scope: "read:account" }),
        await token(privateKey, { iss: issuer, aud: "site-client-id", sub: "id-token-subject", scope: "openid" }),
      ]) {
        assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${rejectedToken}` } })).status, 401);
      }
      assert.equal((await fetch(url)).status, 401);
      // The SDK classifies a non-Bearer scheme as malformed (400); the API's
      // centralized auth handler intentionally normalizes it to its public 401 contract.
      assert.equal((await fetch(url, { headers: { Authorization: "Basic abc" } })).status, 400);
    } finally { server.close(); }
  });
});

async function token(key: CryptoKey | Parameters<typeof SignJWT.prototype.sign>[0], claims: Record<string, unknown>, options: { expiration?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT" })
    .setIssuedAt(now).setExpirationTime(now + (options.expiration ?? 60)).sign(key);
}
