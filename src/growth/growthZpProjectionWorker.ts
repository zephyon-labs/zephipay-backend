import {
  AdaptiveWorkerLoop,
  RECONCILIATION_POLL_DELAYS_MS,
} from "../executions/adaptiveWorkerLoop";
import type { PaymentSettlementGrowthProjectionResult } from "./paymentSettlementGrowthProjector";
import type { ZpProjectionResult, ZpStateRepository } from "./zpState";

export const GROWTH_PROJECTION_BATCH_LIMIT = 100;
export const ZP_ACCOUNT_BATCH_LIMIT = 100;
export const ZP_EVENT_BATCH_LIMIT = 100;

export type GrowthZpProjectionConfiguration = Readonly<{
  growthEnabled: boolean;
  zpEnabled: boolean;
}>;

type GrowthProjector = Readonly<{
  projectPending(
    limit: number,
  ): Promise<PaymentSettlementGrowthProjectionResult[]>;
}>;

type ZpProjector = Pick<
  ZpStateRepository,
  "listPendingAccounts" | "projectAccount"
>;

export type GrowthZpProjectionOutcome = Readonly<{
  growthEnabled: boolean;
  growthProjectedReceipts: number;
  growthFailed: boolean;
  zpEnabled: boolean;
  zpDiscoveredAccounts: number;
  zpProjectedAccounts: number;
  zpProcessedEvents: number;
  zpFailedAccounts: number;
  zpDiscoveryFailed: boolean;
  durationMs: number;
}>;

export class GrowthZpProjectionCoordinator {
  constructor(
    private readonly growth: GrowthProjector,
    private readonly zp: ZpProjector,
    private readonly configuration: GrowthZpProjectionConfiguration,
  ) {}

  async runOnce(): Promise<GrowthZpProjectionOutcome> {
    const started = performance.now();
    let growthProjectedReceipts = 0;
    let growthFailed = false;
    let zpDiscoveredAccounts = 0;
    let zpProjectedAccounts = 0;
    let zpProcessedEvents = 0;
    let zpFailedAccounts = 0;
    let zpDiscoveryFailed = false;

    if (this.configuration.growthEnabled) {
      try {
        growthProjectedReceipts = (
          await this.growth.projectPending(GROWTH_PROJECTION_BATCH_LIMIT)
        ).length;
      } catch {
        growthFailed = true;
      }
    }

    if (this.configuration.zpEnabled) {
      let accounts: string[] = [];

      try {
        accounts = await this.zp.listPendingAccounts(
          ZP_ACCOUNT_BATCH_LIMIT,
        );
        zpDiscoveredAccounts = accounts.length;
      } catch {
        zpDiscoveryFailed = true;
      }

      for (const accountId of accounts) {
        try {
          const result: ZpProjectionResult =
            await this.zp.projectAccount(
              accountId,
              ZP_EVENT_BATCH_LIMIT,
            );
          zpProjectedAccounts += 1;
          zpProcessedEvents += result.processedEvents;
        } catch {
          zpFailedAccounts += 1;
        }
      }
    }

    return Object.freeze({
      growthEnabled: this.configuration.growthEnabled,
      growthProjectedReceipts,
      growthFailed,
      zpEnabled: this.configuration.zpEnabled,
      zpDiscoveredAccounts,
      zpProjectedAccounts,
      zpProcessedEvents,
      zpFailedAccounts,
      zpDiscoveryFailed,
      durationMs: Math.max(
        0,
        Math.round((performance.now() - started) * 100) / 100,
      ),
    });
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export class GrowthZpProjectionWorker {
  private readonly enabled: boolean;
  private readonly loop: AdaptiveWorkerLoop;

  constructor(
    coordinator: GrowthZpProjectionCoordinator,
    configuration: GrowthZpProjectionConfiguration,
    observeOutcome: (outcome: GrowthZpProjectionOutcome) => void = () => undefined,
    observeDelay: (
      delayMs: number,
      outcome: "work" | "idle" | "failure",
    ) => void = () => undefined,
    schedule: (
      callback: () => void,
      delayMs: number,
    ) => TimerHandle = setTimeout,
    cancel: (handle: TimerHandle) => void = clearTimeout,
  ) {
    this.enabled = configuration.growthEnabled || configuration.zpEnabled;
    this.loop = new AdaptiveWorkerLoop(
      async () => {
        const outcome = await coordinator.runOnce();

        try {
          observeOutcome(outcome);
        } catch {
          // Observability is never authoritative.
        }

        if (
          outcome.growthFailed ||
          outcome.zpDiscoveryFailed ||
          outcome.zpFailedAccounts > 0
        ) {
          throw new Error("Downstream Growth/ZP projection iteration failed.");
        }

        return (
          outcome.growthProjectedReceipts > 0 ||
          outcome.zpDiscoveredAccounts > 0 ||
          outcome.zpProcessedEvents > 0
        );
      },
      observeDelay,
      schedule,
      cancel,
      RECONCILIATION_POLL_DELAYS_MS,
    );
  }

  start(): void {
    if (this.enabled) {
      this.loop.start();
    }
  }

  stop(): void {
    this.loop.stop();
  }

  stopAndDrain(): Promise<void> {
    return this.loop.stopAndDrain();
  }
}
