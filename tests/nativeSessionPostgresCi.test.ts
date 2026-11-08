import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  type CiDriver,
} from "../scripts/run-native-session-postgres-ci";

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

function harness(fault = "") {
  const calls: string[] = [],
    children: { args: string[]; env: Record<string, string | undefined> }[] =
      [];
  let config: PoolConfig | undefined;
  const driver: CiDriver = {
    inspect: () => {
      calls.push("inspect");
      if (fault === "inspect") throw new Error("injected");
      return evidence();
    },
    random: () => "0123456789abcdef",
    connect: (value) => {
      calls.push("connect");
      config = value;
      return {
        end: async () => {
          calls.push("end");
          if (fault === "end") throw new Error("injected");
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
          if (fault && sql.startsWith(fault))
            throw new Error("injected or ambiguous acknowledgement");
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
        throw new Error("child failed");
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
    assert.match(source, /nativeDisposableTarget\(process.env\)/);
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
