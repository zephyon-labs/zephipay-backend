import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  InsufficientScopeError,
  UnauthorizedError,
} from "express-oauth2-jwt-bearer";
import { exportJWK, SignJWT } from "jose";

import { createAuthPipeline } from "../src/auth/authMiddleware";
import { ZpProgressService } from "../src/growth/zpProgressService";
import type { AccountZpState } from "../src/growth/zpState";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { requestContext } from "../src/middleware/requestContext";
import { createZpRouter } from "../src/routes/zp";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const ISSUER = "https://tenant.example/";
const AUDIENCE = "https://api.zephipay.test";
const SCOPE = "read:account";
const NOW = "2026-08-20T12:00:00.000Z";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
let identities: InMemoryIdentityPersistence;
let states: FakeZpStateReader;
let ownerAccountId = "";
let otherAccountId = "";

class FakeZpStateReader {
  readonly values = new Map<string, AccountZpState>();
  failureAccountId?: string;

  async find(accountId: string): Promise<AccountZpState | undefined> {
    if (accountId === this.failureAccountId) {
      throw new Error("private database host and query detail");
    }

    return this.values.get(accountId);
  }
}

before(async () => {
  identities = new InMemoryIdentityPersistence();
  const accounts = new AccountProvisioningService(identities);
  states = new FakeZpStateReader();

  ownerAccountId = (await accounts.resolve(principal("owner"))).account.accountId;
  otherAccountId = (await accounts.resolve(principal("other"))).account.accountId;
  const failureAccountId = (await accounts.resolve(principal("failure"))).account.accountId;
  const inactive = (await accounts.resolve(principal("inactive"))).account;

  await identities.updateAccountStatus({
    accountId: inactive.accountId,
    expectedVersion: inactive.version,
    status: "SUSPENDED",
  });

  states.values.set(otherAccountId, durableState(otherAccountId, {
    totalPoints: 250n,
    sentCount: 25n,
    receivedCount: 0n,
  }));
  states.failureAccountId = failureAccountId;

  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "RS256",
    kid: "test",
  };
  const auth = createAuthPipeline({
    issuer: ISSUER,
    audience: AUDIENCE,
    requiredScope: SCOPE,
    publicKey: jwk,
  });
  const app = express();
  app.use(requestContext, express.json({ strict: true }));
  app.use(
    "/api/account",
    ...auth,
    createZpRouter(new ZpProgressService(accounts, states)),
  );
  app.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof InsufficientScopeError) {
        return res.status(403).set("Cache-Control", "no-store").json({
          ok: false,
          error: "Account access is not permitted.",
          requestId: res.locals.requestId,
        });
      }
      if (error instanceof UnauthorizedError) {
        return res.status(401).set("Cache-Control", "no-store").json({
          ok: false,
          error: "Authentication is required.",
          requestId: res.locals.requestId,
        });
      }
      return res.status(500).json({
        ok: false,
        error: "Internal server error.",
        requestId: res.locals.requestId,
      });
    },
  );

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

after(async () => closeServer?.());

describe("current-account ZP HTTP boundary", () => {
  it("requires verified authentication and the account-read scope", async () => {
    assert.equal((await fetch(`${baseUrl}/api/account/zp`)).status, 401);
    const insufficient = await fetch(`${baseUrl}/api/account/zp`, {
      headers: { Authorization: `Bearer ${await jwt("owner", "read:payments")}` },
    });
    assert.equal(insufficient.status, 403);
  });

  it("returns the exact no-store zero projection for absent durable state", async () => {
    const response = await getZp("owner", {
      "X-Request-Id": "zp-zero-request-0001",
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store.*private/);
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-request-id"), "zp-zero-request-0001");
    assert.deepEqual(await response.json(), {
      ok: true,
      zp: zeroProjection(),
      requestId: "zp-zero-request-0001",
    });
  });

  it("returns an exact populated frontend-safe projection with bigint precision", async () => {
    states.values.set(ownerAccountId, durableState(ownerAccountId, {
      totalPoints: 9_007_199_254_740_993n,
      sentCount: 10n,
      receivedCount: 1n,
    }));

    const response = await getZp("owner");
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(body, {
      ok: true,
      zp: {
        totalPoints: "9007199254740993",
        sentCount: "10",
        receivedCount: "1",
        policyVersion: 1,
        unlockedMilestones: [
          "FIRST_PAYMENT_SENT",
          "FIRST_PAYMENT_RECEIVED",
          "TEN_PAYMENTS_SENT",
        ],
        pendingMilestones: [
          {
            milestone: "TWENTY_FIVE_PAYMENTS_SENT",
            dimension: "SENT",
            current: "10",
            target: "25",
            progressPercent: 40,
          },
        ],
      },
      requestId: body.requestId,
    });
  });

  it("ignores every client-supplied account authority and remains owner-only", async () => {
    states.values.delete(ownerAccountId);
    const forged = await fetch(
      `${baseUrl}/api/account/zp?accountId=${otherAccountId}&actorSubject=forged&email=other@example.com`,
      {
        headers: {
          Authorization: `Bearer ${await jwt("owner")}`,
          "X-Account-Id": otherAccountId,
          "X-Actor-Subject": "zp:account:forged",
          "X-Email": "other@example.com",
        },
      },
    );

    assert.equal(forged.status, 200);
    assert.deepEqual((await forged.json() as { zp: unknown }).zp, zeroProjection());

    const bodyAttempt = await getWithBody(
      await jwt("owner"),
      JSON.stringify({
        accountId: otherAccountId,
        actorSubject: "forged",
        email: "other@example.com",
      }),
    );
    assert.equal(bodyAttempt.status, 200);
    assert.deepEqual((bodyAttempt.body as { zp: unknown }).zp, zeroProjection());

    const guessedPath = await fetch(
      `${baseUrl}/api/account/zp/${otherAccountId}`,
      { headers: { Authorization: `Bearer ${await jwt("owner")}` } },
    );
    assert.equal(guessedPath.status, 404);
  });

  it("returns the authenticated account's state and never another account's state", async () => {
    states.values.set(ownerAccountId, durableState(ownerAccountId, {
      totalPoints: 10n,
      sentCount: 1n,
    }));

    const owner = await getZp("owner");
    const other = await getZp("other");
    assert.equal(owner.status, 200);
    assert.equal(other.status, 200);
    assert.equal((await owner.json() as any).zp.totalPoints, "10");
    assert.equal((await other.json() as any).zp.totalPoints, "250");
  });

  it("preserves bounded inactive-account denial", async () => {
    const response = await getZp("inactive");
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Account access is unavailable.",
      requestId: response.headers.get("x-request-id"),
    });
  });

  it("sanitizes storage failure and never returns fabricated zero state", async () => {
    const response = await getZp("failure");
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.doesNotMatch(text, /private database host|query detail/i);
    assert.doesNotMatch(text, /totalPoints|pendingMilestones/);
    assert.match(text, /Internal server error/);
  });
});

function principal(subject: string) {
  return Object.freeze({
    issuer: ISSUER,
    providerSubject: `auth0|${subject}`,
    scopes: Object.freeze([SCOPE]),
  });
}

function durableState(
  accountId: string,
  overrides: Partial<AccountZpState> = {},
): AccountZpState {
  return Object.freeze({
    accountId,
    policyVersion: 1,
    totalPoints: 0n,
    sentCount: 0n,
    receivedCount: 0n,
    lastGrowthEventId: 99n,
    updatedAt: NOW,
    ...overrides,
  });
}

function zeroProjection() {
  return {
    totalPoints: "0",
    sentCount: "0",
    receivedCount: "0",
    policyVersion: 1,
    unlockedMilestones: [],
    pendingMilestones: [
      { milestone: "FIRST_PAYMENT_SENT", dimension: "SENT", current: "0", target: "1", progressPercent: 0 },
      { milestone: "FIRST_PAYMENT_RECEIVED", dimension: "RECEIVED", current: "0", target: "1", progressPercent: 0 },
      { milestone: "TEN_PAYMENTS_SENT", dimension: "SENT", current: "0", target: "10", progressPercent: 0 },
      { milestone: "TWENTY_FIVE_PAYMENTS_SENT", dimension: "SENT", current: "0", target: "25", progressPercent: 0 },
    ],
  };
}

async function getZp(subject: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/account/zp`, {
    headers: {
      Authorization: `Bearer ${await jwt(subject)}`,
      ...headers,
    },
  });
}

async function jwt(subject: string, scope = SCOPE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: `auth0|${subject}`,
    scope,
    email: `${subject}@example.com`,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function getWithBody(
  token: string,
  body: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const url = new URL(`${baseUrl}/api/account/zp`);

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve(Object.freeze({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      })));
    });
    req.on("error", reject);
    req.end(body);
  });
}
