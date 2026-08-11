import type { Pool, QueryConfig } from "pg";

export const READINESS_DEADLINE_MS = 2_000;
export type ReadinessReason = "ready" | "local" | "shutting_down" | "saturated" | "timeout" | "unavailable";
export type ReadinessResult = Readonly<{ ready: boolean; reason: ReadinessReason }>;

type ReadinessPool = Pick<Pool, "query" | "idleCount" | "totalCount" | "options">;
type TimerHandle = ReturnType<typeof setTimeout>;

export class ReadinessService {
  private shuttingDown = false;
  private probe: Promise<boolean> | undefined;

  constructor(
    private readonly pool?: ReadinessPool,
    private readonly observe: (result: ReadinessResult) => void = () => undefined,
    private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle = setTimeout,
    private readonly cancel: (handle: TimerHandle) => void = clearTimeout,
  ) {}

  markShuttingDown(): void { this.shuttingDown = true; }

  async check(): Promise<ReadinessResult> {
    if (this.shuttingDown) return this.finish({ready:false,reason:"shutting_down"});
    if (!this.pool) return this.finish({ready:true,reason:"local"});
    if (!this.probe && this.pool.idleCount === 0 && this.pool.totalCount >= this.pool.options.max) {
      return this.finish({ready:false,reason:"saturated"});
    }
    const probe = this.probe ?? this.startProbe();
    const completed = await this.withDeadline(probe);
    if (completed === "timeout") return this.finish({ready:false,reason:"timeout"});
    return this.finish(completed ? {ready:true,reason:"ready"} : {ready:false,reason:"unavailable"});
  }

  private startProbe(): Promise<boolean> {
    const query:QueryConfig & {query_timeout:number}={text:"SELECT 1",query_timeout:READINESS_DEADLINE_MS};
    const probe = Promise.resolve(this.pool!.query(query))
      .then(()=>true,()=>false);
    this.probe = probe;
    void probe.then(()=>{if(this.probe===probe)this.probe=undefined;});
    return probe;
  }

  private withDeadline(probe: Promise<boolean>): Promise<boolean | "timeout"> {
    return new Promise((resolve)=>{
      let settled=false;
      const timer=this.schedule(()=>{if(!settled){settled=true;resolve("timeout");}},READINESS_DEADLINE_MS);
      (timer as TimerHandle & {unref?:()=>void}).unref?.();
      void probe.then((ready)=>{if(!settled){settled=true;this.cancel(timer);resolve(ready);}});
    });
  }

  private finish(result: ReadinessResult): ReadinessResult {
    try { this.observe(result); } catch { /* Readiness is not controlled by observability. */ }
    return Object.freeze(result);
  }
}
