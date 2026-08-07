import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import express, { type NextFunction, type Request, type Response } from "express";
import { InsufficientScopeError, UnauthorizedError } from "express-oauth2-jwt-bearer";
import { exportJWK, SignJWT } from "jose";

import { createAuthPipeline } from "../src/auth/authMiddleware";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { requestContext } from "../src/middleware/requestContext";
import { createPaymentIntentsRouter, paymentIntentServiceUnavailable } from "../src/routes/paymentIntents";
import { PaymentIntentService } from "../src/services/paymentIntentService";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";
import { InMemoryExecutionRepository } from "../src/storage/memory/inMemoryExecutionRepository";
import { PaymentExecutionService } from "../src/executions/executionService";
import { PaymentExecutionWorker } from "../src/executions/executionWorker";
import { createActivityRouter, createPaymentExecutionsRouter } from "../src/routes/paymentExecutions";

const issuer = "https://tenant.example/";
const audience = "https://api.zephipay.test";
const recipient = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
let storage: InMemoryPaymentPersistence;
let executionRepository: InMemoryExecutionRepository;
let executionService: PaymentExecutionService;

before(async () => {
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "test" };
  const identities = new InMemoryIdentityPersistence();
  const accounts = new AccountProvisioningService(identities);
  storage = new InMemoryPaymentPersistence();
  const account = (await accounts.resolve({ issuer, providerSubject: "auth0|owner", scopes: [] })).account;
  await storage.createAllowlistEntry({ actorSubject: account.actorSubject });
  const service = new PaymentIntentService(accounts, storage);
  executionRepository = new InMemoryExecutionRepository();
  executionService = new PaymentExecutionService(accounts, storage, executionRepository);
  const app = express();
  app.use(requestContext, express.json({ strict: true }));
  app.use("/api/payment-intents", createPaymentIntentsRouter({
    service,
    readAuth: createAuthPipeline({ issuer, audience, requiredScope: "read:payments", publicKey: jwk }),
    writeAuth: createAuthPipeline({ issuer, audience, requiredScope: "write:payments", publicKey: jwk }),
  }));
  app.use("/api/payment-intents", createPaymentExecutionsRouter({
    service: executionService,
    readAuth: createAuthPipeline({ issuer, audience, requiredScope: "read:payments", publicKey: jwk }),
    writeAuth: createAuthPipeline({ issuer, audience, requiredScope: "write:payments", publicKey: jwk }),
  }));
  app.use("/api/activity", createActivityRouter({ service: executionService,
    readAuth: createAuthPipeline({ issuer, audience, requiredScope: "read:payments", publicKey: jwk }) }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof InsufficientScopeError) return res.status(403).json({ ok: false, error: "scope" });
    if (error instanceof UnauthorizedError) return res.status(401).json({ ok: false, error: "auth" });
    return res.status(500).json({ ok: false, error: "internal" });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

after(async () => closeServer?.());

describe("payment intent HTTP boundary", () => {
  it("enforces authentication and route-specific scopes", async () => {
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/00000000-0000-4000-8000-000000000001`)).status, 401);
    const readOnly = await jwt("auth0|owner", "read:payments");
    assert.equal((await createIntent(readOnly, "http-scope-key-0001")).status, 403);
    const writeOnly = await jwt("auth0|owner", "write:payments");
    const created = await createIntent(writeOnly, "http-scope-key-0002");
    assert.equal(created.status, 201);
    const body = await created.json() as { paymentIntent: { id: string } };
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${body.paymentIntent.id}`, {
      headers: { Authorization: `Bearer ${writeOnly}` },
    })).status, 403);
  });

  it("creates, replays, conflicts, reads, confirms, and preserves request IDs", async () => {
    const write = await jwt("auth0|owner", "write:payments");
    const read = await jwt("auth0|owner", "read:payments");
    const requestId = "request-http-0001";
    const created = await createIntent(write, "http-create-key-0001", "1.25", requestId);
    assert.equal(created.status, 201);
    assert.match(created.headers.get("cache-control") ?? "", /no-store.*private/);
    assert.equal(created.headers.get("x-request-id"), requestId);
    const body = await created.json() as { paymentIntent: Record<string, unknown>; requestId: string };
    assert.equal(body.requestId, requestId);
    assert.equal(typeof body.paymentIntent.amountRaw, "string");
    assert.equal(typeof body.paymentIntent.version, "string");
    const id = String(body.paymentIntent.id);
    const hash = String(body.paymentIntent.requestHash);

    assert.equal((await createIntent(write, "http-create-key-0001", "1.25")).status, 200);
    assert.equal((await createIntent(write, "http-create-key-0001", "2.00")).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${id}`, {
      headers: { Authorization: `Bearer ${read}` },
    })).status, 200);

    const confirmed = await fetch(`${baseUrl}/api/payment-intents/${id}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${write}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestHash: hash, expectedVersion: "0" }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json() as { applied: boolean }).applied, true);
    const replay = await fetch(`${baseUrl}/api/payment-intents/${id}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${write}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestHash: hash, expectedVersion: "0" }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { applied: boolean }).applied, false);
    assert.equal((await storage.listPaymentEvents(id)).filter(({ eventType }) => eventType === "USER_CONFIRMED").length, 1);
  });

  it("returns safe 400 and 404 responses and ignores forged identity headers", async () => {
    const write = await jwt("auth0|owner", "write:payments");
    const read = await jwt("auth0|owner", "read:payments");
    const invalid = await fetch(`${baseUrl}/api/payment-intents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${write}`, "Content-Type": "application/json", "Idempotency-Key": "short" },
      body: JSON.stringify({ recipient, amount: 1.25, purpose: "Test" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/not-a-uuid`, {
      headers: { Authorization: `Bearer ${read}` },
    })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/00000000-0000-4000-8000-000000000099`, {
      headers: { Authorization: `Bearer ${read}` },
    })).status, 404);
    const forged = await createIntent(write, "http-forged-key-0001", "1", undefined, {
      "X-Actor-Subject": "zp:account:00000000-0000-4000-8000-000000000099",
      "X-Account-Id": "00000000-0000-4000-8000-000000000099",
      "X-Email": "attacker@example.com",
    });
    assert.equal(forged.status, 201);
    const forgedBody = await forged.json() as { paymentIntent: { id: string } };
    const stored = await storage.findPayment(forgedBody.paymentIntent.id);
    assert.notEqual(stored?.actorSubject, "zp:account:00000000-0000-4000-8000-000000000099");
  });

  it("returns not found for cross-account reads", async () => {
    const ownerWrite = await jwt("auth0|owner", "write:payments");
    const ownerCreated = await createIntent(ownerWrite, "http-owner-key-0001");
    const id = String((await ownerCreated.json() as { paymentIntent: { id: string } }).paymentIntent.id);
    const otherRead = await jwt("auth0|other", "read:payments");
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${id}`, {
      headers: { Authorization: `Bearer ${otherRead}` },
    })).status, 404);
  });

  it("authenticates explicit execution, rejects authority fields, and returns durable replay", async () => {
    const write=await jwt("auth0|owner","write:payments");const read=await jwt("auth0|owner","read:payments");
    const created=await createIntent(write,"http-execute-key-0001");const intent=(await created.json() as any).paymentIntent;
    await fetch(`${baseUrl}/api/payment-intents/${intent.id}/confirm`,{method:"POST",headers:{Authorization:`Bearer ${write}`,"Content-Type":"application/json"},body:JSON.stringify({requestHash:intent.requestHash,expectedVersion:"0"})});
    const forbidden=await fetch(`${baseUrl}/api/payment-intents/${intent.id}/execute`,{method:"POST",headers:{Authorization:`Bearer ${write}`,"Content-Type":"application/json"},body:JSON.stringify({requestHash:intent.requestHash,expectedVersion:"1",rail:"solana"})});assert.equal(forbidden.status,400);
    const execute=()=>fetch(`${baseUrl}/api/payment-intents/${intent.id}/execute`,{method:"POST",headers:{Authorization:`Bearer ${write}`,"Content-Type":"application/json"},body:JSON.stringify({requestHash:intent.requestHash,expectedVersion:"1"})});
    const first=await execute();assert.equal(first.status,202);const firstBody=await first.json() as any;const replay=await execute();assert.equal(replay.status,200);assert.equal((await replay.json() as any).execution.executionId,firstBody.execution.executionId);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${intent.id}/execution`,{headers:{Authorization:`Bearer ${read}`}})).status,200);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${intent.id}/execution`,{headers:{Authorization:`Bearer ${await jwt("auth0|other","read:payments")}`}})).status,404);
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${intent.id}/execute`,{method:"POST",headers:{Authorization:`Bearer ${read}`,"Content-Type":"application/json"},body:"{}"})).status,403);
  });

  it("serves owner-only durable receipt, activity, and frontend-safe execution truth", async () => {
    const write=await jwt("auth0|owner","write:payments"); const read=await jwt("auth0|owner","read:payments");
    const intent=(await (await createIntent(write,"http-receipt-key-0001","2.5")).json() as any).paymentIntent;
    await fetch(`${baseUrl}/api/payment-intents/${intent.id}/confirm`,{method:"POST",headers:{Authorization:`Bearer ${write}`,"Content-Type":"application/json"},body:JSON.stringify({requestHash:intent.requestHash,expectedVersion:"0"})});
    await fetch(`${baseUrl}/api/payment-intents/${intent.id}/execute`,{method:"POST",headers:{Authorization:`Bearer ${write}`,"Content-Type":"application/json"},body:JSON.stringify({requestHash:intent.requestHash,expectedVersion:"1"})});
    assert.equal((await fetch(`${baseUrl}/api/payment-intents/${intent.id}/receipt`,{headers:{Authorization:`Bearer ${read}`}})).status,404);
    const worker=new PaymentExecutionWorker(storage,executionRepository,"http-worker","immediate_settled",()=>"2026-08-07T12:00:00.000Z");
    for(let index=0;index<20;index++){const current=await executionRepository.findByPaymentIntent(intent.id);if(current?.status==="SETTLED")break;await worker.processNext();await worker.reconcileNext();}
    const receiptResponse=await fetch(`${baseUrl}/api/payment-intents/${intent.id}/receipt`,{headers:{Authorization:`Bearer ${read}`}}); assert.equal(receiptResponse.status,200);
    const receipt=(await receiptResponse.json() as any).receipt; assert.equal(receipt.amountRaw,"2500000"); assert.equal("evidence" in receipt,false); assert.equal("actorSubject" in receipt,false);
    const execution=(await (await fetch(`${baseUrl}/api/payment-intents/${intent.id}/execution`,{headers:{Authorization:`Bearer ${read}`}})).json() as any).execution;
    assert.equal(execution.status,"settled"); assert.equal(execution.receiptAvailable,true); assert.equal("providerIdempotencyKey" in execution,false);
    const activity=(await (await fetch(`${baseUrl}/api/activity?limit=20`,{headers:{Authorization:`Bearer ${read}`}})).json() as any).items;
    assert.ok(activity.some((item:any)=>item.paymentIntentId===intent.id&&item.status==="completed"&&item.receiptAvailable));
    const other=await jwt("auth0|other","read:payments"); assert.equal((await fetch(`${baseUrl}/api/payment-intents/${intent.id}/receipt`,{headers:{Authorization:`Bearer ${other}`}})).status,404);
    assert.equal((await fetch(`${baseUrl}/api/activity`,{headers:{Authorization:`Bearer ${other}`}})).status,200);
  });

  it("returns 503 when the payment-intent service is not configured", async () => {
    const app = express();
    app.use(requestContext);
    app.use("/api/payment-intents", paymentIntentServiceUnavailable);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/payment-intents`);
      assert.equal(response.status, 503);
      assert.match(response.headers.get("cache-control") ?? "", /no-store.*private/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps Payment Intent creation non-executing and hard-disables legacy send", async () => {
    const route = await readFile(new URL("../src/routes/paymentIntents.ts", import.meta.url), "utf8");
    const service = await readFile(new URL("../src/services/paymentIntentService.ts", import.meta.url), "utf8");
    const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.doesNotMatch(route + service, /payservice|executePayment|executeSolanaSplPay|solanaSplPayExecutor|PaymentRuntime/);
    assert.match(server, /"\/api\/send"/);
    assert.match(server, /Legacy direct execution is disabled/);
    assert.doesNotMatch(server, /executePayment\(/);
    assert.match(server, /rateLimiter: paymentRateLimiter/);
  });
});

async function createIntent(
  token: string,
  idempotencyKey: string,
  amount = "1.25",
  requestId?: string,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/payment-intents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(requestId ? { "X-Request-Id": requestId } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ recipient, amount, purpose: "Test payment" }),
  });
}

async function jwt(subject: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: audience, sub: subject, scope })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(privateKey);
}
