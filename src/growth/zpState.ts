import { ZP_POLICY_VERSION } from "./zpPolicy";

export type AccountZpState = Readonly<{
  accountId: string;
  policyVersion: typeof ZP_POLICY_VERSION;
  totalPoints: bigint;
  sentCount: bigint;
  receivedCount: bigint;
  lastGrowthEventId: bigint;
  updatedAt: string;
}>;

export type ZpProjectionResult = Readonly<{
  accountId: string;
  processedEvents: number;
  priorLastGrowthEventId: bigint;
  lastGrowthEventId: bigint;
  totalPoints: bigint;
  sentCount: bigint;
  receivedCount: bigint;
}>;

export interface ZpStateRepository {
  find(accountId: string): Promise<AccountZpState | undefined>;

  listPendingAccounts(limit: number): Promise<string[]>;

  projectAccount(
    accountId: string,
    limit?: number,
  ): Promise<ZpProjectionResult>;
}
