import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExternalPrincipal } from "../src/auth/externalPrincipal";
import { AccountAccessDeniedError, AccountProvisioningService } from "../src/identity/accountProvisioningService";
import type { IdentityPersistence } from "../src/identity/identityStorageContracts";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const issuer = "https://tenant.example/";
const principal = (overrides: Partial<ExternalPrincipal> = {}): ExternalPrincipal => ({
  issuer,
  providerSubject: "stable-subject",
  email: "first@example.invalid",
  emailVerified: false,
  scopes: [],
  ...overrides,
});

class CountingIdentityPersistence extends InMemoryIdentityPersistence {
  fastPathLookups = 0;
  provisioningCalls = 0;

  override async findAccountByExternalIdentity(lookupIssuer: string, subject: string) {
    this.fastPathLookups += 1;
    return super.findAccountByExternalIdentity(lookupIssuer, subject);
  }

  override provisionExternalIdentity(input: Parameters<IdentityPersistence["provisionExternalIdentity"]>[0]) {
    this.provisioningCalls += 1;
    return super.provisionExternalIdentity(input);
  }
}

describe("returning account fast path", () => {
  it("uses the authoritative lookup and never re-enters provisioning for a known identity", async () => {
    const persistence = new CountingIdentityPersistence();
    const service = new AccountProvisioningService(persistence);
    const first = await service.resolve(principal());
    const returned = await service.resolve(principal({ email: "changed@example.invalid", emailVerified: true }));

    assert.equal(returned.account.accountId, first.account.accountId);
    assert.equal(returned.account.actorSubject, first.account.actorSubject);
    assert.equal(persistence.fastPathLookups, 2);
    assert.equal(persistence.provisioningCalls, 1, "returning resolution must not acquire the provisioning path");
    assert.equal(returned.identities.length, 1);
  });

  it("keeps concurrent first-login convergence and authoritative account status checks", async () => {
    const persistence = new CountingIdentityPersistence();
    const service = new AccountProvisioningService(persistence);
    const results = await Promise.all(Array.from({ length: 12 }, () => service.resolve(principal())));
    assert.equal(new Set(results.map(({ account }) => account.accountId)).size, 1);

    const account = results[0].account;
    await persistence.updateAccountStatus({
      accountId: account.accountId,
      expectedVersion: account.version,
      status: "SUSPENDED",
    });
    await assert.rejects(() => service.resolve(principal()), AccountAccessDeniedError);
  });
});
