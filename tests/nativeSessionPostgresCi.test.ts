import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Pool, PoolConfig } from "pg";
import {
  CI_IMAGE,
  CI_PROFILE,
  CI_TMPFS,
  CI_TMPFS_OPTIONS,
  CI_ADMIN,
  ciContext,
  ciDisposableTarget,
  verifyCiEvidence,
  verifyCiDisposable,
  inspectCiMetadata,
} from "./helpers/nativePostgresCiSafety";
import {
  nativeDisposableTarget,
  verifyNativeDisposable,
} from "./helpers/nativePostgresTarget";
import {
  runNativeCi,
  nativeCiExit,
  executeCiChild,
  type CiDriver,
} from "../scripts/run-native-session-postgres-ci";
import {
  atStage,
  failure,
  renderFailure,
  readFailureReport,
  PREPARATION_OK,
  INTEGRATION_OK,
  atInspection,
  withCleanup,
  type InspectionOrigin,
} from "./helpers/nativePostgresDiagnostics";

const env = {
  NATIVE_SESSION_TEST_PROFILE: CI_PROFILE,
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Linux",
  RUNNER_ARCH: "X64",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "zephyon-labs/zephipay-backend",
  GITHUB_REPOSITORY_ID: "1247983326",
  GITHUB_JOB: "verify",
  GITHUB_WORKFLOW: "Backend CI",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REF: "refs/pull/20/merge",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "1",
  NATIVE_SESSION_CI_SERVICE_ID: "b".repeat(64),
  NATIVE_SESSION_CI_ORIGINAL_SERVICE_ID: "c".repeat(64),
  NATIVE_SESSION_CI_NETWORK: `github_network_${"d".repeat(32)}`,
  NATIVE_SESSION_CI_PORT: "55432",
};
const designation = {
  ...env,
  NATIVE_SESSION_TEST_DATABASE: "zephipay_native_session_test_0123456789abcdef",
  NATIVE_SESSION_TEST_PORT: "55432",
  NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_GITHUB_NATIVE_SESSION_V1",
};
const context = ciContext(env);
function evidence() {
  return {
    head: env.GITHUB_SHA,
    image: {
      id: `sha256:${"e".repeat(64)}`,
      digests: [`postgres@${CI_IMAGE.split("@")[1]}`],
      os: "linux",
      arch: "amd64",
    },
    container: {
      id: context.service,
      imageRef: CI_IMAGE,
      imageId: `sha256:${"e".repeat(64)}`,
      labels: {
        "zephyon.native.fixture": CI_PROFILE,
        "zephyon.native.repository": context.repository,
        "zephyon.native.run": context.run,
        "zephyon.native.attempt": context.attempt,
        "zephyon.native.source": context.sha,
      },
      state: {
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Status: "running",
        Health: { Status: "healthy" },
      },
      restarts: 0,
      entrypoint: ["docker-entrypoint.sh"],
      cmd: ["postgres"],
      host: {
        networkMode: context.network,
        privileged: false,
        binds: null,
        volumesFrom: null,
        mounts: null,
        devices: [],
        capAdd: null,
        restart: { Name: "no", MaximumRetryCount: 0 },
        tmpfs: { [CI_TMPFS]: CI_TMPFS_OPTIONS },
        bindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
      },
      ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
      mounts: [],
      networks: {
        [context.network]: {
          NetworkID: "f".repeat(64),
          IPAddress: "172.20.0.3",
          Gateway: "172.20.0.1",
          IPPrefixLen: 16,
          GlobalIPv6Address: "",
          EndpointID: "1".repeat(64),
        },
      },
    },
    network: {
      id: "f".repeat(64),
      name: context.network,
      driver: "bridge",
      scope: "local",
      internal: false,
      ipam: [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }],
      containers: {
        [context.service]: {
          IPv4Address: "172.20.0.3/16",
          EndpointID: "1".repeat(64),
        },
        [context.originalService]: { IPv4Address: "172.20.0.2/16" },
      },
    },
  };
}
const identity = {
  database: designation.NATIVE_SESSION_TEST_DATABASE,
  username: "native_session_fixture",
  address: "172.20.0.3",
  port: 5432,
  client_address: "172.20.0.1",
  client_port: 45000,
  version: 160015,
  recovery: false,
  marker: `ZEPHIPAY_NATIVE_SESSION_DISPOSABLE_V1:${designation.NATIVE_SESSION_TEST_DATABASE}`,
};
function fakePool(rows: Record<string, unknown>[], count: unknown = "0") {
  const queries: string[] = [];
  return {
    queries,
    pool: {
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: sql.includes("current_database()") ? rows : [{ count }],
        };
      },
    } as unknown as Pick<Pool, "query">,
  };
}

test("CI profile binds exact run, image, published loopback port and separate bridge endpoint", async () => {
  assert.deepEqual(verifyCiEvidence(context, evidence()), {
    service: context.service,
    networkId: "f".repeat(64),
    imageId: `sha256:${"e".repeat(64)}`,
    server: "172.20.0.3",
    gateway: "172.20.0.1",
  });
  const target = ciDisposableTarget(designation, evidence);
  assert.equal(target.pool.host, "127.0.0.1");
  assert.equal(target.pool.port, 55432);
  assert.equal(target.pool.options, "-c search_path=pg_catalog,public,pg_temp");
  assert.ok(Object.isFrozen(target) && Object.isFrozen(target.pool));
  const fake = fakePool([identity]);
  await verifyNativeDisposable(fake.pool, target, true);
  assert.equal(fake.queries.length, 2);
  assert.match(fake.queries[1], /FROM pg_type/);
  assert.match(fake.queries[1], /FROM pg_namespace/);
});
test("metadata collector uses only bounded projected inspections against the explicit local socket", () => {
  const data = evidence(),
    commands: { file: string; args: string[] }[] = [];
  const result = inspectCiMetadata(context, (file, args) => {
    commands.push({ file, args });
    if (file === "/usr/bin/git") return context.sha;
    assert.equal(file, "/usr/bin/docker");
    assert.deepEqual(args.slice(0, 2), [
      "--host",
      "unix:///var/run/docker.sock",
    ]);
    assert.ok(args.includes("--format"));
    const template = args[args.indexOf("--format") + 1];
    assert.ok(
      !/Config\.Env|Health\.Log|HOST_FIELDS|STATE_FIELDS/.test(template),
    );
    return JSON.stringify(
      args[2] === "image"
        ? data.image
        : args[2] === "network"
          ? data.network
          : data.container,
    );
  });
  assert.deepEqual(result, data);
  assert.equal(commands.length, 4);
  assert.equal(commands[0].args.at(-1), context.service);
  assert.deepEqual(commands[1], {
    file: "/usr/bin/git",
    args: ["rev-parse", "HEAD"],
  });
  assert.equal(commands[2].args.at(-1), CI_IMAGE);
  assert.equal(commands[3].args.at(-1), context.network);
  assert.throws(() => inspectCiMetadata(context, () => "malformed-json"));
  assert.throws(() =>
    inspectCiMetadata(context, () => {
      throw new Error("unavailable executable");
    }),
  );
});
test("the explicit reviewed tmpfs is the only allowable reported mount", () => {
  const data = evidence();
  const withMount = {
    ...data,
    container: {
      ...data.container,
      mounts: [{ Type: "tmpfs", Source: "", Destination: CI_TMPFS, RW: true }],
    },
  };
  assert.doesNotThrow(() => verifyCiEvidence(context, withMount));
});
for (const key of Object.keys(env))
  test(`CI context rejects missing ${key}`, () => {
    const input: Record<string, string> = { ...env };
    delete input[key];
    assert.throws(() => ciContext(input));
  });
for (const [key, value] of Object.entries({
  RUNNER_ENVIRONMENT: "self-hosted",
  GITHUB_REPOSITORY_ID: "1",
  GITHUB_EVENT_NAME: "pull_request_target",
  GITHUB_REF: "refs/heads/feature",
  GITHUB_SHA: "abc",
  GITHUB_RUN_ATTEMPT: "0",
  NATIVE_SESSION_CI_SERVICE_ID: context.originalService,
  NATIVE_SESSION_CI_PORT: "5432",
  NATIVE_SESSION_CI_NETWORK: "bridge",
  PGHOST: "127.0.0.1",
  DATABASE_URL: "unused",
  TEST_DATABASE_URL: "unused",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  DOCKER_CONTEXT: "default",
  NODE_OPTIONS: "--import=unreviewed",
}))
  test(`CI context rejects conflicting ${key}`, () =>
    assert.throws(() => ciContext({ ...env, [key]: value })));
test("CI=true is insufficient and unknown profiles never fall back", () => {
  assert.throws(() => ciContext({ CI: "true" }));
  assert.throws(() =>
    nativeDisposableTarget({
      ...designation,
      NATIVE_SESSION_TEST_PROFILE: "unknown",
    }),
  );
  assert.throws(() =>
    nativeDisposableTarget({
      ...designation,
      NATIVE_SESSION_TEST_PROFILE: undefined,
    }),
  );
  assert.throws(() => ciContext(env, "win32", "x64"));
  assert.throws(() => ciContext(env, "linux", "arm64"));
  assert.doesNotThrow(() =>
    ciContext({
      ...env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
    }),
  );
});

const mutations: [string, string[], unknown][] = [
  ["checkout identity", ["head"], "0".repeat(40)],
  ["container identity", ["container", "id"], context.originalService],
  ["image tag only", ["container", "imageRef"], "postgres:16"],
  ["image digest", ["image", "digests"], []],
  ["image architecture", ["image", "arch"], "arm64"],
  ["run label", ["container", "labels", "zephyon.native.run"], "4321"],
  ["stopped service", ["container", "state", "Running"], false],
  [
    "unhealthy service",
    ["container", "state", "Health", "Status"],
    "unhealthy",
  ],
  ["service restarted", ["container", "restarts"], 1],
  ["custom command", ["container", "cmd"], ["postgres", "-c", "fsync=off"]],
  ["privileged", ["container", "host", "privileged"], true],
  ["host networking", ["container", "host", "networkMode"], "host"],
  [
    "host bind",
    ["container", "host", "binds"],
    ["/data:/var/lib/postgresql/data"],
  ],
  ["inherited volumes", ["container", "host", "volumesFrom"], ["historical"]],
  ["host mount specification", ["container", "host", "mounts"], [{}]],
  [
    "named volume",
    ["container", "mounts"],
    [{ Type: "volume", Destination: CI_TMPFS, RW: true }],
  ],
  [
    "unexpected tmpfs",
    ["container", "mounts"],
    [{ Type: "tmpfs", Destination: "/other", RW: true }],
  ],
  ["missing tmpfs", ["container", "host", "tmpfs"], {}],
  ["wrong tmpfs limit", ["container", "host", "tmpfs", CI_TMPFS], "rw"],
  ["automatic restart", ["container", "host", "restart", "Name"], "always"],
  [
    "public bind",
    ["container", "ports", "5432/tcp"],
    [{ HostIp: "0.0.0.0", HostPort: "55432" }],
  ],
  [
    "wrong host port",
    ["container", "ports", "5432/tcp"],
    [{ HostIp: "127.0.0.1", HostPort: "5432" }],
  ],
  [
    "requested public bind",
    ["container", "host", "bindings", "5432/tcp"],
    [{ HostIp: "0.0.0.0", HostPort: "55432" }],
  ],
  [
    "dual publication",
    ["container", "ports", "5432/tcp"],
    [
      { HostIp: "127.0.0.1", HostPort: "55432" },
      { HostIp: "::", HostPort: "55432" },
    ],
  ],
  ["extra published port", ["container", "ports", "1234/tcp"], []],
  ["network identity", ["network", "id"], "0".repeat(64)],
  ["wrong network type", ["network", "driver"], "overlay"],
  [
    "gateway mismatch",
    ["network", "ipam"],
    [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.8" }],
  ],
  [
    "outside subnet",
    ["network", "ipam"],
    [{ Subnet: "172.21.0.0/16", Gateway: "172.20.0.1" }],
  ],
  [
    "endpoint mismatch",
    ["network", "containers", context.service, "IPv4Address"],
    "172.20.0.4/16",
  ],
  [
    "shared database endpoint",
    ["network", "containers", context.originalService, "IPv4Address"],
    "172.20.0.3/16",
  ],
  ["malformed metadata", ["container", "state"], null],
];
for (const [name, keys, value] of mutations)
  test(`CI rejects ${name}`, () => {
    const data = evidence();
    let cursor = data as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1))
      cursor = cursor[key] as Record<string, unknown>;
    cursor[keys.at(-1)!] = value;
    assert.throws(() => verifyCiEvidence(context, data));
  });
test("service replacement is rejected before a database query", async () => {
  const data = evidence(),
    target = ciDisposableTarget(designation, () => data),
    fake = fakePool([identity]);
  data.container.restarts = 1;
  await assert.rejects(verifyCiDisposable(fake.pool, target, false));
  assert.equal(fake.queries.length, 0);
});
for (const version of [
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  "160015",
  "bad",
  160015.5,
  150015,
  170000,
  160014,
])
  test(`CI SQL version rejects ${String(version)}`, async () => {
    await assert.rejects(
      verifyCiDisposable(
        fakePool([{ ...identity, version }]).pool,
        ciDisposableTarget(designation, evidence),
        true,
      ),
    );
  });
for (const [key, value] of Object.entries({
  database: "economic_ci",
  username: "economic_ci",
  address: "127.0.0.1",
  port: 55432,
  client_address: "172.20.0.99",
  client_port: 0,
  marker: "wrong",
  recovery: true,
}))
  test(`CI SQL identity rejects wrong ${key}`, async () => {
    await assert.rejects(
      verifyCiDisposable(
        fakePool([{ ...identity, [key]: value }]).pool,
        ciDisposableTarget(designation, evidence),
        true,
      ),
    );
  });
for (const count of [undefined, null, 0, "1", "NaN"])
  test(`CI empty target rejects ${String(count)} metadata`, async () => {
    // Pass undefined explicitly without fakePool's convenience default.
    const fake = {
      query: async (sql: string) => ({
        rows: sql.includes("current_database()") ? [identity] : [{ count }],
      }),
    } as unknown as Pick<Pool, "query">;
    await assert.rejects(
      verifyCiDisposable(fake, ciDisposableTarget(designation, evidence), true),
    );
  });
test("local profile still rejects bridge addresses and host/server port translation", async () => {
  const target = nativeDisposableTarget({
    ...designation,
    NATIVE_SESSION_TEST_PROFILE: undefined,
    NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_LOCAL_NATIVE_SESSION_V1",
    CI: "true",
  });
  await assert.rejects(
    verifyNativeDisposable(fakePool([identity]).pool, target, false),
  );
  await verifyNativeDisposable(
    fakePool([{ ...identity, address: "127.0.0.1", port: 55432 }]).pool,
    target,
    false,
  );
});

function harness(
  fault = "",
  thrown: unknown = new Error("injected"),
  failCleanup = false,
) {
  const calls: string[] = [],
    children: { args: string[]; env: Record<string, string | undefined> }[] =
      [];
  let config: PoolConfig | undefined;
  const driver: CiDriver = {
    inspect: () => {
      calls.push("inspect");
      if (fault === "inspect") throw thrown;
      if (fault === "metadata") return { ...evidence(), head: "invalid" };
      return evidence();
    },
    random: () => "0123456789abcdef",
    connect: (value) => {
      calls.push("connect");
      if (fault === "connect") throw thrown;
      config = value;
      return {
        end: async () => {
          calls.push("end");
          if (fault === "end" || failCleanup) throw thrown;
        },
        query: (async (sql: string) => {
          calls.push(sql);
          if (sql.includes("current_database()"))
            return {
              rows: [
                {
                  ...identity,
                  database: "postgres",
                  username: CI_ADMIN,
                  marker: null,
                  version: fault === "version" ? NaN : 160015,
                },
              ],
            };
          if (sql.includes("FROM pg_class"))
            return { rows: [{ count: fault === "occupied" ? "1" : "0" }] };
          if (sql.includes("SELECT datname"))
            return {
              rows: (fault === "database"
                ? ["existing", "postgres", "template0", "template1"]
                : ["postgres", "template0", "template1"]
              ).map((datname) => ({ datname })),
            };
          if (sql.includes("SELECT rolname"))
            return {
              rows:
                fault === "role" ? [{ rolname: "native_session_fixture" }] : [],
            };
          if (fault && sql.startsWith(fault)) throw thrown;
          return {
            rows: [],
            command: fault === "ack" ? "UNKNOWN" : sql.split(" ")[0],
          };
        }) as Pool["query"],
      };
    },
    child: (args, childEnv) => {
      calls.push("child");
      children.push({ args, env: childEnv });
      if (
        fault === "preparation" ||
        (fault === "suite" && children.length === 2)
      )
        throw thrown;
    },
  };
  return { calls, children, driver, config: () => config };
}
test("driver validates before connecting, provisions a fresh target then runs accepted preparation and suite serially", async () => {
  const h = harness();
  await runNativeCi(env, h.driver);
  assert.equal(h.calls[0], "inspect");
  assert.equal(h.calls[1], "connect");
  assert.equal(h.config()?.database, "postgres");
  assert.equal(h.config()?.port, 55432);
  assert.equal(h.config()?.user, CI_ADMIN);
  const creates = h.calls.filter((s) => /^(CREATE|COMMENT)/.test(s));
  assert.equal(creates.length, 3);
  assert.match(creates[0], /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/);
  assert.match(creates[1], /TEMPLATE template0$/);
  assert.ok(!h.calls.some((s) => /DROP|IF EXISTS|TRUNCATE/.test(s)));
  assert.ok(h.calls.indexOf("end") < h.calls.indexOf("child"));
  assert.equal(h.children.length, 2);
  assert.match(
    h.children[0].args.at(-1)!,
    /prepare-native-session-postgres-local/,
  );
  assert.ok(h.children[1].args.includes("--test-concurrency=1"));
  assert.ok(
    h.children[1].args.includes(
      "--test-reporter=./scripts/native-postgres-ci-reporter.cjs",
    ),
  );
  assert.equal(h.children[0].env, h.children[1].env);
  assert.equal(
    h.children[0].env.NATIVE_SESSION_TEST_DATABASE,
    designation.NATIVE_SESSION_TEST_DATABASE,
  );
  assert.equal(h.children[0].env.NATIVE_SESSION_TEST_PROFILE, CI_PROFILE);
  assert.equal(
    h.children[0].env.NATIVE_SESSION_TEST_CONFIRM,
    "DISPOSABLE_GITHUB_NATIVE_SESSION_V1",
  );
});
for (const fault of [
  "inspect",
  "version",
  "occupied",
  "database",
  "role",
  "ack",
  "CREATE ROLE",
  "CREATE DATABASE",
  "COMMENT",
  "end",
  "preparation",
  "suite",
])
  test(`driver fails without fallback on ${fault}`, async () => {
    const h = harness(fault);
    await assert.rejects(runNativeCi(env, h.driver));
    assert.equal(
      h.children.length,
      fault === "suite" ? 2 : fault === "preparation" ? 1 : 0,
    );
    if (["inspect", "version", "occupied", "database", "role"].includes(fault))
      assert.ok(!h.calls.some((s) => s.startsWith("CREATE")));
    if (fault === "inspect") assert.ok(!h.calls.includes("connect"));
    else assert.equal(h.calls.filter((s) => s === "end").length, 1);
  });
test("driver rejects supplied target, missing execution context and malformed random identity before I/O", async () => {
  for (const input of [
    {},
    designation,
    { ...env, GITHUB_ACTIONS: undefined },
  ]) {
    const h = harness();
    await assert.rejects(runNativeCi(input, h.driver));
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  h.driver.random = () => "not-a-name";
  await assert.rejects(runNativeCi(env, h.driver));
  assert.deepEqual(h.calls, []);
});

const reporter = require("../scripts/native-postgres-ci-reporter.cjs") as (
  source: AsyncIterable<unknown>,
) => AsyncIterable<string>;
const summary = {
  type: "test:summary",
  data: {
    file: undefined,
    success: true,
    counts: {
      tests: 16,
      passed: 16,
      failed: 0,
      skipped: 0,
      todo: 0,
      cancelled: 0,
      suites: 0,
    },
  },
};
async function report(events: unknown[]) {
  let output = "";
  for await (const text of reporter(
    (async function* () {
      yield* events;
    })(),
  ))
    output += text;
  return output;
}
test("structured reporter requires a complete zero-skip manifest", async () => {
  assert.match(await report([summary]), /16 passed/);
  for (const events of [
    [],
    [{ type: "test:stdout", data: { message: "16 passed" } }],
    [summary, summary],
    [{ type: "test:fail", data: {} }],
    [{ type: "test:pass", data: { skip: true } }],
    [{ type: "test:pass", data: { todo: true } }],
    [{ ...summary, data: { ...summary.data, file: "child.ts" } }],
    [{ ...summary, data: { ...summary.data, success: false } }],
  ])
    await assert.rejects(report(events));
  for (const key of Object.keys(summary.data.counts))
    await assert.rejects(
      report([
        {
          ...summary,
          data: {
            ...summary.data,
            counts: {
              ...summary.data.counts,
              [key]: key === "tests" || key === "passed" ? 15 : 1,
            },
          },
        },
      ]),
    );
});
test("real Node reporter exits nonzero on a synthetic skipped case; no database or Docker involved", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-ci-reporter-"));
  const file = path.join(dir, "reporter.test.cjs");
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const args = [
    "--test",
    `--test-reporter=${path.resolve("scripts/native-postgres-ci-reporter.cjs")}`,
    file,
  ];
  try {
    writeFileSync(
      file,
      'const {test}=require("node:test"); for(let i=0;i<16;i++) test(`synthetic ${i}`,()=>{});',
    );
    assert.match(
      execFileSync(process.execPath, args, {
        env: childEnv,
        encoding: "utf8",
        timeout: 10_000,
        stdio: "pipe",
      }),
      /16 passed/,
    );
    writeFileSync(
      file,
      'const {test}=require("node:test"); for(let i=0;i<16;i++) test(`synthetic ${i}`,{skip:i===0},()=>{});',
    );
    assert.throws(() =>
      execFileSync(process.execPath, args, {
        env: childEnv,
        timeout: 10_000,
        stdio: "pipe",
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("all native subprocess entrypoints select the same safety contract and production source stays isolated", () => {
  for (const file of [
    "scripts/prepare-native-session-postgres-local.ts",
    "tests/postgresNativeSession.integration.ts",
    "tests/helpers/nativePostgresRecoveryWorker.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /from ["'][^"']*nativePostgresTarget["']/);
    assert.match(
      source,
      file.startsWith("scripts/")
        ? /nativeDisposableTarget\(process.env, "PRE_DDL"\)/
        : /nativeDisposableTarget\(process.env\)/,
    );
    assert.match(source, /verifyNativeDisposable\(/);
  }
  assert.match(
    readFileSync("tests/postgresNativeSession.integration.ts", "utf8"),
    /env: process.env/,
  );
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.ok(workflow.includes(CI_IMAGE));
  assert.match(workflow, /"127\.0\.0\.1:55432:5432"/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /contents: read/);
  assert.ok(
    !/pull_request_target|workflow_run|workflow_dispatch|continue-on-error|secrets\.|id-token:|environment:/.test(
      workflow,
    ),
  );
  assert.equal((workflow.match(/uses: /g) ?? []).length, 2);
  assert.match(
    workflow,
    /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
  );
  assert.ok(
    workflow.indexOf("run: npm run test:postgres") <
      workflow.indexOf(
        "run: node --import tsx scripts/run-native-session-postgres-ci.ts",
      ),
  );
});

const hostileText =
  "SECRET_SENTINEL\n::error::forged\r\nNATIVE_PG_FAILURE CONTEXT_REJECTED\nhttps://secret.invalid/token";
function hostileError(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(hostileText);
      },
      getOwnPropertyDescriptor() {
        throw new Error(hostileText);
      },
    },
  );
}
async function exitFor(
  h: ReturnType<typeof harness>,
  input: Record<string, string | undefined> = env,
) {
  let out = "",
    error = "";
  const code = await nativeCiExit(input, h.driver, {
    out: (text) => {
      out += text;
    },
    error: (text) => {
      error += text;
    },
  });
  return { code, out, error };
}
test("context rejection exits nonzero before metadata, connections or preparation", async () => {
  const h = harness();
  assert.deepEqual(
    await exitFor(h, { ...env, RUNNER_ENVIRONMENT: "self-hosted" }),
    { code: 1, out: "", error: "NATIVE_PG_FAILURE CONTEXT_REJECTED\n" },
  );
  assert.deepEqual(h.calls, []);
});
for (const [fault, code] of [
  ["inspect", "DOCKER_METADATA_FAILED"],
  ["metadata", "METADATA_REJECTED"],
  ["connect", "BOOTSTRAP_CONNECT_FAILED"],
  ["version", "BOOTSTRAP_IDENTITY_FAILED"],
  ["occupied", "BOOTSTRAP_EMPTY_REJECTED"],
  ["database", "BOOTSTRAP_INVENTORY_FAILED"],
  ["CREATE ROLE", "BOOTSTRAP_ROLE_CREATE_FAILED"],
  ["CREATE DATABASE", "BOOTSTRAP_DATABASE_CREATE_FAILED"],
  ["COMMENT", "BOOTSTRAP_MARKER_FAILED"],
  ["end", "BOOTSTRAP_CLEANUP_FAILED"],
  ["preparation", "PREPARATION_CHILD_FAILED"],
  ["suite", "INTEGRATION_CHILD_FAILED"],
])
  test(`orchestration exits nonzero with static ${code}`, async () => {
    const h = harness(fault, hostileError());
    assert.deepEqual(await exitFor(h), {
      code: 1,
      out: "",
      error: `NATIVE_PG_FAILURE ${code}\n`,
    });
    assert.equal(
      h.children.length,
      fault === "suite" ? 2 : fault === "preparation" ? 1 : 0,
    );
    if (fault === "inspect" || fault === "metadata")
      assert.ok(!h.calls.includes("connect"));
  });
test("bootstrap cleanup cannot replace an original failure or permit child execution", async () => {
  const h = harness("CREATE DATABASE", hostileError(), true);
  assert.deepEqual(await exitFor(h), {
    code: 1,
    out: "",
    error:
      "NATIVE_PG_FAILURE BOOTSTRAP_DATABASE_CREATE_FAILED\nNATIVE_PG_CLEANUP BOOTSTRAP_CLEANUP_FAILED\n",
  });
  assert.equal(h.calls.filter((s) => s === "end").length, 1);
  assert.equal(h.children.length, 0);
  assert.ok(!h.calls.some((s) => s.startsWith("COMMENT")));
});
test("ordinary orchestration success retains both children and final acknowledgement", async () => {
  const h = harness(),
    result = await exitFor(h);
  assert.equal(result.code, 0);
  assert.equal(result.error, "");
  assert.match(result.out, /all 16 integration cases passed/);
  assert.equal(h.children.length, 2);
});
for (const [index, read, parse] of [
  [
    0,
    "DOCKER_CONTAINER_UNKNOWN_EXECUTION_ERROR",
    "DOCKER_CONTAINER_PARSE_FAILED",
  ],
  [1, "CHECKOUT_READ_FAILED", undefined],
  [2, "DOCKER_IMAGE_UNKNOWN_EXECUTION_ERROR", "DOCKER_IMAGE_PARSE_FAILED"],
  [3, "DOCKER_NETWORK_UNKNOWN_EXECUTION_ERROR", "DOCKER_NETWORK_PARSE_FAILED"],
] as const)
  test(`metadata collection identifies ${read} without rendering command/error content`, () => {
    for (const mode of parse ? ["throw", "parse"] : ["throw"]) {
      const data = evidence();
      let calls = 0;
      const run = () => {
        const at = calls++;
        if (at === index) {
          if (mode === "throw") throw hostileError();
          return hostileText;
        }
        return [
          JSON.stringify(data.container),
          context.sha,
          JSON.stringify(data.image),
          JSON.stringify(data.network),
        ][at];
      };
      assert.throws(
        () => inspectCiMetadata(context, run),
        (error) => {
          assert.equal(
            renderFailure(error),
            `NATIVE_PG_FAILURE ${mode === "throw" ? read : parse}\nNATIVE_PG_INSPECTION INITIAL\n`,
          );
          return true;
        },
      );
      assert.equal(calls, index + 1);
    }
  });
test("exception text, forged code fields, causes, accessors and revoked proxies cannot select or inject diagnostics", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const thrown of [
    new Error(hostileText, { cause: hostileText }),
    hostileText,
    { code: "CONTEXT_REJECTED", message: hostileText },
    hostileError(),
    revoked.proxy,
    undefined,
    null,
  ]) {
    assert.equal(
      renderFailure(thrown),
      "NATIVE_PG_FAILURE UNCLASSIFIED_FAILURE\n",
    );
    assert.throws(
      () =>
        atStage("DOCKER_METADATA_FAILED", () => {
          throw thrown;
        }),
      (error) => {
        assert.equal(
          renderFailure(error),
          "NATIVE_PG_FAILURE DOCKER_METADATA_FAILED\n",
        );
        return true;
      },
    );
  }
  assert.equal(
    renderFailure(failure(hostileText as never)),
    "NATIVE_PG_FAILURE UNCLASSIFIED_FAILURE\n",
  );
  for (const text of [
    hostileText,
    "NATIVE_PG_FAILURE UNKNOWN\n",
    "NATIVE_PG_FAILURE CONTEXT_REJECTED\n::error::forged\n",
    "NATIVE_PG_FAILURE CONTEXT_REJECTED\r\n",
    "NATIVE_PG_FAILURE CONTEXT_REJECTED\nNATIVE_PG_CLEANUP CONTEXT_REJECTED\n",
  ])
    assert.equal(readFailureReport(text), undefined);
});
test("child execution suppresses stdout/stderr and requires its separate exact report even with exit zero", () => {
  for (const phase of ["prepare", "integrate"] as const) {
    const prefix = phase === "prepare" ? "PREPARATION" : "INTEGRATION";
    const success = phase === "prepare" ? PREPARATION_OK : INTEGRATION_OK;
    for (const [overrides, expected] of [
      [{ status: 1 }, `${prefix}_CHILD_FAILED`],
      [
        {
          status: null,
          signal: "SIGTERM",
          error: { code: "ETIMEDOUT", message: hostileText },
        },
        `${prefix}_CHILD_FAILED`,
      ],
      [{ status: null, error: hostileError() }, `${prefix}_CHILD_FAILED`],
      [{ channel: "" }, `${prefix}_REPORT_MISSING`],
      [{ channel: hostileText }, `${prefix}_REPORT_INVALID`],
      [{ channel: success + hostileText }, `${prefix}_REPORT_INVALID`],
      [
        { channel: phase === "prepare" ? INTEGRATION_OK : PREPARATION_OK },
        `${prefix}_REPORT_INVALID`,
      ],
      [
        {
          channel:
            "NATIVE_PG_FAILURE PREPARE_SCHEMA_FAILED\nNATIVE_PG_CLEANUP PREPARE_POOL_CLOSE_FAILED\n",
          status: 1,
        },
        "PREPARE_SCHEMA_FAILED",
      ],
    ] as [Record<string, unknown>, string][]) {
      const spawn = ((
        _file: string,
        _args: string[],
        options: Record<string, unknown>,
      ) => {
        assert.equal(options.timeout, 180_000);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "pipe"]);
        assert.equal(options.maxBuffer, 1024 * 1024);
        assert.equal(
          (options.env as Record<string, string>)
            .NATIVE_SESSION_CI_DIAGNOSTIC_FD,
          "3",
        );
        return {
          status: 0,
          signal: null,
          ...overrides,
          output: [
            null,
            hostileText,
            hostileText + "\nNATIVE_PG_FAILURE TARGET_REJECTED\n",
            overrides.channel ?? success,
          ],
        };
      }) as typeof spawnSync;
      assert.throws(
        () => executeCiChild([], env, phase, spawn),
        (error) => {
          const rendered = renderFailure(error);
          assert.equal(
            rendered,
            `NATIVE_PG_FAILURE ${expected}\n` +
              (expected === "PREPARE_SCHEMA_FAILED"
                ? "NATIVE_PG_CLEANUP PREPARE_POOL_CLOSE_FAILED\n"
                : ""),
          );
          return true;
        },
      );
    }
    assert.doesNotThrow(() =>
      executeCiChild([], env, phase, (() => ({
        status: 0,
        signal: null,
        output: [null, hostileText, hostileText, success],
      })) as unknown as typeof spawnSync),
    );
    assert.throws(
      () =>
        executeCiChild([], env, phase, (() => {
          throw hostileError();
        }) as typeof spawnSync),
      (error) => {
        assert.equal(
          renderFailure(error),
          `NATIVE_PG_FAILURE ${prefix}_CHILD_FAILED\n`,
        );
        return true;
      },
    );
  }
});
test("actual CLI rejects missing CI context with safe output and nonzero process status", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-native-session-postgres-ci.ts"],
    { env: {}, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "NATIVE_PG_FAILURE CONTEXT_REJECTED\n");
});
test("actual child reporter channel keeps 16 mandatory and conceals hostile test errors", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-ci-diagnostics-")),
    file = path.join(dir, "fixture.cjs");
  const args = [
    "--test",
    `--test-reporter=${path.resolve("scripts/native-postgres-ci-reporter.cjs")}`,
    file,
  ];
  try {
    for (const [count, option, body, code] of [
      [16, "{}", "", null],
      [15, "{}", "", "INTEGRATION_INCOMPLETE"],
      [16, "{skip:i===0}", "", "INTEGRATION_TEST_SKIPPED"],
      [16, "{todo:i===0}", "", "INTEGRATION_TEST_SKIPPED"],
      [
        16,
        "{}",
        `if(i===0) throw new Error(${JSON.stringify(hostileText)});`,
        "INTEGRATION_TEST_FAILED",
      ],
    ] as const) {
      writeFileSync(
        file,
        `const {test}=require('node:test'); for(let i=0;i<${count};i++)test('synthetic '+i,${option},()=>{${body}});`,
      );
      if (code === null)
        assert.doesNotThrow(() => executeCiChild(args, {}, "integrate"));
      else
        assert.throws(
          () => executeCiChild(args, {}, "integrate"),
          (error) => {
            assert.equal(renderFailure(error), `NATIVE_PG_FAILURE ${code}\n`);
            return true;
          },
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A deliberately small model of the reviewed Go JSON-map template operations, NOT
// execution of Go or Docker. It evaluates the actual production projection string.
// Strict dot lookup models missingkey=error; index of an absent map key models nil.
function projected(template: string, raw: Record<string, unknown>): string {
  const field = (keys: string[]) => {
    let value: unknown = raw;
    for (const key of keys) {
      assert.ok(
        value !== null && typeof value === "object" && !Array.isArray(value),
      );
      assert.ok(Object.hasOwn(value, key), "modeled missingkey=error");
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  };
  const result = template.replace(
    /{{json (.*?)}}/g,
    (_match, expression: string) => {
      if (expression === '(index .HostConfig "Mounts")') {
        const host = field(["HostConfig"]);
        assert.ok(
          host !== null && typeof host === "object" && !Array.isArray(host),
        );
        return JSON.stringify(
          Object.hasOwn(host, "Mounts")
            ? (host as Record<string, unknown>).Mounts
            : null,
        );
      }
      assert.match(expression, /^\.[A-Za-z]+(?:\.[A-Za-z]+)*$/);
      return JSON.stringify(field(expression.slice(1).split(".")));
    },
  );
  assert.ok(!result.includes("{{"));
  return result;
}
function rawContainer() {
  const c = evidence().container;
  return {
    Id: c.id,
    Image: c.imageId,
    Config: {
      Image: c.imageRef,
      Labels: c.labels,
      Entrypoint: c.entrypoint,
      Cmd: c.cmd,
      Env: [hostileText],
    },
    State: c.state,
    RestartCount: c.restarts,
    Mounts: c.mounts,
    NetworkSettings: { Ports: c.ports, Networks: c.networks },
    HostConfig: {
      NetworkMode: c.host.networkMode,
      PortBindings: c.host.bindings,
      Tmpfs: c.host.tmpfs,
      Binds: c.host.binds,
      VolumesFrom: c.host.volumesFrom,
      Mounts: c.host.mounts as unknown,
      Privileged: c.host.privileged,
      Devices: c.host.devices,
      CapAdd: c.host.capAdd,
      RestartPolicy: c.host.restart,
    },
  };
}
function fromRaw(raw: Record<string, unknown>, old = false) {
  return inspectCiMetadata(context, (file, args) => {
    const data = evidence();
    if (file === "/usr/bin/git") return context.sha;
    if (args[2] === "image") return JSON.stringify(data.image);
    if (args[2] === "network") return JSON.stringify(data.network);
    let template = args[args.indexOf("--format") + 1];
    if (old)
      template = template.replace(
        '(index .HostConfig "Mounts")',
        ".HostConfig.Mounts",
      );
    return projected(template, raw);
  });
}
test("offline strict-map model reproduces old missing Mounts failure and corrected omission passes", () => {
  const raw = rawContainer();
  delete (raw.HostConfig as Record<string, unknown>).Mounts;
  assert.throws(() => fromRaw(raw, true));
  const data = fromRaw(raw);
  assert.doesNotThrow(() => verifyCiEvidence(context, data));
  assert.equal(
    (data.container as ReturnType<typeof evidence>["container"]).host.mounts,
    null,
  );
  assert.ok(!JSON.stringify(data).includes("SECRET_SENTINEL"));
});
for (const value of [
  null,
  [],
  [{}],
  [{ Type: "volume" }],
  [{ Type: "tmpfs" }],
  {},
  false,
  0,
  "",
  "[]",
  [null],
])
  test(`optional mount specifications preserve and validate ${JSON.stringify(value)}`, () => {
    const raw = rawContainer();
    raw.HostConfig.Mounts = value;
    const data = fromRaw(raw);
    if (value === null || (Array.isArray(value) && value.length === 0))
      assert.doesNotThrow(() => verifyCiEvidence(context, data));
    else assert.throws(() => verifyCiEvidence(context, data));
  });
for (const keys of [
  ["Id"],
  ["Config", "Image"],
  ["Config", "Labels"],
  ["State", "Health"],
  ["HostConfig"],
  ["HostConfig", "Tmpfs"],
  ["HostConfig", "PortBindings"],
  ["HostConfig", "Binds"],
  ["HostConfig", "Privileged"],
  ["Mounts"],
  ["NetworkSettings", "Ports"],
  ["NetworkSettings", "Networks"],
])
  test(`optional compatibility does not default required ${keys.join(".")}`, () => {
    const raw = rawContainer() as Record<string, unknown>;
    let owner = raw;
    for (const key of keys.slice(0, -1))
      owner = owner[key] as Record<string, unknown>;
    delete owner[keys.at(-1)!];
    assert.throws(() => fromRaw(raw));
  });
test("wrong identity and unexpected effective storage remain rejected after optional omission", () => {
  for (const mutate of [
    (raw: ReturnType<typeof rawContainer>) => {
      raw.Id = context.originalService;
    },
    (raw: ReturnType<typeof rawContainer>) => {
      (raw.Mounts as unknown[]) = [
        { Type: "volume", Destination: CI_TMPFS, RW: true },
      ];
    },
    (raw: ReturnType<typeof rawContainer>) => {
      (raw.HostConfig.Tmpfs as unknown) = {};
    },
  ]) {
    const raw = rawContainer();
    delete (raw.HostConfig as Record<string, unknown>).Mounts;
    mutate(raw);
    assert.throws(() => verifyCiEvidence(context, fromRaw(raw)));
  }
  const data = evidence();
  delete (data.container.host as Record<string, unknown>).mounts;
  assert.throws(
    () => verifyCiEvidence(context, data),
    "missing projected field is not normalized by the validator",
  );
});
const executionFaults = [
  [{ code: "ENOENT" }, "EXECUTABLE_UNAVAILABLE"],
  [{ code: "EACCES" }, "ACCESS_DENIED"],
  [{ code: "EPERM" }, "ACCESS_DENIED"],
  [{ status: 7, signal: null }, "NONZERO_EXIT"],
  [{ code: "ETIMEDOUT", signal: "SIGTERM" }, "TIMEOUT"],
  [{ code: "ENOBUFS", signal: "SIGTERM" }, "OUTPUT_LIMIT"],
  [{ status: null, signal: "SIGTERM" }, "SIGNAL"],
  [{ code: hostileText }, "UNKNOWN_EXECUTION_ERROR"],
  [{ status: 1.5 }, "UNKNOWN_EXECUTION_ERROR"],
  [{ status: 0 }, "UNKNOWN_EXECUTION_ERROR"],
  [{ status: Infinity }, "UNKNOWN_EXECUTION_ERROR"],
  [hostileError(), "UNKNOWN_EXECUTION_ERROR"],
] as const;
for (const origin of [
  "INITIAL",
  "BOOTSTRAP_RECHECK",
  "PRE_DDL",
  "RECHECK",
] as const)
  for (const [operation, index] of [
    ["CONTAINER", 0],
    ["IMAGE", 2],
    ["NETWORK", 3],
  ] as const)
    test(`${origin} ${operation} execution failures emit finite categories only`, () => {
      for (const [thrown, reason] of executionFaults) {
        let calls = 0;
        const data = evidence();
        assert.throws(
          () =>
            inspectCiMetadata(
              context,
              () => {
                const at = calls++;
                if (at === index) throw thrown;
                return [
                  JSON.stringify(data.container),
                  context.sha,
                  JSON.stringify(data.image),
                  JSON.stringify(data.network),
                ][at];
              },
              origin,
            ),
          (error) => {
            const text = renderFailure(error);
            assert.equal(
              text,
              `NATIVE_PG_FAILURE DOCKER_${operation}_${reason}\nNATIVE_PG_INSPECTION ${origin}\n`,
            );
            assert.equal(renderFailure(readFailureReport(text)), text);
            return true;
          },
        );
        assert.equal(calls, index + 1);
      }
    });
test("classification never invokes getters, proxy traps, coercion or arbitrary exception fields", () => {
  let accesses = 0;
  const hostile = () => {
    accesses++;
    throw new Error(hostileText);
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const errors: unknown[] = [
    new Proxy({}, { get: hostile, getOwnPropertyDescriptor: hostile }),
    revoked.proxy,
    Object.create({ code: "ENOENT" }),
    undefined,
    null,
    hostileText,
    { status: { valueOf: hostile }, signal: { toString: hostile } },
  ];
  for (const key of ["code", "status", "signal"])
    errors.push(Object.defineProperty({}, key, { get: hostile }));
  for (const error of errors)
    assert.throws(
      () =>
        inspectCiMetadata(context, () => {
          throw error;
        }),
      (caught) => {
        assert.equal(
          renderFailure(caught),
          "NATIVE_PG_FAILURE DOCKER_CONTAINER_UNKNOWN_EXECUTION_ERROR\nNATIVE_PG_INSPECTION INITIAL\n",
        );
        return true;
      },
    );
  assert.equal(accesses, 0);
  const known = Object.defineProperties(
    {},
    {
      code: { value: "ENOENT" },
      message: { get: hostile },
      stderr: { get: hostile },
      stdout: { get: hostile },
      cause: { get: hostile },
    },
  );
  assert.throws(
    () =>
      inspectCiMetadata(context, () => {
        throw known;
      }),
    (caught) => {
      assert.match(
        renderFailure(caught),
        /^NATIVE_PG_FAILURE DOCKER_CONTAINER_EXECUTABLE_UNAVAILABLE\n/,
      );
      return true;
    },
  );
  assert.equal(accesses, 0);
  for (const text of [
    "NATIVE_PG_FAILURE DOCKER_CONTAINER_TIMEOUT\nNATIVE_PG_INSPECTION UNKNOWN\n",
    "NATIVE_PG_FAILURE DOCKER_CONTAINER_TIMEOUT\nNATIVE_PG_INSPECTION PRE_DDL\nNATIVE_PG_INSPECTION INITIAL\n",
    `NATIVE_PG_FAILURE DOCKER_CONTAINER_TIMEOUT\nNATIVE_PG_INSPECTION ${hostileText}\n`,
    "NATIVE_PG_FAILURE CONTEXT_REJECTED\nNATIVE_PG_INSPECTION INITIAL\n",
  ])
    assert.equal(readFailureReport(text), undefined);
});
test("actual local subprocess errors classify without Docker, network, database or raw output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-inspect-errors-"));
  const denied = path.join(dir, "not-executable");
  writeFileSync(denied, "synthetic", { mode: 0o600 });
  const cases: [string, string[], Record<string, unknown>, string][] = [
    [path.join(dir, "missing"), [], {}, "EXECUTABLE_UNAVAILABLE"],
    [denied, [], {}, "ACCESS_DENIED"],
    [process.execPath, ["-e", "process.exit(7)"], {}, "NONZERO_EXIT"],
    [
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { timeout: 100 },
      "TIMEOUT",
    ],
    [
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000))"],
      { maxBuffer: 64 },
      "OUTPUT_LIMIT",
    ],
    [
      process.execPath,
      ["-e", "process.kill(process.pid,'SIGTERM')"],
      {},
      "SIGNAL",
    ],
  ];
  try {
    for (const [file, args, options, reason] of cases)
      assert.throws(
        () =>
          inspectCiMetadata(context, () =>
            execFileSync(file, args, {
              encoding: "utf8",
              stdio: "pipe",
              timeout: 2000,
              ...options,
            }),
          ),
        (error) => {
          assert.equal(
            renderFailure(error),
            `NATIVE_PG_FAILURE DOCKER_CONTAINER_${reason}\nNATIVE_PG_INSPECTION INITIAL\n`,
          );
          return true;
        },
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const origin of ["INITIAL", "BOOTSTRAP_RECHECK"] as const)
  test(`${origin} failure prevents database creation and retains cleanup ownership`, async () => {
    const h = harness(
      "",
      new Error(hostileText),
      origin === "BOOTSTRAP_RECHECK",
    );
    h.driver.inspect = (_context, actualOrigin) => {
      h.calls.push(actualOrigin);
      if (origin === actualOrigin)
        return inspectCiMetadata(
          context,
          () => {
            throw { status: 1, stderr: hostileText };
          },
          actualOrigin,
        );
      return evidence();
    };
    const result = await exitFor(h);
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.equal(
      result.error,
      `NATIVE_PG_FAILURE DOCKER_CONTAINER_NONZERO_EXIT\nNATIVE_PG_INSPECTION ${origin}\n` +
        (origin === "BOOTSTRAP_RECHECK"
          ? "NATIVE_PG_CLEANUP BOOTSTRAP_CLEANUP_FAILED\n"
          : ""),
    );
    assert.ok(!h.calls.some((s) => s.startsWith("CREATE")));
    assert.equal(h.children.length, 0);
    if (origin === "INITIAL") assert.ok(!h.calls.includes("connect"));
  });
test("post-bootstrap pre-DDL collection failure prevents schema preparation and integration", async () => {
  const h = harness();
  let children = 0;
  h.driver.child = (_args, childEnv, phase) => {
    children++;
    assert.equal(phase, "prepare");
    // The actual preparation entrypoint supplies PRE_DDL; this exercises its target path.
    ciDisposableTarget(
      childEnv,
      (_context, origin) =>
        inspectCiMetadata(
          context,
          () => {
            throw { status: 1 };
          },
          origin,
        ),
      "PRE_DDL",
    );
    assert.fail("must not reach native schema DDL");
  };
  const result = await exitFor(h);
  assert.equal(
    result.error,
    "NATIVE_PG_FAILURE DOCKER_CONTAINER_NONZERO_EXIT\nNATIVE_PG_INSPECTION PRE_DDL\n",
  );
  assert.equal(result.code, 1);
  assert.equal(children, 1);
  assert.equal(h.calls.filter((s) => /^(CREATE|COMMENT)/.test(s)).length, 3);
});
test("pre-DDL origin survives child reporting, outer stage and cleanup without reassignment", async () => {
  const text =
    "NATIVE_PG_FAILURE DOCKER_CONTAINER_TIMEOUT\nNATIVE_PG_INSPECTION PRE_DDL\nNATIVE_PG_CLEANUP PREPARE_POOL_CLOSE_FAILED\n";
  await assert.rejects(
    withCleanup(
      async () => {
        return atInspection("INITIAL", () => {
          throw readFailureReport(text);
        });
      },
      "BOOTSTRAP_CLEANUP_FAILED",
      () => {
        throw hostileError();
      },
    ),
    (error) => {
      assert.equal(
        renderFailure(error),
        text + "NATIVE_PG_CLEANUP BOOTSTRAP_CLEANUP_FAILED\n",
      );
      return true;
    },
  );
  const spawn = (() => ({
    status: 1,
    output: [null, hostileText, hostileText, text],
  })) as unknown as typeof spawnSync;
  assert.throws(
    () => executeCiChild([], {}, "prepare", spawn),
    (error) => {
      assert.equal(renderFailure(error), text);
      return true;
    },
  );
});

test("registration origin persists for pre-DDL rechecks without changing identity rejection", async () => {
  for (const origin of ["INITIAL", "PRE_DDL"] as const) {
    const observed: InspectionOrigin[] = [];
    const data = evidence();
    const target = ciDisposableTarget(
      designation,
      (_context, actual) => {
        observed.push(actual);
        return data;
      },
      origin,
    );
    const fake = fakePool([identity]);
    await verifyCiDisposable(fake.pool, target, true);
    assert.deepEqual(observed, [
      origin,
      origin === "PRE_DDL" ? "PRE_DDL" : "RECHECK",
    ]);
    data.container.id = context.originalService;
    fake.queries.length = 0;
    await assert.rejects(verifyCiDisposable(fake.pool, target, true));
    assert.deepEqual(fake.queries, []);
  }
});
test("subprocess classification never replaces an already owned primary failure", () => {
  for (const text of [
    "NATIVE_PG_FAILURE DOCKER_CONTAINER_TIMEOUT\nNATIVE_PG_INSPECTION PRE_DDL\nNATIVE_PG_CLEANUP PREPARE_POOL_CLOSE_FAILED\n",
    "NATIVE_PG_FAILURE CONTEXT_REJECTED\n",
  ])
    assert.throws(
      () =>
        inspectCiMetadata(
          context,
          () => {
            throw readFailureReport(text);
          },
          "INITIAL",
        ),
      (error) => {
        assert.equal(renderFailure(error), text);
        return true;
      },
    );
});
