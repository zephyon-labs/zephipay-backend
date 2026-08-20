import type { ExternalPrincipal } from "../auth/externalPrincipal";
import type { AccountProvisioningService } from "../identity/accountProvisioningService";
import { ZP_POLICY_VERSION } from "./zpPolicy";
import {
  projectZpProgress,
  type PublicZpProgress,
} from "./zpProgress";
import type {
  AccountZpState,
  ZpStateRepository,
} from "./zpState";

export class ZpProgressService {
  constructor(
    private readonly accounts: AccountProvisioningService,
    private readonly states: Pick<ZpStateRepository, "find">,
  ) {}

  async getCurrent(
    principal: ExternalPrincipal,
  ): Promise<PublicZpProgress> {
    const account = (await this.accounts.resolve(principal)).account;
    const state = await this.states.find(account.accountId);

    return projectZpProgress(
      state ?? zeroState(account.accountId),
    );
  }
}

function zeroState(accountId: string): AccountZpState {
  return Object.freeze({
    accountId,
    policyVersion: ZP_POLICY_VERSION,
    totalPoints: 0n,
    sentCount: 0n,
    receivedCount: 0n,
    lastGrowthEventId: 0n,
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}
