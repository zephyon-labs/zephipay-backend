import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

export const DB_OPERATION_FAMILIES = [
  "ACCOUNT_RESOLUTION", "ACCOUNT_PROVISIONING", "PAYMENT_IDENTITY", "RECIPIENT_SEARCH",
  "RECIPIENT_RESOLUTION", "PAYMENT_INTENT_CREATE", "PAYMENT_INTENT_READ", "PAYMENT_INTENT_CONFIRM",
  "EXECUTION_CREATE", "EXECUTION_CLAIM", "EXECUTION_COMPLETE", "EXECUTION_RECONCILE",
  "EXECUTION_READ", "RECEIPT_READ", "ACTIVITY_READ", "PAYMENT_REQUEST",
  "OPEN_BETA_TELEMETRY", "HEALTH_CHECK", "UNCLASSIFIED",
] as const;

export type DatabaseOperationFamily = typeof DB_OPERATION_FAMILIES[number];
export type DatabaseFailureCategory =
  | "DB_CONNECT_TIMEOUT" | "DB_POOL_ACQUIRE_TIMEOUT" | "DB_CONNECTION_TERMINATED"
  | "DB_QUERY_TIMEOUT" | "DB_LOCK_TIMEOUT" | "DB_SERIALIZATION_FAILURE" | "DB_DEADLOCK"
  | "DB_CONNECTION_RESET" | "DB_UNAVAILABLE" | "DB_UNKNOWN";

type ReliabilityContext = Readonly<{
  requestId?: string;
  routeFamily?: string;
  method?: string;
  dbOperation?: DatabaseOperationFamily;
}>;

type SafeFields = Readonly<{
  requestId?: string; processId?: string; routeFamily?: string; method?: string; status?: number;
  durationMs?: number; acquisitionMs?: number; queryMs?: number; transactionMs?: number;
  totalCount?: number; idleCount?: number; waitingCount?: number;
  dbOperation?: DatabaseOperationFamily; dbFailure?: DatabaseFailureCategory;
  limiterCategory?: string; outcome?: string; phase?: string; event?: string;
}>;

type Timing = { count: number; totalMs: number; maxMs: number };
type LogLevel = "info" | "warn" | "error";
type LogSink = (level: LogLevel, event: string, fields: SafeFields) => void;

const context = new AsyncLocalStorage<ReliabilityContext>();
const counters = new Map<string, number>();
const timings = new Map<string, Timing>();
const observedErrors = new WeakSet<object>();
const SLOW_TRANSACTION_MS = 1_000;
const SLOW_DATABASE_OPERATION_MS = 1_000;
let sink: LogSink = defaultSink;

const railwayReplica = process.env.RAILWAY_REPLICA_ID?.trim();
const safeRailwayReplica = railwayReplica && /^[A-Za-z0-9._:-]{1,64}$/.test(railwayReplica) ? railwayReplica : undefined;
export const processInstance = Object.freeze({
  id: safeRailwayReplica ? `railway:${safeRailwayReplica}` : `process:${randomUUID().slice(0, 8)}`,
  source: safeRailwayReplica ? "railway-replica" as const : "random-process" as const,
});

export function runWithReliabilityContext<T>(value: ReliabilityContext, operation: () => T): T {
  return context.run(Object.freeze({ ...context.getStore(), ...value }), operation);
}

export function currentReliabilityContext(): ReliabilityContext { return context.getStore() ?? {}; }

export function poolSnapshot(pool: Pick<Pool, "totalCount" | "idleCount" | "waitingCount">) {
  return Object.freeze({ totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount });
}

export function instrumentPostgresPool(pool: Pool): Pool {
  pool.on("connect", () => { recordCounter("db.pool.lifecycle", { event: "connect" }); });
  pool.on("acquire", () => { recordCounter("db.pool.lifecycle", { event: "acquire" }); });
  pool.on("release", (error) => {
    recordCounter("db.pool.lifecycle", { event: "release", outcome: error ? "error" : "success" });
  });
  pool.on("remove", () => { recordCounter("db.pool.lifecycle", { event: "remove" }); });
  pool.on("error", (error) => {
    recordCounter("db.pool.lifecycle", { event: "error" });
    observeDatabaseFailureOnce(error, pool, "pool_error");
  });

  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    const started = performance.now(); const physicalCandidate=pool.idleCount===0&&pool.totalCount<pool.options.max; const callback = typeof args[0] === "function" ? args[0] as (...callbackArgs: unknown[]) => void : undefined;
    if (callback) return originalConnect((error: unknown, ...callbackArgs: unknown[]) => {
      recordAcquisition(pool, started, error,physicalCandidate); callback(error, ...callbackArgs);
    });
    const result = originalConnect() as Promise<unknown>;
    return result.then((client) => { recordAcquisition(pool, started,undefined,physicalCandidate); return client; }, (error) => {
      recordAcquisition(pool, started,error,physicalCandidate); throw error;
    });
  };

  const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const started = performance.now(); const current = currentReliabilityContext();
    const callbackIndex = args.findIndex((value) => typeof value === "function");
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => void;
      args[callbackIndex] = (error: unknown, ...callbackArgs: unknown[]) => {
        recordQuery(pool, current.dbOperation ?? "UNCLASSIFIED", started, error); callback(error, ...callbackArgs);
      };
      return originalQuery(...args);
    }
    const result = originalQuery(...args) as Promise<unknown>;
    return result.then((value) => { recordQuery(pool, current.dbOperation ?? "UNCLASSIFIED", started); return value; }, (error) => {
      recordQuery(pool, current.dbOperation ?? "UNCLASSIFIED", started, error); throw error;
    });
  };
  return pool;
}

export function recordCounter(name: string, labels: Readonly<Record<string, string>> = {}): void {
  safely(() => { const key = metricKey(name, labels); counters.set(key, (counters.get(key) ?? 0) + 1); });
}

export function recordTiming(name: string, durationMs: number, labels: Readonly<Record<string, string>> = {}): void {
  safely(() => {
    const key = metricKey(name, labels); const prior = timings.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    timings.set(key, { count: prior.count + 1, totalMs: prior.totalMs + durationMs, maxMs: Math.max(prior.maxMs, durationMs) });
  });
}

export function reliabilityMetricsSnapshot() {
  return Object.freeze({ counters: Object.fromEntries(counters), timings: Object.fromEntries(timings) });
}

export function emitReliabilityLog(level: LogLevel, event: string, fields: SafeFields = {}): void {
  safely(() => sink(level, event, Object.freeze({ processId: processInstance.id, ...fields })));
}

export function setReliabilityLogSinkForTest(next?: LogSink): void { sink = next ?? defaultSink; }
export function resetReliabilityMetricsForTest(): void { counters.clear(); timings.clear(); }

export function classifyDatabaseError(error: unknown): DatabaseFailureCategory {
  const code = errorCode(error);
  if (code === "57014") return "DB_QUERY_TIMEOUT";
  if (code === "55P03") return "DB_LOCK_TIMEOUT";
  if (code === "40001") return "DB_SERIALIZATION_FAILURE";
  if (code === "40P01") return "DB_DEADLOCK";
  if (["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(code)) return code === "ECONNRESET" ? "DB_CONNECTION_RESET" : "DB_UNAVAILABLE";
  if (["57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "08007", "08P01"].includes(code)) return "DB_UNAVAILABLE";
  const messages = causeMessages(error);
  if (messages.some((value) => value === "Connection terminated due to connection timeout")) return "DB_CONNECT_TIMEOUT";
  if (messages.some((value) => value === "timeout exceeded when trying to connect")) return "DB_POOL_ACQUIRE_TIMEOUT";
  if (messages.some((value) => /connection terminated|connection closed/i.test(value))) return "DB_CONNECTION_TERMINATED";
  return "DB_UNKNOWN";
}

export function observeDatabaseFailure(error: unknown, pool: Pick<Pool, "totalCount" | "idleCount" | "waitingCount">, phase: string, durationMs?: number): DatabaseFailureCategory {
  if (typeof error === "object" && error !== null) {
    if (observedErrors.has(error)) return classifyDatabaseError(error);
    observedErrors.add(error);
  }
  const current = currentReliabilityContext(); const dbFailure = classifyDatabaseError(error);
  recordCounter("db.failure", { category: dbFailure, family: current.dbOperation ?? "UNCLASSIFIED", phase });
  emitReliabilityLog("error", "database_operation_failed", {
    ...current, ...poolSnapshot(pool), dbFailure, phase, ...(durationMs === undefined ? {} : { durationMs }),
  });
  return dbFailure;
}

function observeDatabaseFailureOnce(error: unknown, pool: Pick<Pool, "totalCount" | "idleCount" | "waitingCount">, phase: string, durationMs?: number): DatabaseFailureCategory {
  return observeDatabaseFailure(error, pool, phase, durationMs);
}

export async function observeTransaction<T>(pool: Pick<Pool, "totalCount" | "idleCount" | "waitingCount">, operation: () => Promise<T>): Promise<T> {
  const started = performance.now(); let outcome = "commit";
  try { return await operation(); }
  catch (error) { outcome = "rollback"; throw error; }
  finally {
    const transactionMs = elapsed(started); const current = currentReliabilityContext();
    recordTiming("db.transaction.duration", transactionMs, { family: current.dbOperation ?? "UNCLASSIFIED", outcome });
    if (transactionMs >= SLOW_TRANSACTION_MS) emitReliabilityLog("warn", "database_transaction_slow", {
      ...current, ...poolSnapshot(pool), transactionMs, outcome,
    });
  }
}

export function normalizeRouteFamily(path: string): string {
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api") return pathname === "/" ? "/" : "/other";
  if (segments[1] === "payment-intents") {
    if (segments.length === 2) return "/api/payment-intents";
    const suffix = segments[3];
    return suffix && ["confirm", "execute", "execution", "receipt"].includes(suffix)
      ? `/api/payment-intents/:intentId/${suffix}` : "/api/payment-intents/:intentId";
  }
  if (segments[1] === "payment-requests") return segments.length > 2
    ? `/api/payment-requests/:requestId${segments[3] && ["accept","decline","cancel"].includes(segments[3]) ? `/${segments[3]}` : ""}` : "/api/payment-requests";
  if (segments[1] === "recipients") return segments[2] && !["search", "recent"].includes(segments[2])
    ? "/api/recipients/:accountId" : pathname;
  if(segments[1]==="account")return segments[2]==="identity"?`/api/account/identity${segments[3]==="destinations"?"/destinations":""}`:"/api/account";
  const stable=new Set(["activity","telemetry","protocol","verify","receipts","entitlements","catalog","agent","send"]);
  return stable.has(segments[1]??"")?`/api/${segments[1]}${segments[1]==="telemetry"&&segments[2]==="open-beta"?"/open-beta":""}`:"/api/other";
}

export function databaseOperationFor(routeFamily: string, method: string): DatabaseOperationFamily {
  if (routeFamily === "/health/ready") return "HEALTH_CHECK";
  if (routeFamily === "/api/account") return "ACCOUNT_RESOLUTION";
  if (routeFamily.startsWith("/api/account/identity")) return "PAYMENT_IDENTITY";
  if (routeFamily === "/api/recipients/search") return "RECIPIENT_SEARCH";
  if (routeFamily.startsWith("/api/recipients/")) return "RECIPIENT_RESOLUTION";
  if (routeFamily === "/api/payment-intents" && method === "POST") return "PAYMENT_INTENT_CREATE";
  if (routeFamily.endsWith("/confirm")) return "PAYMENT_INTENT_CONFIRM";
  if (routeFamily.endsWith("/execute")) return "EXECUTION_CREATE";
  if (routeFamily.endsWith("/execution")) return "EXECUTION_READ";
  if (routeFamily.endsWith("/receipt")) return "RECEIPT_READ";
  if (routeFamily === "/api/activity") return "ACTIVITY_READ";
  if (routeFamily.startsWith("/api/payment-requests")) return "PAYMENT_REQUEST";
  if (routeFamily === "/api/telemetry/open-beta") return "OPEN_BETA_TELEMETRY";
  if (routeFamily.startsWith("/api/payment-intents/")) return "PAYMENT_INTENT_READ";
  return "UNCLASSIFIED";
}

export function elapsed(started: number): number { return Math.max(0, Math.round((performance.now() - started) * 100) / 100); }

function metricKey(name: string, labels: Readonly<Record<string, string>>): string {
  const suffix = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(",");
  return suffix ? `${name}{${suffix}}` : name;
}
function recordAcquisition(pool: Pool, started: number, error?: unknown,physicalCandidate=false): void {
  const acquisitionMs = elapsed(started); const current = currentReliabilityContext();
  recordTiming("db.pool.acquisition", acquisitionMs, { family: current.dbOperation ?? "UNCLASSIFIED", outcome: error ? "failure" : "success" });
  if(physicalCandidate)recordTiming("db.pool.physical_connection.duration",acquisitionMs,{outcome:error?"failure":"success"});
  if (error) observeDatabaseFailureOnce(error, pool, "acquire", acquisitionMs);
  else if (acquisitionMs >= SLOW_DATABASE_OPERATION_MS) emitReliabilityLog("warn", "database_pool_acquisition_slow", {
    ...current, ...poolSnapshot(pool), acquisitionMs,
  });
}
function recordQuery(pool: Pool, family: DatabaseOperationFamily, started: number, error?: unknown): void {
  const queryMs = elapsed(started); const current = currentReliabilityContext();
  recordTiming("db.query.duration", queryMs, { family, outcome: error ? "failure" : "success" });
  if (error) observeDatabaseFailureOnce(error, pool, "query", queryMs);
  else if (queryMs >= SLOW_DATABASE_OPERATION_MS) emitReliabilityLog("warn", "database_query_slow", {
    ...current, ...poolSnapshot(pool), dbOperation: family, queryMs,
  });
}
function safely(operation: () => void): void { try { operation(); } catch { /* Observability is never authoritative. */ } }
function defaultSink(level: LogLevel, event: string, fields: SafeFields): void { console[level](event, fields); }
function errorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : ""; }
function causeMessages(error: unknown): string[] {
  const messages: string[] = []; let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ("message" in current && typeof current.message === "string") messages.push(current.message);
    current = "cause" in current ? current.cause : undefined;
  }
  return messages;
}
