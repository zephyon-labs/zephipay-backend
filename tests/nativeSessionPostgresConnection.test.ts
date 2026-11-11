import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { executeCiChild } from "../scripts/run-native-session-postgres-ci";
import {
  INTEGRATION_OK,
  readFailureReport,
  renderFailure,
} from "./helpers/nativePostgresDiagnostics";

for (const mode of [
  "legacy",
  "event-first",
  "query-first",
  "late",
  "query-only",
  "end-first",
  "pid-rejection",
  "healthy",
  "ownership",
  "unexpected",
  "unarmed",
  "late-unexpected",
  "cleanup-failure",
  "before-hook",
  "after-hook",
]) {
  test(`actual pg.Client with simulated transport: ${mode}`, () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NATIVE_PG_SIMULATED_CASE: mode,
      NATIVE_SESSION_CI_DIAGNOSTIC_FD: "3",
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=./scripts/native-postgres-ci-reporter.cjs",
        "tests/helpers/nativePostgresConnectionWorker.ts",
      ],
      {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const report = String(result.output[3] ?? "");
    assert.ok(
      !/SECRET_SENTINEL|::error::|secret\.invalid|Error:|node:/.test(report),
    );
    const fails = [
      "legacy",
      "unexpected",
      "unarmed",
      "late-unexpected",
      "cleanup-failure",
    ].includes(mode);
    assert.equal(result.status, fails ? 1 : 0);
    const spawn = (() => result) as unknown as typeof spawnSync;
    if (fails) {
      assert.equal(
        report,
        "NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_11 COMPLETE 16 15 1 0 0 0\nNATIVE_PG_TOTALS FAILURE 16 15 1 0 0 0 0\n" +
          `NATIVE_PG_CASE_11_TYPE ${mode === "legacy" ? "ASYNC_EXCEPTION" : "TEST_FAILURE"}\n`,
      );
      assert.equal(renderFailure(readFailureReport(report)), report);
      assert.throws(
        () => executeCiChild([], {}, "integrate", spawn),
        (error) => renderFailure(error) === report,
      );
    } else {
      assert.equal(report, INTEGRATION_OK);
      assert.doesNotThrow(() => executeCiChild([], {}, "integrate", spawn));
    }
  });
}
