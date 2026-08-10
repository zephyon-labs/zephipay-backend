import assert from "node:assert/strict";
import test from "node:test";

import type { ExternalPrincipal } from "../src/auth/externalPrincipal";
import { EconomicIdentityService } from "../src/economicIdentity/economicIdentityService";
import { PaymentExecutionService } from "../src/executions/executionService";
import { PaymentExecutionWorker } from "../src/executions/executionWorker";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { PaymentIntentService } from "../src/services/paymentIntentService";
import { InMemoryEconomicIdentityPersistence } from "../src/storage/memory/inMemoryEconomicIdentityPersistence";
import { InMemoryExecutionRepository } from "../src/storage/memory/inMemoryExecutionRepository";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";
import { InMemoryPaymentPersistence } from "../src/storage/memory/inMemoryPaymentPersistence";

const NOW = "2026-08-09T22:20:00.000Z";
const issuer = "https://tenant.example/";
const firstSession: ExternalPrincipal = Object.freeze({
  issuer, providerSubject: "stable-provider-subject", email: "first@example.invalid",
  emailVerified: false, scopes: Object.freeze(["read:account", "read:payments", "write:payments"]),
});
const verifiedReturn: ExternalPrincipal = Object.freeze({
  issuer, providerSubject: "stable-provider-subject", email: "changed@example.invalid",
  emailVerified: true, scopes: Object.freeze(["read:account", "read:payments", "write:payments"]),
});

test("external tester journey preserves one account, history, receipts, and identity across verification and login", async () => {
  const identities = new InMemoryIdentityPersistence({ clock: () => NOW });
  const accounts = new AccountProvisioningService(identities);
  const economicStore = new InMemoryEconomicIdentityPersistence({
    clock: () => NOW,
    accountExists: async (accountId) => Boolean(await identities.findAccount(accountId)),
  });
  const economic = new EconomicIdentityService(accounts, economicStore);
  const payments = new InMemoryPaymentPersistence({ clock: () => NOW });
  const intents = new PaymentIntentService(accounts, payments, { clock: () => NOW });
  const executions = new InMemoryExecutionRepository();
  const executionService = new PaymentExecutionService(accounts, payments, executions, () => NOW);
  const worker = new PaymentExecutionWorker(payments, executions, "returning-user-worker", "immediate_settled", () => NOW);

  const firstAccount = (await accounts.resolve(firstSession)).account;
  assert.equal((await economic.getCurrent(firstSession)).identity, undefined, "skip is represented by authoritative absence");
  await payments.createAllowlistEntry({ actorSubject: firstAccount.actorSubject });

  const settle = async (principal: ExternalPrincipal, idempotencyKey: string, amount: string) => {
    const created = await intents.create(principal, {
      idempotencyKey, recipient: "11111111111111111111111111111111", amount, purpose: "Returning-user regression",
    });
    const confirmed = await intents.confirm(principal, {
      paymentId: created.paymentIntent.id, requestHash: created.paymentIntent.requestHash,
      expectedVersion: BigInt(created.paymentIntent.version),
    });
    const one = await executionService.execute(principal, created.paymentIntent.id, {
      requestHash: confirmed.paymentIntent.requestHash, expectedVersion: confirmed.paymentIntent.version,
    });
    const replay = await executionService.execute(principal, created.paymentIntent.id, {
      requestHash: confirmed.paymentIntent.requestHash, expectedVersion: confirmed.paymentIntent.version,
    });
    assert.equal(replay.execution.executionId, one.execution.executionId);
    await worker.processNext();
    await worker.reconcileNext();
    return { paymentIntentId: created.paymentIntent.id, executionId: one.execution.executionId };
  };

  const firstPayment = await settle(firstSession, "returning-user-first-payment", "1");
  const returnedAccount = (await accounts.resolve(verifiedReturn)).account;
  assert.equal(returnedAccount.accountId, firstAccount.accountId);
  assert.equal(returnedAccount.actorSubject, firstAccount.actorSubject);
  assert.equal((await identities.listExternalIdentities(firstAccount.accountId)).length, 1);
  assert.equal((await economic.getCurrent(verifiedReturn)).identity, undefined);
  assert.equal((await executionService.activity(verifiedReturn, 20)).length, 1);
  assert.equal((await executionService.receipt(verifiedReturn, firstPayment.paymentIntentId)).executionId, firstPayment.executionId);

  const createdIdentity = await economic.upsertCurrent(verifiedReturn, {
    username: "returning_user", displayName: "Returning User", discoverability: "PRIVATE",
  });
  assert.equal(createdIdentity.created, true);
  assert.equal((await economic.getCurrent(firstSession)).identity?.accountId, firstAccount.accountId);

  const secondPayment = await settle(verifiedReturn, "returning-user-second-payment", "2");
  const activity = await executionService.activity(firstSession, 20);
  assert.equal(activity.length, 2);
  assert.equal(new Set(activity.map((item) => item.executionId)).size, 2);
  assert.equal((await executionService.receipt(firstSession, secondPayment.paymentIntentId)).executionId, secondPayment.executionId);
  assert.equal((await identities.listExternalIdentities(firstAccount.accountId)).length, 1);
});
