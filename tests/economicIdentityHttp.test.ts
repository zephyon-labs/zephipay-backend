import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import type { PaymentIntentService } from "../src/services/paymentIntentService";
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
  const readAuth = createAuthPipeline({ issuer, audience, requiredScope: "read:account", publicKey: jwk });
  const writeAuth = createAuthPipeline({ issuer, audience, requiredScope: "write:account", publicKey: jwk });
  const paymentReadAuth = createAuthPipeline({ issuer, audience, requiredScope: "read:payments", publicKey: jwk });
  const recentPayments = {
    recent: async (principal: { providerSubject: string }) => [{ accountId: principal.providerSubject }],
  } as unknown as PaymentIntentService;
  const app = express();
  app.use(requestContext, express.json({ strict: true }));
  app.use("/api/account", createEconomicIdentityRouter({
    service: new EconomicIdentityService(accounts, economic), readAuth, writeAuth,
  }));
  app.use("/api/recipients", createRecipientsRouter({
    accounts,
    directory: new RecipientDirectoryService(canonical, economic),
    payments: recentPayments,
    directoryReadAuth: readAuth,
    historyReadAuth: paymentReadAuth,
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof InsufficientScopeError) return res.status(403).set(error.headers).json({ ok: false, error: "scope" });
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
  it("requires bearer authentication and exact route-specific account scopes", async () => {
    assert.equal((await fetch(`${baseUrl}/api/account/identity`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/account/identity`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identityBody("Missing_01")),
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/recipients/search`, { method: "POST", headers: { Authorization: `Bearer ${await jwt("no-scope", "other")}`, "Content-Type": "application/json" }, body: JSON.stringify({ username: "someone" }) })).status, 403);

    const read = await jwt("read-only", "read:account");
    assert.equal((await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${read}` } })).status, 200);
    const readWriteAttempt = await putIdentity(read, identityBody("ReadOnly_01"));
    assert.equal(readWriteAttempt.status, 403);
    assert.match(readWriteAttempt.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
    assert.equal((await putDestination(read, { address: wallet(1), primary: true })).status, 403);

    const write = await jwt("write-only", "write:account");
    assert.equal((await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${write}` } })).status, 403);
    assert.equal((await putIdentity(write, identityBody("WriteOnly_01"))).status, 201);
    assert.equal((await putDestination(write, { address: wallet(2), primary: true })).status, 201);

    for (const scope of ["read:payments", "write:payments"]) {
      const payment = await jwt(`payment-${scope}`, scope);
      assert.equal((await putIdentity(payment, identityBody(scope === "read:payments" ? "PaymentRead_01" : "PaymentWrite_01"))).status, 403);
      assert.equal((await putDestination(payment, { address: scope === "read:payments" ? wallet(3) : wallet(4), primary: true })).status, 403);
    }
  });

  it("fails closed for absent, malformed, array, numeric, and permissions-only scope claims", async () => {
    for (const [name, scope, extra] of [
      ["absent", undefined, {}],
      ["numeric", 7, {}],
      ["array", ["write:account"], {}],
      ["malformed", "write:account,read:account", {}],
      ["permissions-only", undefined, { permissions: ["write:account"] }],
    ] as const) {
      const token = await jwt(`malformed-${name}`, scope, extra);
      assert.equal((await putIdentity(token, identityBody(`Malformed_${name.replace("-", "_")}`))).status, 403);
    }
  });

  it("creates and updates only the current identity with exact bodies and no-store responses", async () => {
    const readToken = await jwt("owner", "read:account");
    const writeToken = await jwt("owner", "write:account");
    const missing = await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${readToken}` } });
    assert.equal(missing.status, 200);
    assert.match(missing.headers.get("cache-control") ?? "", /no-store.*private/);
    assert.equal((await missing.json() as { identity: unknown }).identity, null);
    const created = await putIdentity(writeToken, { username: "Owner_01", displayName: "Owner", discoverability: "PRIVATE" });
    assert.equal(created.status, 201);
    const body = await created.json() as { identity: Record<string, unknown> };
    assert.equal(body.identity.verificationState, "unverified");
    assert.equal(body.identity.payabilityState, "unavailable");
    assert.equal(body.identity.accountType, "personal");
    assert.equal(body.identity.version, "0");
    const forbidden = await putIdentity(writeToken, { accountType: "PERSONAL", username: "Owner_01", displayName: "Owner", discoverability: "PRIVATE" });
    assert.equal(forbidden.status, 400);
    assert.equal((await forbidden.json() as { code: string }).code, "VALIDATION_ERROR");
    assert.equal((await putIdentity(writeToken, { expectedVersion: "0", username: "Owner_01", displayName: "Updated", discoverability: "USERNAME_ONLY" })).status, 200);
    const stale = await putIdentity(writeToken, { expectedVersion: "0", username: "Owner_01", displayName: "Stale", discoverability: "PRIVATE" });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "VERSION_CONFLICT");
  });

  it("keeps separate authenticated accounts isolated and username uniqueness global", async () => {
    const oneWrite = await jwt("isolation-one", "write:account"); const twoWrite = await jwt("isolation-two", "write:account");
    const oneRead = await jwt("isolation-one", "read:account"); const twoRead = await jwt("isolation-two", "read:account");
    assert.equal((await putIdentity(oneWrite, { username: "Unique_01", displayName: "One", discoverability: "PRIVATE" })).status, 201);
    const collision = await putIdentity(twoWrite, { username: "unique_01", displayName: "Two", discoverability: "PRIVATE" });
    assert.equal(collision.status, 409);
    assert.equal((await collision.json() as { code: string }).code, "USERNAME_UNAVAILABLE");
    const oneBody = await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${oneRead}` } })).json() as { identity: { displayName: string } };
    const twoBody = await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${twoRead}` } })).json() as { identity: unknown };
    assert.equal(oneBody.identity.displayName, "One"); assert.equal(twoBody.identity, null);
  });

  it("creates private current-account destinations without exposing them through recipients", async () => {
    const token = await jwt("destination-owner", "write:account");
    const response = await putDestination(token, { address: "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J", primary: true });
    assert.equal(response.status, 201);
    const serialized = await response.text();
    assert.match(serialized, /"ownershipState":"unverified"/);
  });

  it("cannot redirect canonical ownership with body fields, headers, or another account's destination ID", async () => {
    const ownerWrite = await jwt("canonical-owner", "write:account");
    const ownerRead = await jwt("canonical-owner", "read:account");
    const otherWrite = await jwt("canonical-other", "write:account");
    const otherRead = await jwt("canonical-other", "read:account");
    assert.equal((await putIdentity(ownerWrite, identityBody("CanonicalOwner_01"))).status, 201);
    const ownerIdentity = (await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${ownerRead}` } })).json() as { identity: { accountId: string } }).identity;

    const forgedBody = await putIdentity(otherWrite, { ...identityBody("Redirected_01"), accountId: ownerIdentity.accountId });
    assert.equal(forgedBody.status, 400);
    const forgedHeaders = await putIdentity(otherWrite, identityBody("CanonicalOther_01"), {
      "X-Account-Id": ownerIdentity.accountId,
      "X-Actor-Subject": `zp:account:${ownerIdentity.accountId}`,
      "X-Email": "owner@example.com",
    });
    assert.equal(forgedHeaders.status, 201);
    assert.equal((await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${ownerRead}` } })).json() as { identity: { username: string } }).identity.username, "CanonicalOwner_01");
    assert.equal((await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${otherRead}` } })).json() as { identity: { username: string } }).identity.username, "CanonicalOther_01");

    const destination = await putDestination(ownerWrite, { address: wallet(5), primary: true });
    const owned = (await destination.json() as { destination: { id: string; address: string; version: string } }).destination;
    const reassignment = await putDestination(otherWrite, {
      destinationId: owned.id, expectedVersion: owned.version, address: owned.address, primary: true,
    });
    assert.equal(reassignment.status, 409);
    const current = await (await fetch(`${baseUrl}/api/account/identity`, { headers: { Authorization: `Bearer ${ownerRead}` } })).json() as { destinations: Array<{ id: string }> };
    assert.equal(current.destinations.some(({ id }) => id === owned.id), true);
  });

  it("uses payment-history read authority for recent recipients and keeps actors isolated", async () => {
    const accountOnly = await jwt("recent-account", "read:account");
    assert.equal((await fetch(`${baseUrl}/api/recipients/recent`, { headers: { Authorization: `Bearer ${accountOnly}` } })).status, 403);
    const owner = await jwt("recent-owner", "read:payments");
    const other = await jwt("recent-other", "read:payments");
    const ownerBody = await (await fetch(`${baseUrl}/api/recipients/recent`, { headers: { Authorization: `Bearer ${owner}` } })).json() as { recipients: Array<{ accountId: string }> };
    const otherBody = await (await fetch(`${baseUrl}/api/recipients/recent`, { headers: { Authorization: `Bearer ${other}` } })).json() as { recipients: Array<{ accountId: string }> };
    assert.deepEqual(ownerBody.recipients, [{ accountId: "auth0|recent-owner" }]);
    assert.deepEqual(otherBody.recipients, [{ accountId: "auth0|recent-other" }]);
  });

  it("registers every current account mutation with explicit write authorization", async () => {
    const identityRoutes = await readFile(new URL("../src/routes/economicIdentity.ts", import.meta.url), "utf8");
    const accountRoutes = await readFile(new URL("../src/routes/account.ts", import.meta.url), "utf8");
    const zpRoutes = await readFile(new URL("../src/routes/zp.ts", import.meta.url), "utf8");
    const recipientRoutes = await readFile(new URL("../src/routes/recipients.ts", import.meta.url), "utf8");
    assert.match(accountRoutes, /router\.get\("\/me", \.\.\.input\.readAuth/);
    assert.match(identityRoutes, /router\.get\("\/identity", \.\.\.input\.readAuth/);
    assert.match(identityRoutes, /router\.put\("\/identity", \.\.\.input\.writeAuth/);
    assert.match(identityRoutes, /router\.put\("\/identity\/destinations\/solana", \.\.\.input\.writeAuth/);
    assert.match(zpRoutes, /router\.get\("\/zp", \.\.\.input\.readAuth/);
    assert.match(recipientRoutes, /router\.get\("\/recent", \.\.\.input\.historyReadAuth/);
    assert.equal((identityRoutes.match(/router\.put\(/g) ?? []).length, 2);
    assert.equal((identityRoutes.match(/\.\.\.input\.writeAuth/g) ?? []).length, 2);
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

async function putIdentity(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/account/identity`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function putDestination(token: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/account/identity/destinations/solana`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function identityBody(username: string) { return { username, displayName: username, discoverability: "PRIVATE" }; }

function wallet(seed: number): string {
  return ["11111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "Vote111111111111111111111111111111111111111", "Stake11111111111111111111111111111111111111", "Config1111111111111111111111111111111111111"][seed - 1];
}

async function jwt(subject: string, scope: unknown = "read:account", extra: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: audience, sub: `auth0|${subject}`, ...(scope === undefined ? {} : { scope }), ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT" }).setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
}
