"use strict";
const { writeSync } = require("node:fs");
const { types } = require("node:util");
// Fixed reviewed manifest, in source order. Never emit these names or event values.
const CASE_NAMES = Object.freeze([
  "real connections serialize duplicate completion/revocation and retain canonical effects",
  "actual blocked concurrent transaction: complete obtains binding lock first",
  "actual blocked concurrent transaction: cancel obtains binding lock first",
  "actual blocked concurrent transaction: validate obtains binding lock first",
  "actual blocked concurrent transaction: revoke obtains binding lock first",
  "FOR UPDATE account lock conflicts with KEY SHARE before the canonical session is locked",
  "canonical mutation and native transition roll back on a real database statement failure",
  "terminal response waits for acknowledged COMMIT; injected response loss recovers committed revocation",
  "actual PostgreSQL-observed expiry persists and refreshed credentials do not renew it",
  "controlled expiry-equality sample persists a real watermark and subsequent earlier database time is denied",
  "connection termination rolls back a waiting transaction and yields unavailable authority",
  "candidate schema rejects identity changes, unknown states, deletion and watermark reversal",
  "malformed driver record after a real SELECT cannot change canonical identity",
  "native mutations change the captured account-version predicate used for pending Web eligibility",
  "new application process recovers after a prior process exits following real commit",
  "native account access creates no economic objects or capabilities",
]);
const CASE_IDS = Object.freeze(
  CASE_NAMES.map((_, i) => `CASE_${String(i + 1).padStart(2, "0")}`),
);

function own(object, key) {
  if (!object || typeof object !== "object" || types.isProxy(object))
    throw new Error("REPORT_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !Object.hasOwn(descriptor, "value"))
    throw new Error("REPORT_INVALID");
  return descriptor?.value;
}
const benign = new Set([
  "test:enqueue",
  "test:dequeue",
  "test:start",
  "test:complete",
  "test:plan",
  "test:diagnostic",
  "test:stdout",
  "test:stderr",
]);
const failureTypes = new Set([
  "testCodeFailure",
  "uncaughtException",
  "unhandledRejection",
  "hookFailed",
  "cancelledByParent",
  "testAborted",
  "testTimeoutFailure",
  "parentAlreadyFinished",
  "subtestsFailed",
]);
function flag(value) {
  if (value === undefined || value === false) return false;
  if (value === true || typeof value === "string") return true;
  throw new Error("REPORT_INVALID");
}
function summaryCounts(data) {
  const counts = own(data, "counts");
  const values = [
    "tests",
    "passed",
    "failed",
    "skipped",
    "cancelled",
    "todo",
    "suites",
  ].map((key) => own(counts, key));
  if (!values.every((v) => Number.isInteger(v) && v >= 0 && v <= 32))
    throw new Error("REPORT_INVALID");
  if (
    values[6] !== 0 ||
    values[0] !== values.slice(1, 6).reduce((a, b) => a + b, 0)
  )
    throw new Error("REPORT_INVALID");
  const success = own(data, "success");
  if (
    typeof success !== "boolean" ||
    success !== (values[2] === 0 && values[4] === 0)
  )
    throw new Error("REPORT_INVALID");
  return { values, success };
}

// Counts come only from recognized terminal events. "Executed" = passed + failed,
// including hook-caused failures; Node events do not prove entry into a test body.
async function collect(source) {
  const outcomes = new Map();
  const totals = [0, 0, 0, 0, 0, 0, 0];
  let first,
    finalSummary,
    invalid = false;
  const fail = (code, category, id = "NONE", failureType) => {
    first ??= { code, category, id, failureType };
  };
  const bad = () => {
    invalid = true;
    fail("INTEGRATION_REPORT_INVALID", "REPORTING_FAILURE");
  };
  try {
    for await (const event of source) {
      try {
        const type = own(event, "type");
        const data = own(event, "data");
        // Final totals must be the final event, not an early success assertion.
        if (finalSummary) {
          bad();
          continue;
        }
        if (benign.has(type)) {
          // Deliberately do not inspect messages, paths, stdout, stderr or complete.error.
          if (!data || typeof data !== "object" || types.isProxy(data)) bad();
          continue;
        }
        if (type === "test:summary") {
          const file = own(data, "file");
          if (file !== undefined) {
            if (typeof file !== "string") bad();
            continue; // A per-file summary is never authoritative for the process.
          }
          finalSummary = summaryCounts(data);
          if (!finalSummary.values.every((v, i) => v === totals[i])) bad();
          continue;
        }
        if (type !== "test:pass" && type !== "test:fail") {
          bad();
          continue;
        }
        const name = own(data, "name"),
          nesting = own(data, "nesting");
        if (typeof name !== "string" || nesting !== 0) {
          bad();
          continue;
        }
        const index = CASE_NAMES.indexOf(name),
          id = index < 0 ? "NONE" : CASE_IDS[index];
        const skip = flag(own(data, "skip")),
          todo = flag(own(data, "todo"));
        if (skip && todo) {
          bad();
          continue;
        }
        const details = own(data, "details");
        const detailsType = own(details, "type");
        if (detailsType !== undefined && detailsType !== "test") {
          bad();
          continue;
        }
        if (type === "test:pass" && own(details, "error") !== undefined) {
          bad();
          continue;
        }
        let failureType;
        if (type === "test:fail") {
          const error = own(details, "error");
          if (own(error, "code") !== "ERR_TEST_FAILURE") {
            bad();
            continue;
          }
          failureType = own(error, "failureType");
          if (!failureTypes.has(failureType)) {
            bad();
            continue;
          }
        }
        const metric = skip
          ? 3
          : todo
            ? 5
            : failureType === "cancelledByParent" ||
                failureType === "testAborted" ||
                failureType === "testTimeoutFailure"
              ? 4
              : type === "test:pass"
                ? 1
                : 2;
        if (id !== "NONE") {
          if (outcomes.has(id) || detailsType !== "test") {
            bad();
            continue;
          }
          outcomes.set(id, metric);
        }
        // Unknown named cases are not files. Compare file identity internally only.
        const file = own(data, "file");
        const fileFailure =
          id === "NONE" &&
          type === "test:fail" &&
          typeof file === "string" &&
          name === file;
        if (failureType === "hookFailed")
          fail("INTEGRATION_HOOK_FAILED", "HOOK_FAILURE", id, failureType);
        else if (id === "NONE") {
          if (fileFailure) fail("INTEGRATION_FILE_FAILED", "FILE_FAILURE");
          else bad();
        } else if (skip || todo)
          fail("INTEGRATION_TEST_SKIPPED", "CASE_FAILURE", id, failureType);
        else if (type === "test:fail")
          fail("INTEGRATION_TEST_FAILED", "CASE_FAILURE", id, failureType);
        if (totals[0] >= 32) {
          bad();
          continue;
        }
        totals[0]++;
        totals[metric]++;
      } catch {
        bad(); // Accessors, proxies, malformed fields and hostile errors never render.
      }
    }
  } catch {
    bad(); // An interrupted iterator retains observed case counts, never final totals.
  }
  if (!finalSummary) fail("INTEGRATION_SUMMARY_MISSING", "REPORTING_FAILURE");
  const complete = Boolean(finalSummary && !invalid);
  const counts = [0, 0, 0, 0, 0, 0];
  for (const metric of outcomes.values()) counts[metric]++;
  counts[0] = counts[1] + counts[2];
  if (!first && (!complete || outcomes.size !== 16 || counts[1] !== 16))
    fail("INTEGRATION_INCOMPLETE", "REPORTING_FAILURE");
  const header = first
    ? `NATIVE_PG_FAILURE ${first.code}\n`
    : "NATIVE_PG_STATUS INTEGRATION_OK_16\n";
  const detail = `NATIVE_PG_INTEGRATION ${first?.category ?? "NONE"} ${first?.id ?? "NONE"} ${complete ? "COMPLETE" : "PARTIAL"} ${counts.join(" ")}\n`;
  const summary = complete
    ? `NATIVE_PG_TOTALS ${finalSummary.success ? "SUCCESS" : "FAILURE"} ${finalSummary.values.join(" ")}\n`
    : "";
  const case11 =
    first?.id === "CASE_11"
      ? `NATIVE_PG_CASE_11_TYPE ${first.failureType === "uncaughtException" ? "ASYNC_EXCEPTION" : first.failureType === "unhandledRejection" ? "ASYNC_REJECTION" : first.failureType === "testCodeFailure" ? "TEST_FAILURE" : "OTHER"}\n`
      : "";
  return { code: first?.code, text: header + detail + summary + case11 };
}

module.exports = async function* nativePostgresReporter(source) {
  const result = await collect(source);
  if (process.env.NATIVE_SESSION_CI_DIAGNOSTIC_FD === "3") {
    try {
      writeSync(3, result.text);
    } catch {
      /* Parent rejects missing reports. */
    }
  }
  if (result.code) throw new Error(result.code); // Static only; parent discards stderr.
  yield "Native PostgreSQL integration: 16 passed; zero failures, skips, TODOs or cancellations.\n";
};
module.exports.CASE_NAMES = CASE_NAMES;
module.exports.collect = collect;
