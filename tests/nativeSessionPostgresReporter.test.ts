import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { executeCiChild } from "../scripts/run-native-session-postgres-ci";
import {
  failure,
  renderFailure,
  readFailureReport,
  withCleanup,
  INTEGRATION_OK,
} from "./helpers/nativePostgresDiagnostics";

const reporter = require("../scripts/native-postgres-ci-reporter.cjs") as {
  CASE_NAMES: readonly string[];
  collect(
    source: AsyncIterable<unknown>,
  ): Promise<{ code?: string; text: string }>;
};
const names = reporter.CASE_NAMES;
const hostile =
  "SECRET_SENTINEL\n::error::forged\r\nhttps://secret.invalid/password";
const error = (failureType = "testCodeFailure") => ({
  code: "ERR_TEST_FAILURE",
  failureType,
  message: hostile,
  cause: hostile,
});
function outcome(
  index: number,
  metric: "pass" | "fail" | "skip" | "todo" | "cancel" = "pass",
  failureType?: string,
) {
  const fails = metric === "fail" || metric === "cancel";
  return {
    type: fails ? "test:fail" : "test:pass",
    data: {
      name: names[index],
      nesting: 0,
      file: "not-emitted.cjs",
      details: {
        type: "test",
        ...(fails
          ? {
              error: error(
                failureType ??
                  (metric === "cancel"
                    ? "cancelledByParent"
                    : "testCodeFailure"),
              ),
            }
          : {}),
      },
      ...(metric === "skip" ? { skip: hostile } : {}),
      ...(metric === "todo" ? { todo: hostile } : {}),
    },
  };
}
function summary(
  passed = 16,
  failed = 0,
  skipped = 0,
  cancelled = 0,
  todo = 0,
) {
  return {
    type: "test:summary",
    data: {
      success: failed === 0 && cancelled === 0,
      counts: {
        tests: passed + failed + skipped + cancelled + todo,
        passed,
        failed,
        skipped,
        cancelled,
        todo,
        suites: 0,
      },
    },
  };
}
function collect(events: unknown[], interrupt = false) {
  return reporter.collect(
    (async function* () {
      yield* events;
      if (interrupt) throw new Error(hostile);
    })(),
  );
}
function safe(text: string) {
  assert.ok(
    !/SECRET_SENTINEL|::error::|secret\.invalid|not-emitted|Error:|node:/.test(
      text,
    ),
  );
  assert.ok(text.length <= 4096);
}
function real(prefix = "", body = "", options = "{}", count = 16) {
  const dir = mkdtempSync(path.join(tmpdir(), "native-reporter-regression-"));
  const file = path.join(dir, "synthetic.cjs");
  const source = `const {test,before,after,beforeEach,afterEach}=require('node:test'); const names=${JSON.stringify(names)}; ${prefix}; for(let i=0;i<${count};i++) test(names[i],${options},()=>{${body}});`;
  writeFileSync(file, source);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NATIVE_SESSION_CI_DIAGNOSTIC_FD: "3",
  };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        `--test-reporter=${path.resolve("scripts/native-postgres-ci-reporter.cjs")}`,
        file,
      ],
      {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    const channel = String(result.output[3] ?? "");
    safe(channel);
    return { result, channel };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fixed CASE_01 through CASE_16 manifest exactly matches unchanged integration definitions", () => {
  const file = "tests/postgresNativeSession.integration.ts";
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "test"
    ) {
      const name = node.arguments[0];
      if (ts.isStringLiteral(name)) found.push(name.text);
      else {
        assert.equal(
          name.getText(source),
          "`actual blocked concurrent transaction: ${first} obtains binding lock first`",
        );
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isForOfStatement(parent)) parent = parent.parent;
        assert.ok(parent && ts.isForOfStatement(parent));
        const expression = ts.isAsExpression(parent.expression)
          ? parent.expression.expression
          : parent.expression;
        assert.ok(ts.isArrayLiteralExpression(expression));
        for (const item of expression.elements) {
          assert.ok(ts.isStringLiteral(item));
          found.push(
            `actual blocked concurrent transaction: ${item.text} obtains binding lock first`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(found.length, 16);
  assert.equal(new Set(names).size, 16);
  assert.deepEqual(names, found);
  assert.ok(Object.isFrozen(names));
});
for (let index = 0; index < 16; index++)
  test(`real synthetic failure maps exact integration name to CASE_${String(index + 1).padStart(2, "0")}`, () => {
    const { result, channel } = real(
      "",
      `if(i===${index})throw Error(${JSON.stringify(hostile)});`,
    );
    assert.equal(result.status, 1);
    assert.equal(
      channel,
      `NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_${String(index + 1).padStart(2, "0")} COMPLETE 16 15 1 0 0 0\nNATIVE_PG_TOTALS FAILURE 16 15 1 0 0 0 0\n`,
    );
    assert.equal(renderFailure(readFailureReport(channel)), channel);
  });
for (const hook of ["before", "beforeEach", "afterEach", "after"])
  test(`real ${hook} failure is a hook failure, with distinct case and process totals`, () => {
    const { result, channel } = real(
      `${hook}(()=>{throw Error(${JSON.stringify(hostile)});})`,
    );
    assert.equal(result.status, 1);
    const after = hook === "after";
    assert.equal(
      channel,
      "NATIVE_PG_FAILURE INTEGRATION_HOOK_FAILED\n" +
        (after
          ? "NATIVE_PG_INTEGRATION HOOK_FAILURE NONE COMPLETE 16 16 0 0 0 0\nNATIVE_PG_TOTALS FAILURE 17 16 1 0 0 0 0\n"
          : "NATIVE_PG_INTEGRATION HOOK_FAILURE CASE_01 COMPLETE 16 0 16 0 0 0\nNATIVE_PG_TOTALS FAILURE 16 0 16 0 0 0 0\n"),
    );
    assert.equal(renderFailure(readFailureReport(channel)), channel);
  });
test("real startup failure is file-level and invents no identified-case execution", () => {
  const { result, channel } = real(`throw Error(${JSON.stringify(hostile)})`);
  assert.equal(result.status, 1);
  assert.equal(
    channel,
    "NATIVE_PG_FAILURE INTEGRATION_FILE_FAILED\nNATIVE_PG_INTEGRATION FILE_FAILURE NONE COMPLETE 0 0 0 0 0 0\nNATIVE_PG_TOTALS FAILURE 1 0 1 0 0 0 0\n",
  );
  assert.equal(renderFailure(readFailureReport(channel)), channel);
});
test("multiple real failures drain the stream and preserve the first case", () => {
  const { result, channel } = real(
    "",
    `if(i===2||i===8)throw Error(${JSON.stringify(hostile)});`,
  );
  assert.equal(result.status, 1);
  assert.equal(
    channel,
    "NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_03 COMPLETE 16 14 2 0 0 0\nNATIVE_PG_TOTALS FAILURE 16 14 2 0 0 0 0\n",
  );
});
test("real complete success, missing manifest member, skip, TODO and cancellation remain distinct and fail closed", () => {
  const good = real();
  assert.equal(good.result.status, 0);
  assert.equal(good.channel, INTEGRATION_OK);
  const missing = real("", "", "{}", 15);
  assert.equal(missing.result.status, 1);
  assert.equal(
    missing.channel,
    "NATIVE_PG_FAILURE INTEGRATION_INCOMPLETE\nNATIVE_PG_INTEGRATION REPORTING_FAILURE NONE COMPLETE 15 15 0 0 0 0\nNATIVE_PG_TOTALS SUCCESS 15 15 0 0 0 0 0\n",
  );
  for (const [options, counts] of [
    ["{skip:i===0}", "15 15 0 1 0 0"],
    ["{todo:i===0}", "15 15 0 0 0 1"],
  ]) {
    const r = real("", "", options);
    assert.equal(r.result.status, 1);
    assert.ok(r.channel.includes(`CASE_FAILURE CASE_01 COMPLETE ${counts}\n`));
    assert.ok(readFailureReport(r.channel));
  }
  const cancelled = real("", "return new Promise(()=>{})", "{}", 1);
  assert.equal(cancelled.result.status, 1);
  assert.ok(
    cancelled.channel.includes("CASE_FAILURE CASE_01 COMPLETE 0 0 0 0 1 0\n"),
  );
  assert.ok(readFailureReport(cancelled.channel));
});
test("interruption preserves first failure and partial counts without final totals", async () => {
  const r = await collect([outcome(0), outcome(1, "fail")], true);
  assert.equal(
    r.text,
    "NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_02 PARTIAL 2 1 1 0 0 0\n",
  );
  assert.equal(renderFailure(readFailureReport(r.text)), r.text);
  const missing = await collect([outcome(0)]);
  assert.equal(
    missing.text,
    "NATIVE_PG_FAILURE INTEGRATION_SUMMARY_MISSING\nNATIVE_PG_INTEGRATION REPORTING_FAILURE NONE PARTIAL 1 1 0 0 0 0\n",
  );
});

test("real Node test timeout is cancelled, not a failed-case total", () => {
  const r = real(
    "",
    "if(i===0)return new Promise(r=>setTimeout(r,80))",
    "{timeout:i===0?10:undefined}",
  );
  assert.equal(r.result.status, 1);
  assert.equal(
    r.channel,
    "NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_01 COMPLETE 15 15 0 0 1 0\nNATIVE_PG_TOTALS FAILURE 16 15 0 0 1 0 0\n",
  );
});

test("mixed case counts reconcile with final process totals and preserve the first failure", async () => {
  const events = [
    outcome(0, "fail"),
    outcome(1, "skip"),
    outcome(2, "todo"),
    outcome(3, "cancel"),
    ...names.slice(4).map((_, i) => outcome(i + 4)),
  ];
  const r = await collect([...events, summary(12, 1, 1, 1, 1)]);
  assert.equal(
    r.text,
    "NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_01 COMPLETE 13 12 1 1 1 1\nNATIVE_PG_TOTALS FAILURE 16 12 1 1 1 1 0\n",
  );
  assert.equal(renderFailure(readFailureReport(r.text)), r.text);
});

test("malformed or inconsistent final totals and duplicate case identities cannot imply completion", async () => {
  const events = names.map((_, i) => outcome(i));
  for (const key of Object.keys(summary().data.counts))
    for (const value of [undefined, null, NaN, Infinity, -1, 0.5, "16", 33]) {
      const end = summary();
      Object.assign(end.data.counts, { [key]: value });
      const r = await collect([...events, end]);
      assert.equal(r.code, "INTEGRATION_REPORT_INVALID");
      assert.ok(r.text.includes(" PARTIAL "));
      assert.ok(!r.text.includes("NATIVE_PG_TOTALS"));
      assert.ok(readFailureReport(r.text));
    }
  const duplicates = await collect([
    ...events.slice(0, 15),
    outcome(0),
    summary(),
  ]);
  assert.equal(duplicates.code, "INTEGRATION_REPORT_INVALID");
  assert.ok(duplicates.text.includes("PARTIAL 15 15 0 0 0 0"));
  const first = await collect([
    outcome(0, "fail"),
    { type: "unknown", data: {} },
    ...events.slice(1),
    summary(15, 1),
  ]);
  assert.ok(
    first.text.startsWith(
      "NATIVE_PG_FAILURE INTEGRATION_TEST_FAILED\nNATIVE_PG_INTEGRATION CASE_FAILURE CASE_01 PARTIAL",
    ),
  );
});
test("final totals require clean stream completion, not just an early summary", async () => {
  const good = names.map((_, i) => outcome(i));
  for (const events of [
    [...good, summary(), summary()],
    [...good, summary(), outcome(0)],
    [summary()],
  ]) {
    const r = await collect(events);
    safe(r.text);
    assert.ok(r.code);
    assert.ok(r.text.includes(" PARTIAL "));
    assert.ok(!r.text.includes("NATIVE_PG_TOTALS"));
  }
  const interrupted = await collect([...good, summary()], true);
  assert.ok(interrupted.text.includes(" PARTIAL "));
  assert.ok(!interrupted.text.includes("NATIVE_PG_TOTALS"));
});
test("unknown events, names, malformed metadata, proxies and hostile accessors cannot authorize or leak", async () => {
  const proxy = new Proxy(
    {},
    {
      get() {
        throw Error(hostile);
      },
      getOwnPropertyDescriptor() {
        throw Error(hostile);
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const failures: unknown[] = [
    { type: hostile, data: {} },
    { type: "test:unknown", data: {} },
    {},
    null,
    proxy,
    revoked.proxy,
    Object.defineProperty({}, "type", {
      get() {
        throw Error(hostile);
      },
    }),
    { ...outcome(0), data: { ...outcome(0).data, name: hostile } },
    { ...outcome(0), data: { ...outcome(0).data, nesting: 1 } },
    { ...outcome(0), data: { ...outcome(0).data, details: proxy } },
    {
      ...outcome(0, "fail"),
      data: {
        ...outcome(0).data,
        details: {
          type: "test",
          error: { code: hostile, failureType: "hookFailed" },
        },
      },
    },
    { ...outcome(0), data: { ...outcome(0).data, skip: {} } },
  ];
  for (const event of failures) {
    const r = await collect([
      event,
      ...names.map((_, i) => outcome(i)),
      summary(),
    ]);
    safe(r.text);
    assert.equal(r.code, "INTEGRATION_REPORT_INVALID");
    assert.ok(r.text.includes("REPORTING_FAILURE NONE PARTIAL"));
    assert.ok(readFailureReport(r.text));
  }
  const benign = ["test:stdout", "test:stderr", "test:diagnostic"].map(
    (type) => ({ type, data: { message: hostile } }),
  );
  assert.equal(
    (await collect([...benign, ...names.map((_, i) => outcome(i)), summary()]))
      .text,
    INTEGRATION_OK,
  );
});
test("real unknown test name cannot substitute for a reviewed manifest case", () => {
  const r = real(`names[0]=${JSON.stringify(hostile)}`);
  assert.equal(r.result.status, 1);
  safe(r.channel);
  assert.ok(
    r.channel.startsWith("NATIVE_PG_FAILURE INTEGRATION_REPORT_INVALID\n"),
  );
});
test("parser rejects malformed or contradictory evidence and preserves safe primary/cleanup ownership", async () => {
  const valid = (
    await collect([
      outcome(0, "fail"),
      ...names.slice(1).map((_, i) => outcome(i + 1)),
      summary(15, 1),
    ])
  ).text;
  for (const malformed of [
    valid.replace("CASE_01", "CASE_17"),
    valid.replace("CASE_01", hostile),
    valid.replace("COMPLETE", "PARTIAL"),
    valid.replace("16 15 1", "17 15 1"),
    valid.replace("16 15 1", "016 15 1"),
    valid.replace("16 15 1", "16 15 NaN"),
    valid.replace("16 15 1", "16 15 -1"),
    valid.replace("TOTALS FAILURE", "TOTALS SUCCESS"),
    valid.replace("TOTALS FAILURE 16", "TOTALS FAILURE 99"),
    valid.replace("CASE_FAILURE", "FILE_FAILURE"),
    valid.replace("CASE_FAILURE", "UNKNOWN"),
    valid.replace("INTEGRATION_TEST_FAILED", "INTEGRATION_TEST_SKIPPED"),
    valid
      .replace("INTEGRATION_TEST_FAILED", "INTEGRATION_REPORT_INVALID")
      .replace("CASE_FAILURE CASE_01", "REPORTING_FAILURE NONE"),
    valid
      .replace("INTEGRATION_TEST_FAILED", "INTEGRATION_SUMMARY_MISSING")
      .replace("CASE_FAILURE CASE_01", "REPORTING_FAILURE NONE"),
    "NATIVE_PG_FAILURE INTEGRATION_INCOMPLETE\nNATIVE_PG_INTEGRATION REPORTING_FAILURE NONE PARTIAL 1 1 0 0 0 0\n",
    valid.replace("\nNATIVE_PG_TOTALS", "\r\nNATIVE_PG_TOTALS"),
    valid.split("NATIVE_PG_TOTALS")[0],
    valid + hostile,
    valid + valid,
    valid.slice(0, -1),
  ])
    assert.equal(readFailureReport(malformed), undefined);
  await assert.rejects(
    withCleanup(
      async () => {
        throw readFailureReport(valid);
      },
      "PREPARE_POOL_CLOSE_FAILED",
      () => {
        throw Error(hostile);
      },
    ),
    (e) => {
      assert.equal(
        renderFailure(failure("INTEGRATION_CHILD_FAILED", e)),
        valid + "NATIVE_PG_CLEANUP PREPARE_POOL_CLOSE_FAILED\n",
      );
      return true;
    },
  );
});
test("parent rejects false success, partial/missing reports, nonzero exits, timeout, signal and overflow", async () => {
  const partial = (await collect([outcome(0, "fail")], true)).text;
  for (const [channel, status, extra] of [
    [INTEGRATION_OK, 1, {}],
    [INTEGRATION_OK, null, { signal: "SIGTERM" }],
    [INTEGRATION_OK, null, { error: { code: "ETIMEDOUT" } }],
    [INTEGRATION_OK, null, { error: { code: "ENOBUFS" } }],
    ["NATIVE_PG_STATUS INTEGRATION_OK_16\n", 0, {}],
    [partial, 0, {}],
    ["", 0, {}],
    [INTEGRATION_OK + hostile, 0, {}],
    [INTEGRATION_OK.slice(0, -1), 0, {}],
  ] as const) {
    const spawn = ((
      _f: unknown,
      _a: unknown,
      options: { timeout: number; maxBuffer: number },
    ) => {
      assert.equal(options.timeout, 180000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      return {
        status,
        signal: null,
        ...extra,
        output: [null, hostile, hostile, channel],
      };
    }) as unknown as typeof spawnSync;
    assert.throws(
      () => executeCiChild([], {}, "integrate", spawn),
      (e) => {
        safe(renderFailure(e));
        return true;
      },
    );
  }
});
