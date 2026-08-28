import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { InsufficientScopeError, UnauthorizedError } from "express-oauth2-jwt-bearer";

dotenv.config();

import { environment } from "./config/environment";
import { createAuthPipeline } from "./auth/authMiddleware";
import { AccountProvisioningService } from "./identity/accountProvisioningService";
import { EconomicIdentityService } from "./economicIdentity/economicIdentityService";
import {
  authenticatedReadRateLimiter,
  generalRateLimiter,
  paymentMutationRateLimiter,
} from "./middleware/rateLimiter";
import { requestContext } from "./middleware/requestContext";
import { createAccountRouter } from "./routes/account";
import { createEconomicIdentityRouter } from "./routes/economicIdentity";
import { createRecipientsRouter } from "./routes/recipients";
import { RecipientDirectoryService } from "./recipients/recipientDirectoryService";
import { PostgresSyntheticBetaIdentityStore } from "./storage/postgres/postgresSyntheticBetaIdentityStore";
import { createPaymentIntentsRouter, paymentIntentServiceUnavailable } from "./routes/paymentIntents";
import { PaymentIntentService } from "./services/paymentIntentService";
import { PostgresPaymentPersistence } from "./storage/postgres/postgresPaymentPersistence";
import { PostgresExecutionRepository } from "./storage/postgres/postgresExecutionRepository";
import { PaymentExecutionService } from "./executions/executionService";
import { PaymentExecutionWorker } from "./executions/executionWorker";
import { createActivityRouter, createPaymentExecutionsRouter } from "./routes/paymentExecutions";
import { PostgresIdentityPersistence } from "./storage/postgres/postgresIdentityPersistence";
import { PostgresEconomicIdentityPersistence } from "./storage/postgres/postgresEconomicIdentityPersistence";
import { createPaymentPostgresPool } from "./storage/postgres/postgresPool";
import { mountX402Surface } from "./x402/x402Surface";
import { PostgresPaymentRequestRepository } from "./storage/postgres/postgresPaymentRequestRepository";
import { PaymentRequestService } from "./paymentRequests/paymentRequestService";
import { createPaymentRequestsRouter } from "./routes/paymentRequests";
import { createOpenBetaActivityRouter } from "./routes/openBetaActivity";
import { PostgresOpenBetaActivityRepository } from "./storage/postgres/postgresOpenBetaActivityRepository";
import { OpenBetaActivityService } from "./telemetry/openBetaActivity";
import { classifyDatabaseError, elapsed, emitReliabilityLog, observeDatabaseFailure, recordCounter, recordTiming, runWithReliabilityContext } from "./observability/reliabilityObservability";
import { AdaptiveWorkerLoop } from "./executions/adaptiveWorkerLoop";
import { PostgresActivityRepository } from "./storage/postgres/postgresActivityRepository";
import { ReadinessService } from "./health/readiness";
import { createHealthRouter } from "./routes/health";
import { GracefulShutdownCoordinator } from "./lifecycle/gracefulShutdown";
import { localHarnessAuth } from "./auth/localHarnessAuth";
import { parseDevnetLiveConfiguration } from "./devnet/devnetLiveConfiguration";
import { createLiveDevnetComposition, type LiveDevnetComposition } from "./devnet/liveDevnetComposition";
import { PostgresDevnetExecutionStateRepository } from "./storage/postgres/postgresDevnetExecutionStateRepository";
import { PostgresDevnetRecoveryRepository } from "./storage/postgres/postgresDevnetRecoveryRepository";
import { PostgresBrowserDevnetExecutionStore } from "./storage/postgres/postgresBrowserDevnetExecutionStore";
import { BrowserDevnetExecutionService } from "./devnet/browserDevnetExecution";
import { createBrowserDevnetExecutionsRouter } from "./routes/browserDevnetExecutions";
import { devnetPreparationPolicy, hashDevnetPolicy } from "./devnet/devnetPreparationPolicy";
import { ZpProgressService } from "./growth/zpProgressService";
import { createZpRouter } from "./routes/zp";
import { PostgresZpStateRepository } from "./storage/postgres/postgresZpStateRepository";
import { PostgresGrowthEventRepository } from "./storage/postgres/postgresGrowthEventRepository";
import { PaymentSettlementGrowthProjector } from "./growth/paymentSettlementGrowthProjector";
import {
  GrowthZpProjectionCoordinator,
  GrowthZpProjectionWorker,
} from "./growth/growthZpProjectionWorker";

const app = express();
const harnessAuth = localHarnessAuth();
let executionLoop: AdaptiveWorkerLoop | undefined;
let devnetComposition: LiveDevnetComposition | undefined;
let growthZpProjectionWorker: GrowthZpProjectionWorker | undefined;
const postgresPool = environment.postgresEnabled
  ? createPaymentPostgresPool(environment.databaseUrl as string)
  : undefined;
const readinessService=new ReadinessService(postgresPool,(result)=>recordCounter("readiness.check",{outcome:result.ready?"success":"failure",reason:result.reason}));
const openBetaActivityService = postgresPool
  ? new OpenBetaActivityService(new PostgresOpenBetaActivityRepository(postgresPool))
  : undefined;
const zpStateRepository = postgresPool
  ? new PostgresZpStateRepository(postgresPool)
  : undefined;

if (
  postgresPool &&
  zpStateRepository &&
  (environment.growthProjectionEnabled || environment.zpProjectionEnabled)
) {
  const configuration = Object.freeze({
    growthEnabled: environment.growthProjectionEnabled,
    zpEnabled: environment.zpProjectionEnabled,
  });
  const growthRepository = new PostgresGrowthEventRepository(postgresPool);
  const coordinator = new GrowthZpProjectionCoordinator(
    new PaymentSettlementGrowthProjector(postgresPool, growthRepository),
    zpStateRepository,
    configuration,
  );
  growthZpProjectionWorker = new GrowthZpProjectionWorker(
    coordinator,
    configuration,
    (outcome) => {
      const failed =
        outcome.growthFailed ||
        outcome.zpDiscoveryFailed ||
        outcome.zpFailedAccounts > 0;
      recordCounter("growth_zp_projection.iteration", {
        outcome: failed ? "failure" : "success",
      });
      recordTiming(
        "growth_zp_projection.iteration.duration",
        outcome.durationMs,
        { outcome: failed ? "failure" : "success" },
      );
      if (failed) {
        emitReliabilityLog("error", "growth_zp_projection_failed", {
          phase: outcome.growthFailed
            ? "growth"
            : outcome.zpDiscoveryFailed
            ? "zp_discovery"
            : "zp_account",
        });
      }
    },
    (_delayMs, outcome) => {
      recordCounter("growth_zp_projection.schedule", { outcome });
    },
  );
  growthZpProjectionWorker.start();
}

if (environment.trustProxy) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(requestContext);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (
        environment.corsAllowedOrigins.includes(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed."));
    },
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
    ],
    credentials: true,
    maxAge: 600,
  }),
);

app.use(
  express.json({
    limit: environment.jsonBodyLimit,
    strict: true,
    type: "application/json",
  }),
);

app.use("/health",createHealthRouter(readinessService));
app.use("/api/telemetry", generalRateLimiter, createOpenBetaActivityRouter(openBetaActivityService));

if (environment.authEnabled) {
  const pool = postgresPool as NonNullable<typeof postgresPool>;
  const identityPersistence = new PostgresIdentityPersistence(pool);
  const accountService = new AccountProvisioningService(identityPersistence);
  const economicIdentityPersistence = new PostgresEconomicIdentityPersistence(pool);
  const economicIdentityService = new EconomicIdentityService(accountService, economicIdentityPersistence);
  const zpProgressService = new ZpProgressService(accountService, zpStateRepository!);
  const syntheticIdentityStore = environment.syntheticBetaIdentitiesEnabled ? new PostgresSyntheticBetaIdentityStore(pool) : undefined;
  const recipientDirectoryService = new RecipientDirectoryService(identityPersistence, economicIdentityPersistence, syntheticIdentityStore);
  const paymentPersistence = new PostgresPaymentPersistence(pool);
  const paymentIntentService = new PaymentIntentService(accountService, paymentPersistence, {syntheticIdentityStore});
  const executionRepository = new PostgresExecutionRepository(pool);
  const executionService = new PaymentExecutionService(accountService, paymentPersistence, executionRepository,undefined,undefined,new PostgresActivityRepository(pool));
  const devnetConfig=parseDevnetLiveConfiguration();
  let browserDevnetService:BrowserDevnetExecutionService|undefined;
  if(devnetConfig.enabled){
    const executionState=new PostgresDevnetExecutionStateRepository(pool),recoveryRepository=new PostgresDevnetRecoveryRepository(pool,executionState);let composition:LiveDevnetComposition|undefined;
    const recoveryHandlers={async currentBlockHeight(){if(!composition?.blockDataSource)throw new Error("Devnet block data source is unavailable.");return composition.blockDataSource.getCurrentDevnetBlockHeight();},async prepare(candidate:Readonly<{paymentIntentId:string;actorSubject:string}>){return browserDevnetService?.recoverPreparation(candidate.paymentIntentId,candidate.actorSubject)??false;},async reconcile(candidate:Readonly<{paymentIntentId:string;actorSubject:string}>,lease:import("./devnet/devnetRecoveryRepository").DevnetRecoveryLeaseControl){return browserDevnetService?.reconcileOwned(candidate.paymentIntentId,candidate.actorSubject,lease)??false;}};
    const recoveryObserver=(event:import("./devnet/devnetRecoveryWorker").DevnetRecoveryOperationalEvent)=>{recordCounter(`devnet_recovery.${event.event}`,{outcome:event.outcome,phase:event.phase,...(event.backlog?{backlog:event.backlog}:{})});emitReliabilityLog(event.outcome==="failure"?"error":event.backlog==="warning"||event.backlog==="unavailable"?"warn":"info",`devnet_recovery_${event.event}`,{outcome:event.outcome,phase:event.phase,...(event.backlog?{backlog:event.backlog}:{}),...(event.unresolvedCount===undefined?{}:{unresolvedCount:event.unresolvedCount}),...(event.oldestUnresolvedAgeMs===undefined?{}:{oldestUnresolvedAgeMs:event.oldestUnresolvedAgeMs})});};
    composition=createLiveDevnetComposition(devnetConfig,{executionState,recoveryRepository,recoveryHandlers,recoveryObserver,workerId:`browser-devnet-${randomUUID()}`});devnetComposition=composition;
    const policyHash=devnetConfig.preparationEnabled?hashDevnetPolicy(devnetPreparationPolicy({mint:devnetConfig.mint!,decimals:devnetConfig.decimals!,sourceTokenAccount:devnetConfig.sourceTokenAccount!,signerKeyId:devnetConfig.signerKeyId!,signerKeyVersion:devnetConfig.signerKeyVersion!,signerPublicKey:devnetConfig.signerPublicKey!,submissionProviderId:devnetConfig.submissionProviderId!,reconciliationProviderId:devnetConfig.reconciliationProviderId!})):"0".repeat(64);
    browserDevnetService=new BrowserDevnetExecutionService(accountService,paymentPersistence,new PostgresBrowserDevnetExecutionStore(pool),executionState,composition.orchestration,composition.reconciliation,recoveryRepository,`browser-devnet-manual-${randomUUID()}`,{exposureEnabled:devnetConfig.browserApiEnabled===true,preparationEnabled:devnetConfig.preparationEnabled,submissionEnabled:devnetConfig.submissionEnabled,reconciliationEnabled:devnetConfig.reconciliationEnabled,policyHash,maxRawAmount:BigInt(Math.floor(environment.paymentMaxUsdc*1_000_000))});
    if(devnetConfig.preparationEnabled||devnetConfig.reconciliationEnabled)composition.workerLoop.start();
  }
  const paymentRequestRepository = new PostgresPaymentRequestRepository(pool);
  const paymentRequestService = new PaymentRequestService(accountService,paymentPersistence,paymentRequestRepository,recipientDirectoryService,paymentIntentService,executionRepository);
  const executionWorker = new PaymentExecutionWorker(paymentPersistence, executionRepository, `backend-${randomUUID()}`,harnessAuth?.mockScenario);
  executionLoop = new AdaptiveWorkerLoop(async () => {
    const tickStarted = performance.now();
    recordCounter("worker.tick");
    try {
      const processStarted=performance.now();
      const processed=await runWithReliabilityContext({dbOperation:"EXECUTION_CLAIM"},()=>executionWorker.processNext());
      const processDuration=elapsed(processStarted);
      recordTiming("worker.operation.duration",processDuration,{operation:"process"});
      recordCounter("worker.claim",{operation:"process",outcome:processed?"claimed":"empty"});
      if(processed)recordCounter("worker.outcome",{status:processed.status.toLowerCase()});
      const reconcileStarted=performance.now();
      const reconciled=await runWithReliabilityContext({dbOperation:"EXECUTION_RECONCILE"},()=>executionWorker.reconcileNext());
      const reconcileDuration=elapsed(reconcileStarted);
      recordTiming("worker.operation.duration",reconcileDuration,{operation:"reconcile"});
      recordCounter("worker.claim",{operation:"reconcile",outcome:reconciled?"claimed":"empty"});
      if(reconciled)recordCounter("worker.outcome",{status:reconciled.status.toLowerCase()});
      return processed!==undefined||reconciled!==undefined;
    } catch (error) {
      const dbFailure=classifyDatabaseError(error);
      recordCounter("worker.failure",{category:dbFailure});
      emitReliabilityLog("error","worker_tick_failed",{dbFailure,phase:"tick",durationMs:elapsed(tickStarted)});
      if(dbFailure!=="DB_UNKNOWN")observeDatabaseFailure(error,postgresPool as NonNullable<typeof postgresPool>,"worker_tick");
      console.error("Mock execution worker tick failed.", {
        error: dbFailure !== "DB_UNKNOWN"
          ? dbFailure
          : error instanceof Error ? error.message : "Unknown worker error",
      });
      throw error;
    }
  },(delayMs,outcome)=>{recordCounter("worker.schedule",{outcome,phase:delayMs===2_000?"max_backoff":"backoff"});});
  executionLoop.start();
  const authConfiguration = {
    issuer: environment.auth0Issuer as string,
    audience: environment.auth0Audience as string,
    ...(harnessAuth?{publicKey:harnessAuth.publicKey}:{}),
  };
  const accountReadAuth = createAuthPipeline({ ...authConfiguration, requiredScope: environment.auth0RequiredScope });
  const accountWriteAuth = createAuthPipeline({ ...authConfiguration, requiredScope: environment.auth0WriteAccountScope });
  const paymentReadAuth = createAuthPipeline({ ...authConfiguration, requiredScope: environment.auth0ReadPaymentsScope });
  app.use("/api/account", createAccountRouter({
    service: accountService,
    allowlist: paymentPersistence,
    readAuth: accountReadAuth,
    readLimiter: authenticatedReadRateLimiter,
  }));
  app.use("/api/account", createEconomicIdentityRouter({
    service: economicIdentityService,
    readAuth: accountReadAuth,
    writeAuth: accountWriteAuth,
    limiter: authenticatedReadRateLimiter,
  }));
  app.use("/api/account", createZpRouter({
    service: zpProgressService,
    projectionEnabled: environment.zpProjectionEnabled,
    readAuth: accountReadAuth,
    readLimiter: authenticatedReadRateLimiter,
  }));
  app.use("/api/recipients", createRecipientsRouter({
    accounts: accountService,
    directory: recipientDirectoryService,
    payments: paymentIntentService,
    directoryReadAuth: accountReadAuth,
    historyReadAuth: paymentReadAuth,
  }));
  app.use(
    "/api/payment-intents",
    createPaymentIntentsRouter({
      service: paymentIntentService,
      mutationLimiter: paymentMutationRateLimiter,
      readLimiter: authenticatedReadRateLimiter,
      readAuth: createAuthPipeline({
        ...authConfiguration,
        requiredScope: environment.auth0ReadPaymentsScope,
      }),
      writeAuth: createAuthPipeline({
        ...authConfiguration,
        requiredScope: environment.auth0WritePaymentsScope,
      }),
    }),
  );
  const executionReadAuth = paymentReadAuth;
  app.use("/api/payment-intents", createPaymentExecutionsRouter({
    service: executionService,
    mutationLimiter: paymentMutationRateLimiter,
    readLimiter: authenticatedReadRateLimiter,
    readAuth: executionReadAuth,
    writeAuth: createAuthPipeline({ ...authConfiguration, requiredScope: environment.auth0WritePaymentsScope }),
  }));
  if(browserDevnetService)app.use("/api/payment-intents",createBrowserDevnetExecutionsRouter({service:browserDevnetService,mutationLimiter:paymentMutationRateLimiter,readLimiter:authenticatedReadRateLimiter,readAuth:executionReadAuth,writeAuth:createAuthPipeline({...authConfiguration,requiredScope:environment.auth0WritePaymentsScope})}));
  app.use("/api/activity", createActivityRouter({ service: executionService, readAuth: executionReadAuth, readLimiter: authenticatedReadRateLimiter }));
  app.use("/api/payment-requests", createPaymentRequestsRouter({service:paymentRequestService,mutationLimiter:paymentMutationRateLimiter,readLimiter:authenticatedReadRateLimiter,readAuth:executionReadAuth,writeAuth:createAuthPipeline({...authConfiguration,requiredScope:environment.auth0WritePaymentsScope})}));
} else {
  app.get("/api/account/me", (_req, res) => res.status(503).set("Cache-Control", "no-store").json({
    ok: false, error: "Authentication is not configured.", requestId: res.locals.requestId,
  }));
  app.use("/api/payment-intents", paymentIntentServiceUnavailable);
}

app.use(generalRateLimiter);
mountX402Surface(app, {
  enabled: environment.x402Enabled,
  svmAddress: environment.x402SvmAddress,
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "ZephiPay backend online",
    network: "solana-devnet",
    paymentsEnabled: environment.paymentsEnabled,
  });
});

app.post(
  "/api/send",
  async (_req, res) => {
    const requestId = String(res.locals.requestId);
    return res.status(410).json({ok:false,error:"Legacy direct execution is disabled. Create, confirm, and explicitly execute a Payment Intent.",requestId});
  },
);

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const requestId = String(
      res.locals.requestId || "unknown",
    );
    const dbFailure=classifyDatabaseError(error);
    if(postgresPool&&dbFailure!=="DB_UNKNOWN"){
      res.locals.safeErrorCategory=dbFailure;
      observeDatabaseFailure(error,postgresPool,"http_error");
    }

    if (
      error instanceof SyntaxError &&
      "body" in error
    ) {
      return res.status(400).json({
        ok: false,
        error: "Request body contains invalid JSON.",
        requestId,
      });
    }

    if (
      error instanceof Error &&
      error.message === "Origin is not allowed."
    ) {
      return res.status(403).json({
        ok: false,
        error: "Request origin is not allowed.",
        requestId,
      });
    }

    if (error instanceof InsufficientScopeError) {
      return res.status(403).set(error.headers).set("Cache-Control", "no-store").json({
        ok: false, error: "Account access is not permitted.", requestId,
      });
    }

    if (error instanceof UnauthorizedError) {
      return res.status(401).set("Cache-Control", "no-store").json({
        ok: false, error: "Authentication is required.", requestId,
      });
    }

    console.error("Unhandled API error.", {
      requestId,
      error:
        dbFailure !== "DB_UNKNOWN"
          ? dbFailure
          : error instanceof Error
          ? error.message
          : "Unknown server error",
    });

    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      requestId,
    });
  },
);

const server = app.listen(environment.port, () => {
  console.log(
    `ZephiPay backend running on port ${environment.port}`,
  );
  console.log({
    environment: environment.nodeEnv,
    paymentsEnabled: environment.paymentsEnabled,
    trustProxy: environment.trustProxy,
    allowedOriginCount:
      environment.corsAllowedOrigins.length,
  });
});
server.on("close",()=>{executionLoop?.stop();devnetComposition?.workerLoop.stop();});
server.on("close",()=>growthZpProjectionWorker?.stop());
const shutdownCoordinator=new GracefulShutdownCoordinator(
  readinessService,
  {stopAndDrain:async()=>{await Promise.all([executionLoop?.stopAndDrain(),devnetComposition?.workerLoop.stopAndDrain(),growthZpProjectionWorker?.stopAndDrain()]);}},
  server,
  postgresPool,
  (event,signal)=>{
    recordCounter("shutdown.lifecycle",{event,signal});
    emitReliabilityLog(event==="timeout"||event==="failure"?"error":"info",`graceful_shutdown_${event}`,{phase:signal});
  },
);
process.on("SIGTERM",()=>{void shutdownCoordinator.shutdown("SIGTERM");});
process.on("SIGINT",()=>{void shutdownCoordinator.shutdown("SIGINT");});

export const runningBackend = Object.freeze({ app, server, postgresPool, readinessService, shutdownCoordinator });
