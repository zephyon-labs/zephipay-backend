export const OPEN_BETA_EPOCH = "OPEN_BETA" as const;

export type OpenBetaActivityAggregate = Readonly<{
  betaTesters: number;
  paymentsCompleted: number;
  mockUsdcAmountRaw: string;
  durableReceipts: number;
  executionsInitiated: number;
  executionsSettled: number;
}>;

export interface OpenBetaActivityRepository {
  aggregate(epochName: typeof OPEN_BETA_EPOCH): Promise<OpenBetaActivityAggregate>;
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

    const aggregate = await this.repository.aggregate(OPEN_BETA_EPOCH);
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
    });
    this.cached = Object.freeze({ expiresAt: now.getTime() + this.ttlMs, value });
    return value;
  }
}
