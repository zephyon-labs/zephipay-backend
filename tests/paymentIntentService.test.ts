import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasActivePaymentAccess } from "../src/allowlist/allowlistEntry";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import {
  parseConfirmPaymentIntentRequest,
  parseIdempotencyKey,
  parsePaymentIntentRequest,
  rawUsdcToDisplay,
  usdcAmountToRaw,
} from "../src/payments/paymentIntentValidation";
import { createPaymentRequestHash } from "../src/payments/requestHash";
import { PaymentIntentApplicationError, PaymentIntentService } from "../src/services/paymentIntentService";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";

const NOW = "2026-08-03T12:00:00.000Z";
const LATER = "2026-08-04T12:00:00.000Z";
const RECIPIENT = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const principal = { issuer: "https://tenant.example/", providerSubject: "auth0|one", scopes: ["read:payments", "write:payments"] } as const;

async function fixture(options: { enabled?: boolean; expiresAt?: string; allowlisted?: boolean; revoked?: boolean } = {}) {
  const identity = new InMemoryIdentityPersistence({ clock: () => NOW });
  const accounts = new AccountProvisioningService(identity);
  const payments = new InMemoryPaymentPersistence({ clock: () => "2026-08-01T12:00:00.000Z" });
  const account = (await accounts.resolve(principal)).account;
  if (options.allowlisted !== false) {
    await payments.createAllowlistEntry({
      actorSubject: account.actorSubject,
      enabled: options.enabled,
      expiresAt: options.expiresAt,
    });
  }
  let nextId = 1;
  const servicePayments = options.revoked
    ? new Proxy(payments, {
        get(target, property) {
          if (property === "findAllowlistEntry") {
            return async (actorSubject: string) => {
              const entry = await target.findAllowlistEntry(actorSubject);
              return entry ? { ...entry, enabled: false, revokedAt: "2026-08-02T12:00:00.000Z" } : undefined;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : payments;
  const service = new PaymentIntentService(accounts, servicePayments, {
    clock: () => NOW,
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
  });
  return { identity, accounts, payments, servicePayments, account, service };
}

const createInput = (overrides: Partial<{ idempotencyKey: string; recipient: string; amount: string; purpose: string | null }> = {}) => ({
  idempotencyKey: "intent-key-00000001",
  recipient: RECIPIENT,
  amount: "1.250000",
  purpose: "Dinner",
  ...overrides,
});

describe("payment intent input", () => {
  it("normalizes every absent purpose form to null and preserves valid supplied context", () => {
    for (const purpose of [undefined, null, "", "   "]) {
      const input = { recipient: RECIPIENT, amount: "1", ...(purpose === undefined ? {} : { purpose }) };
      assert.equal(parsePaymentIntentRequest(input).purpose, null);
    }
    assert.equal(parsePaymentIntentRequest({ recipient: RECIPIENT, amount: "1", purpose: " Dinner " }).purpose, "Dinner");
    assert.throws(() => parsePaymentIntentRequest({ recipient: RECIPIENT, amount: "1", purpose: "x".repeat(121) }));
  });

  it("hashes equivalent absent forms canonically and distinguishes supplied purpose", () => {
    const base = { actorSubject: "actor", network: "solana-devnet" as const, mintAddress: "mint", recipientAddress: RECIPIENT, amountRaw: 1n };
    const absent = [undefined, null, "", "   "].map((purpose) => createPaymentRequestHash({ ...base, purpose: parsePaymentIntentRequest({ recipient: RECIPIENT, amount: "1", ...(purpose === undefined ? {} : { purpose }) }).purpose }));
    assert.equal(new Set(absent).size, 1);
    assert.notEqual(createPaymentRequestHash({ ...base, purpose: "Dinner" }), absent[0]);
  });
  it("converts exact decimal USDC without floating point", () => {
    assert.equal(usdcAmountToRaw("9007199254740.993001"), 9_007_199_254_740_993_001n);
    assert.equal(rawUsdcToDisplay(1_250_000n), "1.25");
    assert.equal(rawUsdcToDisplay(1_000_001n), "1.000001");
  });

  it("rejects numeric, scientific, signed, zero, and excess-precision amounts", () => {
    for (const amount of [1.2, "1e3", "-1", "+1", "0", "0.0000001", "1.", "9223372036855"]) {
      assert.throws(() => parsePaymentIntentRequest({ recipient: RECIPIENT, amount, purpose: "Test" }));
    }
  });

  it("rejects unknown fields and validates headers and confirmation input", () => {
    assert.throws(() => parsePaymentIntentRequest({ recipient: RECIPIENT, amount: "1", purpose: "Test", actorSubject: "forged" }), /Unsupported/);
    assert.throws(() => parseIdempotencyKey("short"));
    assert.deepEqual(parseConfirmPaymentIntentRequest({ requestHash: "a".repeat(64), expectedVersion: "0" }), {
      requestHash: "a".repeat(64), expectedVersion: 0n,
    });
    assert.throws(() => parseConfirmPaymentIntentRequest({ requestHash: "A".repeat(64), expectedVersion: "0" }));
    assert.throws(() => parseConfirmPaymentIntentRequest({ requestHash: "a".repeat(64), expectedVersion: "0", amount: "2" }), /Unsupported/);
  });
});

describe("PaymentIntentService", () => {
  it("creates, reads, and replays a direct-wallet intent with canonical null purpose", async () => {
    const { service, payments } = await fixture();
    const first = await service.create(principal, createInput({ purpose: null }));
    const replay = await service.create(principal, createInput({ purpose: null }));
    assert.equal(first.paymentIntent.purpose, null);
    assert.equal((await service.find(principal, first.paymentIntent.id)).purpose, null);
    assert.equal((await payments.findPayment(first.paymentIntent.id))?.purpose, null);
    assert.equal(replay.created, false);
  });
  it("creates, serializes, replays, and rejects a changed idempotent request", async () => {
    const { service } = await fixture();
    const first = await service.create(principal, createInput());
    const replay = await service.create(principal, createInput());
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.paymentIntent.id, first.paymentIntent.id);
    assert.equal(first.paymentIntent.status, "awaiting_confirmation");
    assert.equal(first.paymentIntent.amountRaw, "1250000");
    assert.equal(first.paymentIntent.amount, "1.25");
    assert.equal(typeof first.paymentIntent.version, "string");
    await assert.rejects(() => service.create(principal, createInput({ amount: "2" })), (error) =>
      error instanceof PaymentIntentApplicationError && error.kind === "CONFLICT");
    assert.equal((await service.find(principal, first.paymentIntent.id)).amountRaw, "1250000");
  });

  it("denies missing, disabled, and expired allowlist entries", async () => {
    for (const options of [
      { allowlisted: false },
      { enabled: false },
      { revoked: true },
      { expiresAt: "2026-08-02T12:00:00.000Z" },
    ]) {
      const { account, service, servicePayments } = await fixture(options);
      const entry = await servicePayments.findAllowlistEntry(account.actorSubject);
      assert.equal(hasActivePaymentAccess(entry, NOW), false);
      await assert.rejects(() => service.create(principal, createInput()), (error) =>
        error instanceof PaymentIntentApplicationError && error.kind === "ACCESS_DENIED");
    }
    const { account, service, servicePayments } = await fixture({ expiresAt: LATER });
    assert.equal(hasActivePaymentAccess(await servicePayments.findAllowlistEntry(account.actorSubject), NOW), true);
    assert.equal((await service.create(principal, createInput())).created, true);
  });

  it("uses the same active-access predicate for confirmation", async () => {
    const { accounts, payments, service } = await fixture();
    const created = await service.create(principal, createInput());
    const revokedPayments = new Proxy(payments, {
      get(target, property) {
        if (property === "findAllowlistEntry") {
          return async (actorSubject: string) => {
            const current = await target.findAllowlistEntry(actorSubject);
            return current ? { ...current, enabled: false, revokedAt: NOW } : undefined;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const confirmationService = new PaymentIntentService(accounts, revokedPayments, { clock: () => NOW });
    await assert.rejects(() => confirmationService.confirm(principal, {
      paymentId: created.paymentIntent.id,
      requestHash: created.paymentIntent.requestHash,
      expectedVersion: 0n,
    }), (error) => error instanceof PaymentIntentApplicationError && error.kind === "ACCESS_DENIED");
    assert.equal((await payments.findPayment(created.paymentIntent.id))?.status, "AWAITING_CONFIRMATION");
  });

  it("enforces ownership while allowing actor-owned historical reads", async () => {
    const { service } = await fixture();
    const created = await service.create(principal, createInput());
    const other = { ...principal, providerSubject: "auth0|other" };
    await assert.rejects(() => service.find(other, created.paymentIntent.id), (error) =>
      error instanceof PaymentIntentApplicationError && error.kind === "NOT_FOUND");
  });

  it("confirms atomically once and treats matching duplicates as replay", async () => {
    const { service, payments } = await fixture();
    const created = await service.create(principal, createInput());
    const confirmation = {
      paymentId: created.paymentIntent.id,
      requestHash: created.paymentIntent.requestHash,
      expectedVersion: 0n,
      requestId: "request-0001",
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => service.confirm(principal, confirmation)));
    assert.equal(results.filter(({ applied }) => applied).length, 1);
    assert.equal(results.filter(({ applied }) => !applied).length, 19);
    const events = await payments.listPaymentEvents(created.paymentIntent.id);
    assert.equal(events.filter(({ eventType }) => eventType === "USER_CONFIRMED").length, 1);
    assert.equal(results[0].paymentIntent.status, "processing");
  });

  it("rejects mismatched hashes and stale awaiting versions without mutation", async () => {
    const { service, payments } = await fixture();
    const created = await service.create(principal, createInput());
    await assert.rejects(() => service.confirm(principal, {
      paymentId: created.paymentIntent.id, requestHash: "b".repeat(64), expectedVersion: 0n,
    }), (error) => error instanceof PaymentIntentApplicationError && error.kind === "CONFLICT");
    await assert.rejects(() => service.confirm(principal, {
      paymentId: created.paymentIntent.id, requestHash: created.paymentIntent.requestHash, expectedVersion: 1n,
    }), (error) => error instanceof PaymentIntentApplicationError && error.kind === "CONFLICT");
    assert.equal((await payments.findPayment(created.paymentIntent.id))?.status, "AWAITING_CONFIRMATION");
  });

  it("converges concurrent creates and permits different actors to share a key", async () => {
    const { service, accounts, payments } = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => service.create(principal, createInput())));
    assert.equal(results.filter(({ created }) => created).length, 1);
    const other = { ...principal, providerSubject: "auth0|two" };
    const otherAccount = (await accounts.resolve(other)).account;
    await payments.createAllowlistEntry({ actorSubject: otherAccount.actorSubject });
    assert.equal((await service.create(other, createInput())).created, true);
  });
});
