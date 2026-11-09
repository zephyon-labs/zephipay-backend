/** Test-only diagnostics. No exception content is rendered; command classification reads only safe own scalar descriptors. */
import { writeSync } from "node:fs";
import { types } from "node:util";

const dockerCodes = {
  CONTAINER: {
    EXECUTABLE_UNAVAILABLE: "DOCKER_CONTAINER_EXECUTABLE_UNAVAILABLE",
    ACCESS_DENIED: "DOCKER_CONTAINER_ACCESS_DENIED",
    NONZERO_EXIT: "DOCKER_CONTAINER_NONZERO_EXIT",
    TIMEOUT: "DOCKER_CONTAINER_TIMEOUT",
    OUTPUT_LIMIT: "DOCKER_CONTAINER_OUTPUT_LIMIT",
    SIGNAL: "DOCKER_CONTAINER_SIGNAL",
    UNKNOWN_EXECUTION_ERROR: "DOCKER_CONTAINER_UNKNOWN_EXECUTION_ERROR",
  },
  IMAGE: {
    EXECUTABLE_UNAVAILABLE: "DOCKER_IMAGE_EXECUTABLE_UNAVAILABLE",
    ACCESS_DENIED: "DOCKER_IMAGE_ACCESS_DENIED",
    NONZERO_EXIT: "DOCKER_IMAGE_NONZERO_EXIT",
    TIMEOUT: "DOCKER_IMAGE_TIMEOUT",
    OUTPUT_LIMIT: "DOCKER_IMAGE_OUTPUT_LIMIT",
    SIGNAL: "DOCKER_IMAGE_SIGNAL",
    UNKNOWN_EXECUTION_ERROR: "DOCKER_IMAGE_UNKNOWN_EXECUTION_ERROR",
  },
  NETWORK: {
    EXECUTABLE_UNAVAILABLE: "DOCKER_NETWORK_EXECUTABLE_UNAVAILABLE",
    ACCESS_DENIED: "DOCKER_NETWORK_ACCESS_DENIED",
    NONZERO_EXIT: "DOCKER_NETWORK_NONZERO_EXIT",
    TIMEOUT: "DOCKER_NETWORK_TIMEOUT",
    OUTPUT_LIMIT: "DOCKER_NETWORK_OUTPUT_LIMIT",
    SIGNAL: "DOCKER_NETWORK_SIGNAL",
    UNKNOWN_EXECUTION_ERROR: "DOCKER_NETWORK_UNKNOWN_EXECUTION_ERROR",
  },
} as const;
const inspectionOrigins = [
  "INITIAL",
  "BOOTSTRAP_RECHECK",
  "PRE_DDL",
  "RECHECK",
] as const;
export type InspectionOrigin = (typeof inspectionOrigins)[number];
const origins = new Set<string>(inspectionOrigins);
function inspectionCode(code: string): boolean {
  return code.startsWith("DOCKER_") || code === "CHECKOUT_READ_FAILED";
}

const codes = [
  ...Object.values(dockerCodes).flatMap((codes) => Object.values(codes)),
  "UNCLASSIFIED_FAILURE",
  "CLEANUP_FAILED",
  "CONTEXT_REJECTED",
  "TARGET_REJECTED",
  "DOCKER_METADATA_FAILED",
  "DOCKER_CONTAINER_READ_FAILED",
  "DOCKER_CONTAINER_PARSE_FAILED",
  "CHECKOUT_READ_FAILED",
  "DOCKER_IMAGE_READ_FAILED",
  "DOCKER_IMAGE_PARSE_FAILED",
  "DOCKER_NETWORK_READ_FAILED",
  "DOCKER_NETWORK_PARSE_FAILED",
  "METADATA_REJECTED",
  "SERVICE_RECHECK_FAILED",
  "BOOTSTRAP_CONNECT_FAILED",
  "BOOTSTRAP_IDENTITY_FAILED",
  "BOOTSTRAP_IDENTITY_QUERY_FAILED",
  "BOOTSTRAP_IDENTITY_RESULT_REJECTED",
  "FIXTURE_IDENTITY_QUERY_FAILED",
  "FIXTURE_IDENTITY_RESULT_REJECTED",
  "BOOTSTRAP_EMPTY_REJECTED",
  "BOOTSTRAP_INVENTORY_FAILED",
  "BOOTSTRAP_ROLE_CREATE_FAILED",
  "BOOTSTRAP_DATABASE_CREATE_FAILED",
  "BOOTSTRAP_MARKER_FAILED",
  "BOOTSTRAP_CLEANUP_FAILED",
  "PREPARE_TARGET_FAILED",
  "PREPARE_CONNECT_FAILED",
  "PREPARE_BEGIN_FAILED",
  "PREPARE_IDENTITY_FAILED",
  "PREPARE_TRANSACTION_FAILED",
  "PREPARE_SCHEMA_FAILED",
  "PREPARE_DDL_FAILED",
  "PREPARE_COMMIT_FAILED",
  "PREPARE_ROLLBACK_FAILED",
  "PREPARE_RELEASE_FAILED",
  "PREPARE_POOL_CLOSE_FAILED",
  "PREPARATION_CHILD_FAILED",
  "PREPARATION_REPORT_MISSING",
  "PREPARATION_REPORT_INVALID",
  "INTEGRATION_CHILD_FAILED",
  "INTEGRATION_REPORT_MISSING",
  "INTEGRATION_REPORT_INVALID",
  "INTEGRATION_TEST_FAILED",
  "INTEGRATION_TEST_SKIPPED",
  "INTEGRATION_INCOMPLETE",
  "INTEGRATION_SUMMARY_MISSING",
] as const;
export type DiagnosticCode = (typeof codes)[number];
const allowed = new Set<string>(codes);
const cleanupCodes = new Set<string>([
  "CLEANUP_FAILED",
  "BOOTSTRAP_CLEANUP_FAILED",
  "PREPARE_ROLLBACK_FAILED",
  "PREPARE_RELEASE_FAILED",
  "PREPARE_POOL_CLOSE_FAILED",
]);
type Report = Readonly<{
  primary: DiagnosticCode;
  cleanup: readonly DiagnosticCode[];
  inspection?: InspectionOrigin;
}>;
const reports = new WeakMap<object, Report>();
function known(error: unknown): Report | undefined {
  return (typeof error === "object" && error !== null) ||
    typeof error === "function"
    ? reports.get(error as object)
    : undefined;
}
function safe(code: DiagnosticCode): DiagnosticCode {
  return typeof code === "string" && allowed.has(code)
    ? code
    : "UNCLASSIFIED_FAILURE";
}
function make(
  primary: DiagnosticCode,
  cleanup: readonly DiagnosticCode[] = [],
  inspection?: InspectionOrigin,
): Error {
  const error = new Error(safe(primary));
  reports.set(
    error,
    Object.freeze({
      primary: safe(primary),
      cleanup: Object.freeze([...cleanup]),
      inspection:
        inspection && origins.has(inspection) ? inspection : undefined,
    }),
  );
  return error;
}
export function failure(code: DiagnosticCode, error?: unknown): Error {
  const report = known(error);
  return report
    ? make(report.primary, report.cleanup, report.inspection)
    : make(code);
}
export function atStage<T>(code: DiagnosticCode, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw failure(code, error);
  }
}
export async function atAsyncStage<T>(
  code: DiagnosticCode,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw failure(code, error);
  }
}
/** Cleanup still runs once, but cannot replace a previously identified primary failure. */
export async function withCleanup<T>(
  work: () => Promise<T>,
  code: DiagnosticCode,
  cleanup: () => unknown | Promise<unknown>,
): Promise<T> {
  let failed = false,
    original: unknown,
    value: T | undefined;
  try {
    value = await work();
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    await cleanup();
  } catch {
    const cleanupCode = cleanupCodes.has(code) ? code : "CLEANUP_FAILED";
    if (failed) {
      const report = known(original) ?? {
        primary: "UNCLASSIFIED_FAILURE" as const,
        cleanup: [],
      };
      original = make(
        report.primary,
        [...report.cleanup, cleanupCode],
        "inspection" in report ? report.inspection : undefined,
      );
    } else {
      failed = true;
      original = make(cleanupCode);
    }
  }
  if (failed) throw original;
  return value as T;
}
export function renderFailure(error: unknown): string {
  const report = known(error) ?? {
    primary: "UNCLASSIFIED_FAILURE",
    cleanup: [],
  };
  return (
    `NATIVE_PG_FAILURE ${report.primary}\n` +
    ("inspection" in report && report.inspection
      ? `NATIVE_PG_INSPECTION ${report.inspection}\n`
      : "") +
    report.cleanup.map((code) => `NATIVE_PG_CLEANUP ${code}\n`).join("")
  );
}
export const PREPARATION_OK = "NATIVE_PG_STATUS PREPARATION_OK\n";
export const INTEGRATION_OK = "NATIVE_PG_STATUS INTEGRATION_OK_16\n";

/** fd 3 is explicitly provisioned by the parent. Never parse stdout/stderr as reports. */
export function sendChildReport(
  text: string,
  env: Record<string, string | undefined>,
): void {
  if (env.NATIVE_SESSION_CI_DIAGNOSTIC_FD !== "3") return;
  if (
    text !== PREPARATION_OK &&
    text !== INTEGRATION_OK &&
    !readFailureReport(text)
  )
    return;
  try {
    writeSync(3, text);
  } catch {
    /* Parent rejects missing/incomplete reports. */
  }
}
export function readFailureReport(text: string): Error | undefined {
  if (text.length > 4096 || !text.endsWith("\n")) return;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > 5) return;
  const primary = lines[0].slice("NATIVE_PG_FAILURE ".length);
  if (lines[0] !== `NATIVE_PG_FAILURE ${primary}` || !allowed.has(primary))
    return;
  let inspection: InspectionOrigin | undefined;
  let start = 1;
  if (lines[1]?.startsWith("NATIVE_PG_INSPECTION ")) {
    const origin = lines[1].slice("NATIVE_PG_INSPECTION ".length);
    if (!origins.has(origin) || !inspectionCode(primary)) return;
    inspection = origin as InspectionOrigin;
    start++;
  }
  if (lines.length - start > 3) return;
  const cleanup: DiagnosticCode[] = [];
  for (const line of lines.slice(start)) {
    const code = line.slice("NATIVE_PG_CLEANUP ".length);
    if (line !== `NATIVE_PG_CLEANUP ${code}` || !cleanupCodes.has(code)) return;
    cleanup.push(code as DiagnosticCode);
  }
  return make(primary as DiagnosticCode, cleanup, inspection);
}

/** No getters, proxies, inherited fields, messages, stderr or string coercion. */
function executionReason(
  error: unknown,
): keyof (typeof dockerCodes)["CONTAINER"] {
  if (typeof error !== "object" || error === null || types.isProxy(error))
    return "UNKNOWN_EXECUTION_ERROR";
  try {
    const values: Record<string, unknown> = {};
    for (const key of ["code", "status", "signal"]) {
      const d = Object.getOwnPropertyDescriptor(error, key);
      if (d && !Object.hasOwn(d, "value")) return "UNKNOWN_EXECUTION_ERROR";
      values[key] = d?.value;
    }
    const { code, status, signal } = values;
    if (code === "ENOENT") return "EXECUTABLE_UNAVAILABLE";
    if (code === "EACCES" || code === "EPERM") return "ACCESS_DENIED";
    if (code === "ETIMEDOUT") return "TIMEOUT";
    if (code === "ENOBUFS") return "OUTPUT_LIMIT";
    if (code !== undefined && code !== null) return "UNKNOWN_EXECUTION_ERROR";
    if (typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal))
      return "SIGNAL";
    if (signal !== undefined && signal !== null)
      return "UNKNOWN_EXECUTION_ERROR";
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status > 0 &&
      status <= 255
    )
      return "NONZERO_EXIT";
  } catch {
    /* Reflection failure is itself untrusted. */
  }
  return "UNKNOWN_EXECUTION_ERROR";
}
export function dockerCommandFailure(
  operation: keyof typeof dockerCodes,
  error: unknown,
): Error {
  return failure(dockerCodes[operation][executionReason(error)], error);
}
/** Origin is diagnostic only; first owned failure and cleanup records remain intact. */
export function atInspection<T>(origin: InspectionOrigin, work: () => T): T {
  try {
    return work();
  } catch (error) {
    const report = known(error);
    const primary = report?.primary ?? "DOCKER_METADATA_FAILED";
    throw make(
      primary,
      report?.cleanup,
      report?.inspection ?? (inspectionCode(primary) ? origin : undefined),
    );
  }
}
