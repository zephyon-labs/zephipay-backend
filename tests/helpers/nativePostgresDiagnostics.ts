/** Test-only diagnostics. Exception properties/content are never inspected or rendered. */
import { writeSync } from "node:fs";

const codes = [
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
): Error {
  const error = new Error(safe(primary));
  reports.set(
    error,
    Object.freeze({
      primary: safe(primary),
      cleanup: Object.freeze([...cleanup]),
    }),
  );
  return error;
}
export function failure(code: DiagnosticCode, error?: unknown): Error {
  const report = known(error);
  return report ? make(report.primary, report.cleanup) : make(code);
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
      original = make(report.primary, [...report.cleanup, cleanupCode]);
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
  if (lines.length < 1 || lines.length > 4) return;
  const primary = lines[0].slice("NATIVE_PG_FAILURE ".length);
  if (lines[0] !== `NATIVE_PG_FAILURE ${primary}` || !allowed.has(primary))
    return;
  const cleanup: DiagnosticCode[] = [];
  for (const line of lines.slice(1)) {
    const code = line.slice("NATIVE_PG_CLEANUP ".length);
    if (line !== `NATIVE_PG_CLEANUP ${code}` || !cleanupCodes.has(code)) return;
    cleanup.push(code as DiagnosticCode);
  }
  return make(primary as DiagnosticCode, cleanup);
}
