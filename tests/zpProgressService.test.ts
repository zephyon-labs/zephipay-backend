import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExternalPrincipal } from "../src/auth/externalPrincipal";
import { ZpProgressService } from "../src/growth/zpProgressService";
import type { AccountZpState } from "../src/growth/zpState";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const PRINCIPAL: ExternalPrincipal = Object.freeze({
  issuer: "https://tenant.example/",
  providerSubject: "auth0|zp-service-owner",
  scopes: Object.freeze(["read:account"]),
});

describe("current-account ZP progress service", () => {
  it("returns an honest zero projection without writing when state is absent", async () => {
    const accounts = new AccountProvisioningService(
      new InMemoryIdentityPersistence(),
    );
    let reads = 0;
    const service = new ZpProgressService(accounts, {
      async find() {
        reads += 1;
        return undefined;
      },
    });

    assert.deepEqual(await service.getCurrent(PRINCIPAL), zeroProjection());
    assert.equal(reads, 1);
  });

  it("returns only the exact public projection for existing durable state", async () => {
    const identities = new InMemoryIdentityPersistence();
    const accounts = new AccountProvisioningService(identities);
    const account = (await accounts.resolve(PRINCIPAL)).account;
    const durable: AccountZpState = Object.freeze({
      accountId: account.accountId,
      policyVersion: 1,
      totalPoints: 9_007_199_254_740_993n,
      sentCount: 10n,
      receivedCount: 1n,
      lastGrowthEventId: 500n,
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    const service = new ZpProgressService(accounts, {
      async find(accountId) {
        assert.equal(accountId, account.accountId);
        return durable;
      },
    });

    assert.deepEqual(await service.getCurrent(PRINCIPAL), {
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
    });
  });

  it("fails closed for unsupported durable policy versions", async () => {
    const accounts = new AccountProvisioningService(
      new InMemoryIdentityPersistence(),
    );
    const unsupported = {
      accountId: "11111111-1111-4111-8111-111111111111",
      policyVersion: 2,
      totalPoints: 0n,
      sentCount: 0n,
      receivedCount: 0n,
      lastGrowthEventId: 0n,
      updatedAt: "2026-08-20T12:00:00.000Z",
    } as unknown as AccountZpState;
    const service = new ZpProgressService(accounts, {
      async find() {
        return unsupported;
      },
    });

    await assert.rejects(
      service.getCurrent(PRINCIPAL),
      /policy version is unsupported/,
    );
  });

  it("propagates repository failures instead of fabricating zero state", async () => {
    const accounts = new AccountProvisioningService(
      new InMemoryIdentityPersistence(),
    );
    const failure = new Error("private database detail");
    const service = new ZpProgressService(accounts, {
      async find() {
        throw failure;
      },
    });

    await assert.rejects(
      service.getCurrent(PRINCIPAL),
      (error) => error === failure,
    );
  });
});

function zeroProjection() {
  return {
    totalPoints: "0",
    sentCount: "0",
    receivedCount: "0",
    policyVersion: 1,
    unlockedMilestones: [],
    pendingMilestones: [
      {
        milestone: "FIRST_PAYMENT_SENT",
        dimension: "SENT",
        current: "0",
        target: "1",
        progressPercent: 0,
      },
      {
        milestone: "FIRST_PAYMENT_RECEIVED",
        dimension: "RECEIVED",
        current: "0",
        target: "1",
        progressPercent: 0,
      },
      {
        milestone: "TEN_PAYMENTS_SENT",
        dimension: "SENT",
        current: "0",
        target: "10",
        progressPercent: 0,
      },
      {
        milestone: "TWENTY_FIVE_PAYMENTS_SENT",
        dimension: "SENT",
        current: "0",
        target: "25",
        progressPercent: 0,
      },
    ],
  };
}
