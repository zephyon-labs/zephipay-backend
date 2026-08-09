import assert from "node:assert/strict";
import test from "node:test";

import { PaymentExecutionService } from "../src/executions/executionService";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { syntheticBetaIdentity } from "../src/recipients/syntheticBetaIdentity";
import { PaymentIntentApplicationError, PaymentIntentService } from "../src/services/paymentIntentService";
import { InMemoryExecutionRepository } from "../src/storage/memory/inMemoryExecutionRepository";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";

const NOW = "2026-08-09T12:00:00.000Z";
const principal = { issuer: "https://tenant.example/", providerSubject: "auth0|synthetic-lifecycle", scopes: ["read:payments", "write:payments"] } as const;

test("synthetic beta create, confirm, and execute uses trust-not-required and exact confirmed version", async () => {
  const accounts = new AccountProvisioningService(new InMemoryIdentityPersistence({ clock: () => NOW }));
  const payments = new InMemoryPaymentPersistence({ clock: () => NOW });
  const account = (await accounts.resolve(principal)).account;
  await payments.createAllowlistEntry({ actorSubject: account.actorSubject });
  const synthetic = syntheticBetaIdentity("Nova Beta");
  const syntheticStore = {
    findById: async (id: string) => id === synthetic.syntheticId ? synthetic : undefined,
    findByName: async () => synthetic,
    claim: async () => synthetic,
  };
  let nextId = 1;
  const intents = new PaymentIntentService(accounts, payments, {
    clock: () => NOW,
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    syntheticIdentityStore: syntheticStore,
  });
  const createInput = { idempotencyKey: "synthetic-lifecycle-key-0001", recipientType: "payment_identity" as const, recipientAccountId: synthetic.syntheticId, amount: "2", purpose: null };

  const created = await intents.create(principal, createInput);
  assert.equal(created.paymentIntent.version, "0");
  assert.equal(created.paymentIntent.recipientType, "payment_identity");
  if (created.paymentIntent.recipientType !== "payment_identity") assert.fail("Expected a Payment Identity intent.");
  assert.equal(created.paymentIntent.recipientSnapshot.identitySource, "synthetic_beta");
  assert.equal(created.paymentIntent.recipientSnapshot.trustOutcome, "not_required");

  const replay = await intents.create(principal, createInput);
  assert.equal(replay.created, false);
  assert.equal(replay.paymentIntent.id, created.paymentIntent.id);
  await assert.rejects(() => intents.create(principal, { ...createInput, amount: "3" }), (error) =>
    error instanceof PaymentIntentApplicationError && error.kind === "CONFLICT");

  const confirmed = await intents.confirm(principal, {
    paymentId: created.paymentIntent.id,
    requestHash: created.paymentIntent.requestHash,
    expectedVersion: BigInt(created.paymentIntent.version),
  });
  assert.equal(confirmed.applied, true);
  assert.equal(confirmed.paymentIntent.version, "1");

  const executionService = new PaymentExecutionService(accounts, payments, new InMemoryExecutionRepository(), () => NOW,
    () => "10000000-0000-4000-8000-000000000001");
  const executionInput = { requestHash: confirmed.paymentIntent.requestHash, expectedVersion: confirmed.paymentIntent.version };
  const results = await Promise.all(Array.from({ length: 10 }, () => executionService.execute(principal, confirmed.paymentIntent.id, executionInput)));
  assert.equal(results.filter(({ created: wasCreated }) => wasCreated).length, 1);
  assert.equal(new Set(results.map(({ execution }) => execution.executionId)).size, 1);

  await assert.rejects(() => intents.confirm(principal, {
    paymentId: created.paymentIntent.id,
    requestHash: "b".repeat(64),
    expectedVersion: 1n,
  }), (error) => error instanceof PaymentIntentApplicationError && error.kind === "CONFLICT");
});

test("canonical unverified Payment Identity still requires explicit acknowledgement", async () => {
  const accounts = new AccountProvisioningService(new InMemoryIdentityPersistence({ clock: () => NOW }));
  const payments = new InMemoryPaymentPersistence({ clock: () => NOW, resolvePaymentIdentity: async () => ({
    username: "canonical", displayName: "Canonical", accountType: "PERSONAL", verificationState: "UNVERIFIED",
    payabilityState: "AVAILABLE", destinationAddress: "11111111111111111111111111111111",
  }) });
  const account = (await accounts.resolve(principal)).account;
  await payments.createAllowlistEntry({ actorSubject: account.actorSubject });
  const service = new PaymentIntentService(accounts, payments, { clock: () => NOW });
  await assert.rejects(() => service.create(principal, {
    idempotencyKey: "canonical-trust-key-0001", recipientType: "payment_identity",
    recipientAccountId: "20000000-0000-4000-8000-000000000001", amount: "1", purpose: null,
  }), (error) => error instanceof PaymentIntentApplicationError && error.kind === "CONFLICT" && /acknowledgment/i.test(error.message));
});
