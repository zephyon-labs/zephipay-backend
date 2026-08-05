import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AccountProvisioningService } from "../src/identity/accountProvisioningService";
import { RecipientDirectoryService, serializePublicRecipient } from "../src/recipients/recipientDirectoryService";
import { InMemoryEconomicIdentityPersistence } from "../src/storage/memory/inMemoryEconomicIdentityPersistence";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";

const issuer = "https://tenant.example/";
const WALLET = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const principal = (subject: string) => ({ issuer, providerSubject: subject, scopes: [] });

async function fixture(options: { discoverability?: "PRIVATE" | "USERNAME_ONLY" | "PUBLIC"; available?: boolean; status?: "ACTIVE" | "SUSPENDED" } = {}) {
  const canonical = new InMemoryIdentityPersistence();
  const accounts = new AccountProvisioningService(canonical);
  const requester = (await accounts.resolve(principal("requester"))).account;
  let recipient = (await accounts.resolve(principal("recipient"))).account;
  const economic = new InMemoryEconomicIdentityPersistence({ accountExists: async (id) => Boolean(await canonical.findAccount(id)) });
  let identity = (await economic.upsertEconomicIdentity({
    accountId: recipient.accountId, accountType: "PERSONAL", username: "Recipient_01",
    normalizedUsername: "recipient_01", displayName: "Recipient Example",
    discoverability: options.discoverability ?? "USERNAME_ONLY",
  })).identity;
  if (options.available !== false) identity = await economic.updateEconomicIdentityState({
    accountId: recipient.accountId, expectedVersion: identity.version, publicIdentityStatus: "ACTIVE",
    verificationState: "UNVERIFIED", payabilityState: "AVAILABLE",
  });
  const destination = (await economic.upsertSolanaDestination({
    destinationId: "00000000-0000-4000-8000-000000000901", accountId: recipient.accountId,
    address: WALLET, primary: true,
  })).destination;
  if (options.status === "SUSPENDED") recipient = await canonical.updateAccountStatus({
    accountId: recipient.accountId, expectedVersion: recipient.version, status: "SUSPENDED",
  });
  return { canonical, accounts, economic, requester, recipient, identity, destination,
    directory: new RecipientDirectoryService(canonical, economic) };
}

describe("recipient directory", () => {
  it("performs exact case-insensitive username lookup with a one-result bound", async () => {
    const { directory, requester, recipient } = await fixture();
    const results = await directory.searchExactUsername(requester.accountId, " RECIPIENT_01 ");
    assert.equal(results.length, 1);
    assert.equal(results[0].accountId, recipient.accountId);
    assert.deepEqual(await directory.searchExactUsername(requester.accountId, "missing_01"), []);
  });

  it("excludes private, unavailable, inactive, and self recipients with uniform misses", async () => {
    for (const options of [
      { discoverability: "PRIVATE" as const },
      { available: false },
      { status: "SUSPENDED" as const },
    ]) {
      const { directory, requester } = await fixture(options);
      assert.deepEqual(await directory.searchExactUsername(requester.accountId, "recipient_01"), []);
    }
    const { directory, recipient } = await fixture();
    assert.deepEqual(await directory.searchExactUsername(recipient.accountId, "recipient_01"), []);
  });

  it("returns only the approved public field allowlist", async () => {
    const { directory, requester } = await fixture();
    const [recipient] = await directory.searchExactUsername(requester.accountId, "recipient_01");
    const serialized = JSON.stringify(serializePublicRecipient(recipient));
    assert.deepEqual(Object.keys(serializePublicRecipient(recipient)).sort(), [
      "accountId", "accountType", "displayName", "payabilityState", "username", "verificationState",
    ]);
    for (const forbidden of ["wallet", "address", "email", "issuer", "subject", "actorSubject", "allowlist", "version", "trust"]) {
      assert.doesNotMatch(serialized.toLowerCase(), new RegExp(forbidden.toLowerCase()));
    }
  });

  it("freshly revalidates canonical account, discoverability, and payability", async () => {
    const { directory, requester, recipient, economic, identity } = await fixture();
    assert.equal((await directory.resolvePublicRecipient(requester.accountId, recipient.accountId)).accountId, recipient.accountId);
    await economic.updateEconomicIdentityState({
      accountId: recipient.accountId, expectedVersion: identity.version,
      publicIdentityStatus: "ACTIVE", verificationState: "UNVERIFIED", payabilityState: "UNAVAILABLE",
    });
    await assert.rejects(() => directory.resolvePublicRecipient(requester.accountId, recipient.accountId), /not found/);
  });

  it("resolves an eligible primary destination only through the backend-only method", async () => {
    const { directory, requester, recipient, economic, destination } = await fixture();
    const resolved = await directory.resolvePaymentDestination(requester.accountId, recipient.accountId);
    assert.equal(resolved.destination.address, WALLET);
    await economic.updatePaymentDestinationState({
      destinationId: destination.destinationId, accountId: recipient.accountId,
      expectedVersion: destination.version, status: "INACTIVE", ownershipState: "UNVERIFIED",
    });
    await assert.rejects(() => directory.resolvePaymentDestination(requester.accountId, recipient.accountId), /not found/);
  });

  it("rejects blank, wildcard, malformed, and non-exact username queries", async () => {
    const { directory, requester } = await fixture();
    for (const query of ["", "   ", "*", "recip*", "recipient-01", "ab"]) {
      await assert.rejects(() => directory.searchExactUsername(requester.accountId, query));
    }
  });
});
