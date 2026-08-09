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
  generalRateLimiter,
  paymentRateLimiter,
  sensitiveRateLimiter,
} from "./middleware/rateLimiter";
import { requestContext } from "./middleware/requestContext";
import { agentRouter } from "./routes/agent";
import { catalogRouter } from "./routes/catalog";
import { entitlementsRouter } from "./routes/entitlements";
import { protocolRouter } from "./routes/protocol";
import { receiptsRouter } from "./routes/receipts";
import { verifyRouter } from "./routes/verify";
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
import { x402Middleware } from "./x402/x402Server";
import { PostgresPaymentRequestRepository } from "./storage/postgres/postgresPaymentRequestRepository";
import { PaymentRequestService } from "./paymentRequests/paymentRequestService";
import { createPaymentRequestsRouter } from "./routes/paymentRequests";
import { createOpenBetaActivityRouter } from "./routes/openBetaActivity";
import { PostgresOpenBetaActivityRepository } from "./storage/postgres/postgresOpenBetaActivityRepository";
import { OpenBetaActivityService } from "./telemetry/openBetaActivity";

const app = express();
const postgresPool = environment.postgresEnabled
  ? createPaymentPostgresPool(environment.databaseUrl as string)
  : undefined;
const openBetaActivityService = postgresPool
  ? new OpenBetaActivityService(new PostgresOpenBetaActivityRepository(postgresPool))
  : undefined;

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

app.use(generalRateLimiter);
app.use("/api/telemetry", createOpenBetaActivityRouter(openBetaActivityService));

if (environment.authEnabled) {
  const pool = postgresPool as NonNullable<typeof postgresPool>;
  const identityPersistence = new PostgresIdentityPersistence(pool);
  const accountService = new AccountProvisioningService(identityPersistence);
  const economicIdentityPersistence = new PostgresEconomicIdentityPersistence(pool);
  const economicIdentityService = new EconomicIdentityService(accountService, economicIdentityPersistence);
  const syntheticIdentityStore = environment.syntheticBetaIdentitiesEnabled ? new PostgresSyntheticBetaIdentityStore(pool) : undefined;
  const recipientDirectoryService = new RecipientDirectoryService(identityPersistence, economicIdentityPersistence, syntheticIdentityStore);
  const paymentPersistence = new PostgresPaymentPersistence(pool);
  const paymentIntentService = new PaymentIntentService(accountService, paymentPersistence, {syntheticIdentityStore});
  const executionRepository = new PostgresExecutionRepository(pool);
  const executionService = new PaymentExecutionService(accountService, paymentPersistence, executionRepository);
  const paymentRequestRepository = new PostgresPaymentRequestRepository(pool);
  const paymentRequestService = new PaymentRequestService(accountService,paymentPersistence,paymentRequestRepository,recipientDirectoryService,paymentIntentService,executionRepository);
  const executionWorker = new PaymentExecutionWorker(paymentPersistence, executionRepository, `backend-${randomUUID()}`);
  let executionTickActive = false;
  const executionTimer = setInterval(async () => {
    if (executionTickActive) return;
    executionTickActive = true;
    try {
      await executionWorker.processNext();
      await executionWorker.reconcileNext();
    } catch (error) {
      console.error("Mock execution worker tick failed.", { error: error instanceof Error ? error.message : "Unknown worker error" });
    } finally {
      executionTickActive = false;
    }
  }, 1_000);
  executionTimer.unref();
  app.use(
    "/api/account",
    ...createAuthPipeline({
      issuer: environment.auth0Issuer as string,
      audience: environment.auth0Audience as string,
      requiredScope: environment.auth0RequiredScope,
    }),
    createAccountRouter(accountService, paymentPersistence),
    createEconomicIdentityRouter(economicIdentityService),
  );
  app.use(
    "/api/recipients",
    ...createAuthPipeline({
      issuer: environment.auth0Issuer as string,
      audience: environment.auth0Audience as string,
      requiredScope: environment.auth0RequiredScope,
    }),
    createRecipientsRouter(accountService, recipientDirectoryService, paymentIntentService),
  );
  const authConfiguration = {
    issuer: environment.auth0Issuer as string,
    audience: environment.auth0Audience as string,
  };
  app.use(
    "/api/payment-intents",
    createPaymentIntentsRouter({
      service: paymentIntentService,
      rateLimiter: paymentRateLimiter,
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
  const executionReadAuth = createAuthPipeline({ ...authConfiguration, requiredScope: environment.auth0ReadPaymentsScope });
  app.use("/api/payment-intents", createPaymentExecutionsRouter({
    service: executionService,
    readAuth: executionReadAuth,
    writeAuth: createAuthPipeline({ ...authConfiguration, requiredScope: environment.auth0WritePaymentsScope }),
  }));
  app.use("/api/activity", createActivityRouter({ service: executionService, readAuth: executionReadAuth }));
  app.use("/api/payment-requests", createPaymentRequestsRouter({service:paymentRequestService,rateLimiter:paymentRateLimiter,readAuth:executionReadAuth,writeAuth:createAuthPipeline({...authConfiguration,requiredScope:environment.auth0WritePaymentsScope})}));
} else {
  app.get("/api/account/me", (_req, res) => res.status(503).set("Cache-Control", "no-store").json({
    ok: false, error: "Authentication is not configured.", requestId: res.locals.requestId,
  }));
  app.use("/api/payment-intents", paymentIntentServiceUnavailable);
}

app.use("/api/protocol", protocolRouter);
app.use(
  "/api/verify",
  sensitiveRateLimiter,
  verifyRouter,
);
app.use(
  "/api/receipts",
  sensitiveRateLimiter,
  receiptsRouter,
);
app.use(
  "/api/entitlements",
  sensitiveRateLimiter,
  entitlementsRouter,
);
app.use("/api/catalog", catalogRouter);
app.use(x402Middleware);
app.use("/api/agent", agentRouter);

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
  paymentRateLimiter,
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
      return res.status(403).set("Cache-Control", "no-store").json({
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
        error instanceof Error
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

app.listen(environment.port, () => {
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
