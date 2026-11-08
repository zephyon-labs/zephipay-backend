"use strict";
// Consume structured Node test events, not spoofable TAP/stdout summary strings.
// The accepted integration suite contains 16 cases. Changing that manifest requires review.
module.exports = async function* nativePostgresReporter(source) {
  let finalSummary = false;
  for await (const event of source) {
    if (event.type === "test:fail")
      throw new Error("Native PostgreSQL integration case failed");
    if (event.type === "test:pass" && (event.data.skip || event.data.todo))
      throw new Error("Native PostgreSQL integration case skipped or TODO");
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
  if (!finalSummary)
    throw new Error("Native PostgreSQL integration summary missing");
};
