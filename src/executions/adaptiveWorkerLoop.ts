export const WORKER_POLL_DELAYS_MS = Object.freeze([100, 250, 500, 1_000, 2_000] as const);
export const RECONCILIATION_POLL_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000] as const);

type TimerHandle = ReturnType<typeof setTimeout>;

export class AdaptiveWorkerLoop {
  private timer: TimerHandle | undefined;
  private stopped = true;
  private delayIndex = 0;
  private active: Promise<void> | undefined;

  constructor(
    private readonly iteration: () => Promise<boolean>,
    private readonly observeDelay: (delayMs: number, outcome: "work" | "idle" | "failure") => void = () => undefined,
    private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle = setTimeout,
    private readonly cancel: (handle: TimerHandle) => void = clearTimeout,
    private readonly delays:readonly number[]=WORKER_POLL_DELAYS_MS,
  ) {if(delays.length===0||delays.some(value=>!Number.isInteger(value)||value<1))throw new Error("Worker polling delays are invalid.");}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.delayIndex = 0;
    this.scheduleNext(this.delays[this.delayIndex]);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.active;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.schedule(() => {
      const active=this.run();this.active=active;
      void active.then(()=>{if(this.active===active)this.active=undefined;},()=>{if(this.active===active)this.active=undefined;});
    }, delayMs);
    (this.timer as TimerHandle & { unref?: () => void }).unref?.();
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    let outcome: "work" | "idle" | "failure";
    try {
      outcome = await this.iteration() ? "work" : "idle";
    } catch {
      outcome = "failure";
    }
    if (this.stopped) return;
    this.delayIndex = outcome === "work"
      ? 0
      : Math.min(this.delayIndex + 1, this.delays.length - 1);
    const delayMs = this.delays[this.delayIndex];
    try { this.observeDelay(delayMs, outcome); } catch { /* Observability cannot stop polling. */ }
    this.scheduleNext(delayMs);
  }
}
