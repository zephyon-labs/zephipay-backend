import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EconomicIdentityService } from "../src/economicIdentity/economicIdentityService";
import {
  EconomicIdentityInputError,
  normalizeUsername,
  validateDisplayName,
  validateUsername,
} from "../src/economicIdentity/economicIdentityValidation";
import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { InMemoryEconomicIdentityPersistence } from "../src/storage/memory/inMemoryEconomicIdentityPersistence";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const issuer = "https://tenant.example/";
const NOW = "2026-08-05T12:00:00.000Z";
const WALLET_A = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const WALLET_B = "4Nd1mYwRkXkYtGT7dQz4FzRzCQXDpGfVv3YJz7drGqPv";

async function fixture() {
  const canonical = new InMemoryIdentityPersistence({ clock: () => NOW });
  const accounts = new AccountProvisioningService(canonical);
  const economic = new InMemoryEconomicIdentityPersistence({
    clock: () => NOW,
    accountExists: async (accountId) => Boolean(await canonical.findAccount(accountId)),
  });
  return { canonical, accounts, economic, service: new EconomicIdentityService(accounts, economic) };
}

const principal = (subject: string) => ({ issuer, providerSubject: subject, scopes: ["read:account"] });
const identityInput = (overrides: Record<string, unknown> = {}) => ({
  username: "Alice_01", displayName: "Alice Example", discoverability: "PRIVATE", ...overrides,
});

describe("economic identity validation", () => {
  it("normalizes conservative ASCII usernames and rejects unsafe or deceptive values", () => {
    assert.equal(normalizeUsername(" Alice_01 "), "alice_01");
    assert.deepEqual(validateUsername("Alice_01"), { username: "Alice_01", normalizedUsername: "alice_01" });
    for (const value of ["ab", "a".repeat(31), "1alice", "alice-name", "álîce", "admin", "zephipay", "zp:account:test", WALLET_A]) {
      assert.throws(() => validateUsername(value), EconomicIdentityInputError);
    }
  });

  it("bounds and normalizes display names without making them lookup keys", () => {
    assert.equal(validateDisplayName("  Alice   Example  "), "Alice Example");
    for (const value of ["", " ", "a".repeat(81), "bad\u0000name"]) assert.throws(() => validateDisplayName(value));
  });
});

describe("economic identity service", () => {
  it("creates optional private identity with honest safe defaults", async () => {
    const { service } = await fixture();
    const before = await service.getCurrent(principal("alice"));
    assert.equal(before.identity, undefined);
    const created = await service.upsertCurrent(principal("alice"), identityInput());
    assert.equal(created.created, true);
    assert.equal(created.identity.normalizedUsername, "alice_01");
    assert.equal(created.identity.accountType, "PERSONAL");
    assert.equal(created.identity.discoverability, "PRIVATE");
    assert.equal(created.identity.verificationState, "UNVERIFIED");
    assert.equal(created.identity.payabilityState, "UNAVAILABLE");
    assert.equal(created.identity.version, 0n);
  });

  it("rejects identity access for inactive canonical accounts", async () => {
    const { accounts, canonical, service } = await fixture();
    const account = (await accounts.resolve(principal("inactive"))).account;
    await canonical.updateAccountStatus({ accountId: account.accountId, expectedVersion: account.version, status: "SUSPENDED" });
    await assert.rejects(() => service.upsertCurrent(principal("inactive"), identityInput()), /unavailable/);
  });

  it("updates only the authenticated account with optimistic concurrency", async () => {
    const { service } = await fixture();
    await service.upsertCurrent(principal("alice"), identityInput());
    await service.upsertCurrent(principal("bob"), identityInput({ username: "bob_01", displayName: "Bob" }));
    const updated = await service.upsertCurrent(principal("alice"), identityInput({ expectedVersion: "0", displayName: "Alice Two", discoverability: "USERNAME_ONLY" }));
    assert.equal(updated.identity.displayName, "Alice Two");
    assert.equal(updated.identity.version, 1n);
    await assert.rejects(() => service.upsertCurrent(principal("alice"), identityInput({ expectedVersion: "0" })), /stale/);
    assert.equal((await service.getCurrent(principal("bob"))).identity?.displayName, "Bob");
  });

  it("enforces case-insensitive username uniqueness under concurrency", async () => {
    const { service } = await fixture();
    const results = await Promise.allSettled([
      service.upsertCurrent(principal("one"), identityInput({ username: "Shared_Name" })),
      service.upsertCurrent(principal("two"), identityInput({ username: "shared_name" })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /unavailable/);
  });

  it("rejects mass assignment of verification, payability, and account linkage", async () => {
    const { service } = await fixture();
    for (const field of ["accountType", "verificationState", "payabilityState", "publicIdentityStatus", "accountId", "actorSubject", "email", "createdAt", "updatedAt"]) {
      await assert.rejects(() => service.upsertCurrent(principal("alice"), identityInput({ [field]: "VERIFIED" })), /Unsupported/);
    }
  });

  it("creates canonical Solana destinations without claiming ownership", async () => {
    const { service } = await fixture();
    const created = await service.upsertSolanaDestination(principal("alice"), { address: WALLET_A, primary: true });
    assert.equal(created.destination.ownershipState, "UNVERIFIED");
    assert.equal(created.destination.status, "ACTIVE");
    assert.equal(created.destination.primary, true);
    await assert.rejects(() => service.upsertSolanaDestination(principal("alice"), { address: "bad", primary: true }), /canonical Solana/);
  });

  it("prevents duplicate wallets globally and enforces one primary per account", async () => {
    const { service } = await fixture();
    await service.upsertSolanaDestination(principal("alice"), { address: WALLET_A, primary: true });
    await assert.rejects(() => service.upsertSolanaDestination(principal("bob"), { address: WALLET_A, primary: true }), /conflicts/);
    const second = await service.upsertSolanaDestination(principal("alice"), { address: WALLET_B, primary: true });
    const current = await service.getCurrent(principal("alice"));
    assert.equal(current.destinations.filter((destination) => destination.primary).length, 1);
    assert.equal(current.destinations.find((destination) => destination.primary)?.destinationId, second.destination.destinationId);
  });
});
