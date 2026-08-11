export const SHUTDOWN_DEADLINE_MS = 20_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type HttpServer = Readonly<{
  close(callback: (error?: Error) => void): void;
  closeAllConnections?: () => void;
}>;
type WorkerDrain = Readonly<{ stopAndDrain(): Promise<void> }>;
type PoolDrain = Readonly<{ end(): Promise<void> }>;

export class GracefulShutdownCoordinator {
  private shutdownPromise: Promise<void> | undefined;
  private poolEndPromise: Promise<void> | undefined;

  constructor(
    private readonly readiness: Readonly<{markShuttingDown():void}>,
    private readonly worker: WorkerDrain,
    private readonly server: HttpServer,
    private readonly pool: PoolDrain | undefined,
    private readonly observe: (event:"start"|"complete"|"timeout"|"failure",signal:string)=>void=()=>undefined,
    private readonly forceExit: (code:number)=>void=(code)=>process.exit(code),
    private readonly schedule: (callback:()=>void,delayMs:number)=>TimerHandle=setTimeout,
    private readonly cancel: (handle:TimerHandle)=>void=clearTimeout,
  ) {}

  shutdown(signal: string): Promise<void> {
    return this.shutdownPromise ??= this.run(signal);
  }

  private async run(signal:string):Promise<void>{
    this.readiness.markShuttingDown();
    this.safeObserve("start",signal);
    const workerDrain=this.worker.stopAndDrain();
    const httpDrain=this.closeServer();
    let deadline!:TimerHandle;
    const timedOut=new Promise<"timeout">((resolve)=>{
      deadline=this.schedule(()=>resolve("timeout"),SHUTDOWN_DEADLINE_MS);
      (deadline as TimerHandle & {unref?:()=>void}).unref?.();
    });
    const cleanup=Promise.all([workerDrain,httpDrain]).then(()=>this.endPoolOnce()).then(()=>"drained" as const,()=>"failure" as const);
    const result=await Promise.race([cleanup,timedOut]);
    if(result!=="drained"){
      this.server.closeAllConnections?.();
      this.safeObserve(result,signal);
      void this.endPoolOnce().catch(()=>undefined);
      this.forceExit(1);
      return;
    }
    this.cancel(deadline);
    this.safeObserve("complete",signal);
  }

  private closeServer():Promise<void>{
    return new Promise((resolve)=>{
      try { this.server.close(()=>resolve()); } catch { resolve(); }
    });
  }

  private endPoolOnce():Promise<void>{
    return this.poolEndPromise ??= this.pool?.end() ?? Promise.resolve();
  }

  private safeObserve(event:"start"|"complete"|"timeout"|"failure",signal:string):void{
    try{this.observe(event,signal);}catch{/* Shutdown is not controlled by observability. */}
  }
}
