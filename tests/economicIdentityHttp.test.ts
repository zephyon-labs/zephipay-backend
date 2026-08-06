import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";

import express, { type NextFunction, type Request, type Response } from "express";
import { InsufficientScopeError, UnauthorizedError } from "express-oauth2-jwt-bearer";
import { exportJWK, SignJWT } from "jose";

import { createAuthPipeline } from "../src/auth/authMiddleware";
import { EconomicIdentityService } from "../src/economicIdentity/economicIdentityService";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { requestContext } from "../src/middleware/requestContext";
import { RecipientDirectoryService } from "../src/recipients/recipientDirectoryService";
import { createEconomicIdentityRouter } from "../src/routes/economicIdentity";
import { createRecipientsRouter } from "../src/routes/recipients";
import { InMemoryEconomicIdentityPersistence } from "../src/storage/memory/inMemoryEconomicIdentityPersistence";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const issuer = "https://tenant.example/";
const audience = "https://api.zephipay.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
let economic: InMemoryEconomicIdentityPersistence;
let accounts: AccountProvisioningService;
let searchableAccountId = "";

before(async () => {
  const canonical = new InMemoryIdentityPersistence();
  accounts = new AccountProvisioningService(canonical);
  economic = new InMemoryEconomicIdentityPersistence({ accountExists: async (id) => Boolean(await canonical.findAccount(id)) });
  const searchable = (await accounts.resolve({ issuer, providerSubject: "auth0|searchable", scopes: [] })).account;
  searchableAccountId = searchable.accountId;
  const searchableIdentity = (await economic.upsertEconomicIdentity({
    accountId: searchable.accountId, accountType: "PERSONAL", username: "Searchable_01",
    normalizedUsername: "searchable_01", displayName: "Searchable Recipient", discoverability: "USERNAME_ONLY",
  })).identity;
  await economic.updateEconomicIdentityState({
    accountId: searchable.accountId, expectedVersion: searchableIdentity.version,
    publicIdentityStatus: "ACTIVE", verificationState: "UNVERIFIED", payabilityState: "AVAILABLE",
  });
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "test" };
  const auth = createAuthPipeline({ issuer, audience, requiredScope: "read:account", publicKey: jwk });
  const app = express();
  app.use(requestContext, express.json({ strict: true }));
  app.use("/api/account", ...auth, createEconomicIdentityRouter(new EconomicIdentityService(accounts, economic)));
  app.use("/api/recipients", ...auth, createRecipientsRouter(accounts, new RecipientDirectoryService(canonical, economic)));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof InsufficientScopeError) return res.status(403).json({ ok: false, error: "scope" });
    if (error instanceof UnauthorizedError) return res.status(401).json({ ok: false, error: "auth" });
    return res.status(500).json({ ok: false, error: "internal" });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

after(async () => closeServer?.());

describe("economic identity HTTP boundary", () => {
  it("requires authentication and the explicit account scope", async () => {
    assert.equal((await fetch(`${baseUrl}/api/account/identity`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/recipients/search`, { method: "POST", headers: { Authorization: `Bearer ${await jwt("no-scope", "other")}`, "Content-Type": "application/json" }, body: JSON.stringify({ username: "someone" }) })).status, 403);
  });

  it("creates and updates only the current identity with exact bodies and no-store responses", async () => {
    const token = await jwt("owner");
    const missing = await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 200);
    assert.match(missing.headers.get("cache-control") ?? "", /no-store.*private/);
    assert.equal((await missing.json() as { identity: unknown }).identity, null);
    const created = await putIdentity(token, { username: "Owner_01", displayName: "Owner", discoverability: "PRIVATE" });
    assert.equal(created.status, 201);
    const body = await created.json() as { identity: Record<string, unknown> };
    assert.equal(body.identity.verificationState, "unverified");
    assert.equal(body.identity.payabilityState, "unavailable");
    assert.equal(body.identity.accountType, "personal");
    assert.equal(body.identity.version, "0");
    const forbidden = await putIdentity(token, { accountType: "PERSONAL", username: "Owner_01", displayName: "Owner", discoverability: "PRIVATE" });
    assert.equal(forbidden.status, 400);
    assert.equal((await forbidden.json() as { code: string }).code, "VALIDATION_ERROR");
    assert.equal((await putIdentity(token, { expectedVersion: "0", username: "Owner_01", displayName: "Updated", discoverability: "USERNAME_ONLY" })).status, 200);
    const stale = await putIdentity(token, { expectedVersion: "0", username: "Owner_01", displayName: "Stale", discoverability: "PRIVATE" });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "VERSION_CONFLICT");
  });

  it("keeps separate authenticated accounts isolated and username uniqueness global", async () => {
    const one = await jwt("isolation-one"); const two = await jwt("isolation-two");
    assert.equal((await putIdentity(one, { username: "Unique_01", displayName: "One", discoverability: "PRIVATE" })).status, 201);
    const collision = await putIdentity(two, { username: "unique_01", displayName: "Two", discoverability: "PRIVATE" });
    assert.equal(collision.status, 409);
    assert.equal((await collision.json() as { code: string }).code, "USERNAME_UNAVAILABLE");
    const oneBody = await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${one}` } })).json() as { identity: { displayName: string } };
    const twoBody = await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${two}` } })).json() as { identity: unknown };
    assert.equal(oneBody.identity.displayName, "One"); assert.equal(twoBody.identity, null);
  });

  it("creates private current-account destinations without exposing them through recipients", async () => {
    const token = await jwt("destination-owner");
    const response = await fetch(`${baseUrl}/api/account/identity/destinations/solana`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ address: "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J", primary: true }),
    });
    assert.equal(response.status, 201);
    const serialized = await response.text();
    assert.match(serialized, /"ownershipState":"unverified"/);
  });

  it("returns uniform bounded recipient misses and safe headers", async () => {
    const token = await jwt("searcher");
    const miss = await fetch(`${baseUrl}/api/recipients/search`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "missing_01" }),
    });
    assert.equal(miss.status, 200); assert.deepEqual(await miss.json(), { ok: true, recipients: [] });
    assert.match(miss.headers.get("cache-control") ?? "", /no-store.*private/);
    for (const body of [{ username: "*" }, { username: "ab" }, { username: "valid_name", email: "x@example.com" }, {}]) {
      const response = await fetch(`${baseUrl}/api/recipients/search`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
  });

  it("searches and freshly resolves only the safe public recipient projection", async () => {
    const token = await jwt("public-searcher");
    const found = await fetch(`${baseUrl}/api/recipients/search`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "SEARCHABLE_01" }),
    });
    assert.equal(found.status, 200);
    const searchText = await found.text();
    assert.match(searchText, /Searchable Recipient/);
    for (const forbidden of ["wallet", "address", "email", "issuer", "subject", "actorSubject", "version"]) assert.doesNotMatch(searchText, new RegExp(forbidden, "i"));
    const resolved = await fetch(`${baseUrl}/api/recipients/${searchableAccountId}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(resolved.status, 200);
    assert.deepEqual(Object.keys((await resolved.json() as { recipient: Record<string, unknown> }).recipient).sort(), [
      "accountId", "accountType", "displayName", "payabilityState", "username", "verificationState",
    ]);
  });
});

async function putIdentity(token: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/account/identity`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function jwt(subject: string, scope = "read:account"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: audience, sub: `auth0|${subject}`, scope })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT" }).setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
}
