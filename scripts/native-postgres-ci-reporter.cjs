"use strict";
const { writeSync } = require("node:fs");
function send(text) {
  if (process.env.NATIVE_SESSION_CI_DIAGNOSTIC_FD !== "3") return;
  try {
    writeSync(3, text);
  } catch {
    /* Parent rejects missing reports. */
  }
}
// Consume structured Node test events, not spoofable TAP/stdout summary strings.
// The accepted integration suite contains 16 cases. Changing that manifest requires review.
module.exports = async function* nativePostgresReporter(source) {
  let code = "INTEGRATION_INCOMPLETE";
  try {
    let finalSummary = false;
    for await (const event of source) {
      if (event.type === "test:fail") {
        code = "INTEGRATION_TEST_FAILED";
        throw new Error("Native PostgreSQL integration case failed");
      }
      if (event.type === "test:pass" && (event.data.skip || event.data.todo)) {
        code = "INTEGRATION_TEST_SKIPPED";
        throw new Error("Native PostgreSQL integration case skipped or TODO");
      }
      if (event.type === "test:summary" && event.data.file === undefined) {
        const { counts, success } = event.data;
        if (
          finalSummary ||
          success !== true ||
          counts?.tests !== 16 ||
          counts.passed !== 16 ||
          counts.failed !== 0 ||
          counts.skipped !== 0 ||
          counts.todo !== 0 ||
          counts.cancelled !== 0 ||
          counts.suites !== 0
        )
          throw new Error("Native PostgreSQL integration manifest incomplete");
        finalSummary = true;
        yield "Native PostgreSQL integration: 16 passed; zero failures, skips, TODOs or cancellations.\n";
      }
      // Do not publish fixture records, process input, environment or arbitrary child diagnostics.
    }
    if (!finalSummary) {
      code = "INTEGRATION_SUMMARY_MISSING";
      throw new Error("Native PostgreSQL integration summary missing");
    }
    send("NATIVE_PG_STATUS INTEGRATION_OK_16\n");
  } catch {
    send(`NATIVE_PG_FAILURE ${code}\n`);
    // Never rethrow exception content from event iterators/accessors. Parent suppresses all stderr.
    throw new Error(code);
  }
};
