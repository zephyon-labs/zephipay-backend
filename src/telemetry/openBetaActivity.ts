export const OPEN_BETA_EPOCH = "OPEN_BETA" as const;

export type OpenBetaActivityAggregate = Readonly<{
  betaTesters: number;
  paymentsCompleted: number;
  mockUsdcAmountRaw: string;
  durableReceipts: number;
  executionsInitiated: number;
  executionsSettled: number;
}>;

export type DevnetQaAggregate = Readonly<{
  totalLiveRuns: number;
  passed: number;
  failed: number;
  latestResult: "RUNNING" | "PASSED" | "FAILED" | null;
  latestActorFlow: "H2H" | null;
  latestCanonicalPaymentFlow: "P2P" | null;
  invariantViolationCount: number;
  latestDurationMs: number | null;
  latestAt: string | null;
}>;

export interface OpenBetaActivityRepository {
  aggregate(epochName: typeof OPEN_BETA_EPOCH): Promise<OpenBetaActivityAggregate>;
  aggregateDevnetQa(): Promise<DevnetQaAggregate>;
}

export type PublicOpenBetaActivity = Readonly<{
  scope: "open_beta";
  rail: "mock";
  settlement: "simulated";
  generatedAt: string;
  betaTesters: number;
  paymentsCompleted: number;
  mockUsdcProcessed: Readonly<{ amountRaw: string; decimals: 6 }>;
  durableReceipts: number;
  paymentCompletionRate: Readonly<{
    completed: number;
    initiated: number;
    basisPoints: number | null;
  }>;
  devnetQa: DevnetQaAggregate;
}>;

export class OpenBetaActivityService {
  private cached?: Readonly<{ expiresAt: number; value: PublicOpenBetaActivity }>;

  constructor(
    private readonly repository: OpenBetaActivityRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 30_000,
  ) {}

  async read(): Promise<PublicOpenBetaActivity> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt > now.getTime()) return this.cached.value;

    const [aggregate, devnetQa] = await Promise.all([
      this.repository.aggregate(OPEN_BETA_EPOCH),
      this.repository.aggregateDevnetQa(),
    ]);
    const basisPoints = aggregate.executionsInitiated === 0
      ? null
      : Math.floor((aggregate.executionsSettled * 10_000) / aggregate.executionsInitiated);
    const value = Object.freeze({
      scope: "open_beta" as const,
      rail: "mock" as const,
      settlement: "simulated" as const,
      generatedAt: now.toISOString(),
      betaTesters: aggregate.betaTesters,
      paymentsCompleted: aggregate.paymentsCompleted,
      mockUsdcProcessed: Object.freeze({ amountRaw: aggregate.mockUsdcAmountRaw, decimals: 6 as const }),
      durableReceipts: aggregate.durableReceipts,
      paymentCompletionRate: Object.freeze({
        completed: aggregate.executionsSettled,
        initiated: aggregate.executionsInitiated,
        basisPoints,
      }),
      devnetQa,
    });
    this.cached = Object.freeze({ expiresAt: now.getTime() + this.ttlMs, value });
    return value;
  }
}
