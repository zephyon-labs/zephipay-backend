import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import type { Pool, PoolConfig } from "pg";
import ts from "typescript";
import * as diagnostics from "./helpers/nativePostgresDiagnostics";
import {
  nativeDisposableTarget,
  verifyNativeDisposable,
} from "./helpers/nativePostgresTarget";

const designation = {
  NATIVE_SESSION_TEST_DATABASE: "zephipay_native_session_test_0123456789abcdef",
  NATIVE_SESSION_TEST_PORT: "55432",
  NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_LOCAL_NATIVE_SESSION_V1",
};
const target = nativeDisposableTarget(designation);
const runtimePath = "pg_catalog,public,pg_temp";
const identity = {
  database: target.database,
  username: "native_session_fixture",
  address: "127.0.0.1",
  port: target.port,
  version: 160015,
  recovery: false,
  marker: target.marker,
};
const migrationFile = "migrations/002_identity_foundation.sql";
const candidateFile = "sql/candidates/native-session-postgres-v1.sql";
type Controls = {
  version?: unknown;
  ignoreBegin?: boolean;
  ignoreLocal?: boolean;
  beginCommand?: string;
  commitCommand?: string;
  context?: Record<string, unknown>;
  initialTransactionId?: unknown;
  failAt?: string;
  failRollback?: boolean;
  failRelease?: boolean;
  failEnd?: boolean;
  failConnect?: boolean;
  thrown?: unknown;
  count?: string;
};

/** Runs the actual CLI source with a fake pg module and isolated process environment.
 * The small transcript model is NOT a SQL parser/server or evidence of live PostgreSQL behavior.
 * The real pg module is never loaded by the CLI, and no socket/database is opened.
 */
async function preparation(controls: Controls = {}) {
  const scriptFile = path.resolve(
    "scripts/prepare-native-session-postgres-local.ts",
  );
  const [source, migration, candidate] = await Promise.all([
    fs.readFile(scriptFile, "utf8"),
    fs.readFile(migrationFile, "utf8"),
    fs.readFile(candidateFile, "utf8"),
  ]);
  const queries: { sql: string; leased: boolean; values: unknown[] }[] = [];
  const failures: string[] = [],
    releases: boolean[] = [];
  let options: PoolConfig | undefined;
  let inTransaction = false,
    localPath: string | undefined,
    connects = 0,
    ended = false;
  let transactionId = 40,
    staged = 0,
    committed = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const effectivePath = () => localPath ?? runtimePath;
  const xid = () => String(inTransaction ? transactionId : ++transactionId);
  const version = Object.hasOwn(controls, "version")
    ? controls.version
    : identity.version;
  const query = async (sql: string, values: unknown[] = [], leased = false) => {
    // Copy the VM's parameter array into this realm; preserve every parameter value.
    queries.push({ sql, leased, values: Array.from(values) });
    try {
      if (
        (controls.failAt && sql.includes(controls.failAt)) ||
        (controls.failRollback && sql === "ROLLBACK")
      )
        throw controls.thrown ?? new Error("Injected statement failure");
      if (sql === "BEGIN") {
        if (!controls.ignoreBegin) {
          inTransaction = true;
          transactionId++;
        }
        return { command: controls.beginCommand ?? "BEGIN", rows: [] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        const command =
          sql === "COMMIT" ? (controls.commitCommand ?? "COMMIT") : "ROLLBACK";
        if (command === "COMMIT") committed = staged;
        staged = 0;
        localPath = undefined;
        inTransaction = false;
        return { command, rows: [] };
      }
      if (sql.includes("pg_is_in_recovery()"))
        return { rows: [{ ...identity, version }] };
      if (sql.includes("FROM pg_class"))
        return { rows: [{ count: controls.count ?? "0" }] };
      if (sql.startsWith("SET LOCAL search_path")) {
        if (inTransaction && !controls.ignoreLocal)
          localPath = sql.slice(sql.indexOf("=") + 1).replace(/\s/g, "");
        return { command: "SET", rows: [] };
      }
      if (sql.includes("current_schema()"))
        return {
          rows: [
            {
              transaction_id: xid(),
              schema: effectivePath().split(",")[0],
              search_path: effectivePath(),
              schema_usage: true,
              schema_create: true,
              database_create: true,
              language_usage: true,
              ...controls.context,
            },
          ],
        };
      if (sql.includes("pg_current_xact_id()"))
        return {
          rows: [
            {
              transaction_id: Object.hasOwn(controls, "initialTransactionId")
                ? controls.initialTransactionId
                : xid(),
            },
          ],
        };
      if (sql.startsWith("CREATE TABLE public.payment_schema_migrations")) {
        staged++;
        return { command: "CREATE", rows: [] };
      }
      if (sql === migration) {
        assert.match(sql, /^CREATE TYPE account_status AS ENUM/);
        if (effectivePath().split(",")[0] !== "public")
          throw new Error(
            'permission denied to create "pg_catalog.account_status" (modeled original failure)',
          );
        staged++;
        return { command: "CREATE", rows: [] };
      }
      if (sql === candidate) {
        staged++;
        return { command: "CREATE", rows: [] };
      }
      if (sql.startsWith("INSERT INTO public.payment_schema_migrations"))
        return { rows: [] };
      throw new Error(`Unexpected preparation statement: ${sql}`);
    } catch (error) {
      failures.push("query failed");
      throw error;
    }
  };
  class FakePool {
    constructor(config: PoolConfig) {
      options = config;
    }
    query = (sql: string, values?: unknown[]) => query(sql, values, false);
    async connect() {
      connects++;
      if (controls.failConnect)
        throw controls.thrown ?? new Error("connect failed");
      return {
        query: (sql: string, values?: unknown[]) => query(sql, values, true),
        release: (destroy = false) => {
          releases.push(destroy);
          if (controls.failRelease)
            throw controls.thrown ?? new Error("release failed");
        },
      };
    }
    async end() {
      ended = true;
      finish();
      if (controls.failEnd) throw controls.thrown ?? new Error("end failed");
    }
  }
  const processDouble = {
    env: { ...designation },
    exitCode: 0,
    stdout: {
      text: "",
      write(text: string) {
        this.text += text;
      },
    },
    stderr: {
      text: "",
      write(text: string) {
        this.text += text;
      },
    },
  };
  const modules: Record<string, unknown> = {
    pg: { Pool: FakePool },
    "node:crypto": { createHash },
    "node:fs/promises": fs,
    "../tests/helpers/nativePostgresTarget": {
      nativeDisposableTarget,
      verifyNativeDisposable,
    },
    "../tests/helpers/nativePostgresDiagnostics": diagnostics,
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  new Script(compiled.outputText, { filename: scriptFile }).runInNewContext({
    exports: {},
    process: processDouble,
    require: (name: string) => {
      assert.ok(
        Object.hasOwn(modules, name),
        `Unexpected CLI dependency: ${name}`,
      );
      return modules[name];
    },
  });
  let timer!: NodeJS.Timeout;
  try {
    await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Preparation double did not finish")),
          2000,
        );
      }),
    ]);
    // Let main's finalizers and sanitized top-level rejection handler finish.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    clearTimeout(timer);
  }
  return {
    queries,
    failures,
    releases,
    options,
    connects,
    ended,
    committed,
    path: effectivePath(),
    process: processDouble,
  };
}

test("actual preparation CLI targets public for unchanged migration 002 with the real fixture options", async () => {
  const r = await preparation();
  assert.equal(r.process.exitCode, 0, r.failures.join("; "));
  assert.equal(r.process.stdout.text, diagnostics.PREPARATION_OK);
  assert.equal(r.options?.options, `-c search_path=${runtimePath}`);
  assert.equal(r.options?.host, "127.0.0.1");
  assert.equal(r.options?.database, target.database);
  assert.equal(r.connects, 1);
  assert.ok(
    r.queries.every((q) => q.leased),
    "checks and DDL must share one leased transaction",
  );
  assert.equal(r.queries[0].sql, "BEGIN");
  const at = (text: string) => r.queries.findIndex((q) => q.sql.includes(text));
  assert.ok(at("pg_is_in_recovery()") < at("SET LOCAL search_path"));
  assert.ok(at("SET LOCAL search_path") < at("current_schema()"));
  assert.ok(
    at("current_schema()") <
      at("CREATE TABLE public.payment_schema_migrations"),
  );
  const sql = await fs.readFile(migrationFile, "utf8");
  assert.ok(
    r.queries.some((q) => q.sql === sql),
    "apply migration bytes without rewriting DDL",
  );
  const ledgers = r.queries.filter((q) =>
    q.sql.startsWith("INSERT INTO public.payment_schema_migrations"),
  );
  assert.deepEqual(
    ledgers.map((q) => q.values),
    [
      [
        "002_identity_foundation.sql",
        createHash("sha256").update(sql).digest("hex"),
      ],
      [
        "candidate_native_session_postgres_v1.sql",
        createHash("sha256")
          .update(await fs.readFile(candidateFile))
          .digest("hex"),
      ],
    ],
  );
  assert.equal(r.committed, 3);
  assert.equal(r.queries.at(-1)?.sql, "COMMIT");
  assert.equal(
    r.path,
    runtimePath,
    "transaction-local creation path must not survive commit",
  );
  assert.deepEqual(
    r.releases,
    [true],
    "one-shot preparation client must not return to a pool",
  );
  assert.equal(r.ended, true);
});

const invalidVersions: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["NaN", NaN],
  ["positive infinity", Infinity],
  ["negative infinity", -Infinity],
  ["nonnumeric string", "not-a-version"],
  ["numeric string", "160015"],
  ["fraction", 160015.5],
  ["boxed number", new Number(160015)],
  ["PostgreSQL 15", 159999],
  ["PostgreSQL 17", 170000],
  ["negative", -160015],
];
for (const [name, version] of invalidVersions) {
  test(`disposable safety rejects ${name} version before even checking emptiness`, async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        return { rows: [{ ...identity, version }] };
      },
    } as unknown as Pick<Pool, "query">;
    await assert.rejects(
      () => verifyNativeDisposable(pool, target, false),
      /identity verification/,
    );
    assert.equal(calls, 1);
  });
  test(`actual preparation cannot apply any DDL with ${name} version`, async () => {
    const r = await preparation({ version });
    assert.equal(r.process.exitCode, 1);
    assert.equal(r.process.stdout.text, "");
    assert.ok(!r.queries.some((q) => /^(CREATE|INSERT|SET LOCAL)/.test(q.sql)));
    assert.equal(r.committed, 0);
    assert.equal(r.queries.at(-1)?.sql, "ROLLBACK");
  });
}
for (const version of [160000, 160015, 169999])
  test(`valid PostgreSQL 16 integer ${version} retains successful preparation`, async () => {
    const r = await preparation({ version });
    assert.equal(r.process.exitCode, 0, r.failures.join("; "));
    assert.equal(r.committed, 3);
  });

const rejectedContexts: [string, Controls][] = [
  ["BEGIN failure", { failAt: "BEGIN" }],
  ["missing BEGIN acknowledgement", { beginCommand: "" }],
  ["lost transaction scope", { ignoreBegin: true }],
  ["ineffective SET LOCAL", { ignoreLocal: true }],
  ["SET LOCAL failure", { failAt: "SET LOCAL" }],
  ["missing transaction identifier", { initialTransactionId: null }],
  ["changed transaction identifier", { context: { transaction_id: "999" } }],
  ["missing public schema", { context: { schema: null } }],
  ["catalog creation target", { context: { schema: "pg_catalog" } }],
  [
    "unexpected creation path",
    { context: { search_path: "public,untrusted" } },
  ],
  ["missing public USAGE", { context: { schema_usage: false } }],
  ["missing public CREATE", { context: { schema_create: false } }],
  ["missing database CREATE", { context: { database_create: false } }],
  ["missing plpgsql USAGE", { context: { language_usage: false } }],
  ["malformed privilege metadata", { context: { schema_create: "true" } }],
  ["unavailable context query", { failAt: "current_schema()" }],
  ["occupied database", { count: "1" }],
];
for (const [name, controls] of rejectedContexts)
  test(`preparation fails before DDL on ${name}`, async () => {
    const r = await preparation(controls);
    assert.equal(r.process.exitCode, 1);
    assert.equal(r.process.stdout.text, "");
    assert.ok(!r.queries.some((q) => /^(CREATE|INSERT)/.test(q.sql)));
    assert.equal(r.committed, 0);
    assert.equal(r.path, runtimePath);
    assert.deepEqual(r.releases, [true]);
  });

for (const failAt of [
  "CREATE TABLE public.payment_schema_migrations",
  "CREATE TYPE account_status",
  "CREATE SCHEMA native_session_candidate",
  "INSERT INTO public.payment_schema_migrations",
  "COMMIT",
])
  test(`preparation rolls back and reports no success on ${failAt} failure`, async () => {
    const r = await preparation({ failAt });
    assert.equal(r.process.exitCode, 1);
    assert.equal(r.process.stdout.text, "");
    assert.equal(r.committed, 0);
    assert.equal(r.queries.at(-1)?.sql, "ROLLBACK");
    assert.equal(r.path, runtimePath);
    assert.deepEqual(r.releases, [true]);
  });

test("rollback failure discards the preparation client and cannot report success", async () => {
  const r = await preparation({
    failAt: "CREATE TYPE account_status",
    failRollback: true,
  });
  assert.equal(r.process.exitCode, 1);
  assert.equal(r.process.stdout.text, "");
  assert.deepEqual(r.releases, [true]);
  assert.equal(r.ended, true);
});
test("COMMIT returning ROLLBACK is never acknowledged as successful preparation", async () => {
  const r = await preparation({ commitCommand: "ROLLBACK" });
  assert.equal(r.process.exitCode, 1);
  assert.equal(r.process.stdout.text, "");
  assert.equal(r.committed, 0);
});

const hostile = new Error(
  "SECRET_SENTINEL\n::error::forged\r\nNATIVE_PG_FAILURE CONTEXT_REJECTED",
);
for (const [controls, code] of [
  [{ failConnect: true }, "PREPARE_CONNECT_FAILED"],
  [{ failAt: "BEGIN" }, "PREPARE_BEGIN_FAILED"],
  [{ version: null }, "PREPARE_IDENTITY_FAILED"],
  [{ failAt: "pg_current_xact_id()" }, "PREPARE_TRANSACTION_FAILED"],
  [{ context: { schema_create: false } }, "PREPARE_SCHEMA_FAILED"],
  [{ failAt: "CREATE TYPE account_status" }, "PREPARE_DDL_FAILED"],
  [{ failAt: "COMMIT" }, "PREPARE_COMMIT_FAILED"],
  [{ failRelease: true }, "PREPARE_RELEASE_FAILED"],
  [{ failEnd: true }, "PREPARE_POOL_CLOSE_FAILED"],
] as [Controls, string][])
  test(`preparation reports only ${code} for injected failure`, async () => {
    const r = await preparation({ ...controls, thrown: hostile });
    assert.equal(r.process.exitCode, 1);
    assert.equal(r.process.stdout.text, "");
    assert.equal(r.process.stderr.text, `NATIVE_PG_FAILURE ${code}\n`);
    assert.equal(r.ended, true);
  });
test("preparation preserves DDL failure across rollback, release and pool cleanup failures", async () => {
  const r = await preparation({
    failAt: "CREATE TYPE account_status",
    failRollback: true,
    failRelease: true,
    failEnd: true,
    thrown: hostile,
  });
  assert.equal(r.process.exitCode, 1);
  assert.equal(r.process.stdout.text, "");
  assert.equal(
    r.process.stderr.text,
    "NATIVE_PG_FAILURE PREPARE_DDL_FAILED\nNATIVE_PG_CLEANUP PREPARE_ROLLBACK_FAILED\nNATIVE_PG_CLEANUP PREPARE_RELEASE_FAILED\nNATIVE_PG_CLEANUP PREPARE_POOL_CLOSE_FAILED\n",
  );
  assert.deepEqual(r.releases, [true]);
  assert.equal(r.queries.filter((q) => q.sql === "ROLLBACK").length, 1);
  assert.equal(r.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(r.committed, 0);
});
