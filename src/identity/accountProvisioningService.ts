import { randomUUID } from "node:crypto";

import type { ExternalPrincipal } from "../auth/externalPrincipal";
import type { Account, ExternalIdentity } from "./identityTypes";
import type { IdentityPersistence } from "./identityStorageContracts";

export class AccountAccessDeniedError extends Error {}

export class AccountProvisioningService {
  constructor(private readonly persistence: IdentityPersistence) {}

  async resolve(principal: ExternalPrincipal): Promise<Readonly<{ account: Account; identities: ExternalIdentity[] }>> {
    const existing = await this.persistence.findAccountByExternalIdentity(
      principal.issuer,
      principal.providerSubject,
    );
    if (existing) return requireActive(existing);

    const provisioned = await this.persistence.provisionExternalIdentity({
      accountId: randomUUID(), identityId: randomUUID(),
      issuer: principal.issuer, subject: principal.providerSubject,
    });
    return requireActive({
      account: provisioned.account,
      identities: await this.persistence.listExternalIdentities(provisioned.account.accountId),
    });
  }
}

function requireActive(result: Readonly<{ account: Account; identities: ExternalIdentity[] }>) {
  if (result.account.status !== "ACTIVE") {
    throw new AccountAccessDeniedError("Canonical account is not active.");
  }
  return result;
}
