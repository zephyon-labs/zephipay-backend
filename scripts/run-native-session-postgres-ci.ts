/** Hosted fixture only; import is inert. Never part of application startup or migrations. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool, type PoolConfig } from "pg";
import {
  CI_ADMIN,
  CI_ADMIN_PASSWORD,
  ciDisposableTarget,
  verifyCiDatabase,
  verifyCiEmpty,
  type Inspect,
} from "../tests/helpers/nativePostgresCiSafety";
import type { DisposableTarget } from "../tests/helpers/nativePostgresSafety";
import {
  atStage,
  atAsyncStage,
  failure,
  renderFailure,
  withCleanup,
  readFailureReport,
  PREPARATION_OK,
  INTEGRATION_OK,
  type DiagnosticCode,
} from "../tests/helpers/nativePostgresDiagnostics";

type Env = Record<string, string | undefined>;
type Connection = Pick<Pool, "query" | "end">;
export type CiDriver = {
  inspect?: Inspect;
  random: () => string;
  connect: (config: PoolConfig) => Connection;
  child: (args: string[], env: Env, phase: "prepare" | "integrate") => void;
};
export async function provisionCiDatabase(
  pool: Connection,
  target: DisposableTarget,
): Promise<void> {
  let stage: DiagnosticCode = "BOOTSTRAP_IDENTITY_FAILED";
  try {
    await verifyCiDatabase(pool, target, true);
    stage = "BOOTSTRAP_EMPTY_REJECTED";
    await verifyCiEmpty(pool);
    stage = "BOOTSTRAP_INVENTORY_FAILED";
    const { rows: databases } = await pool.query(
      "SELECT datname FROM pg_database ORDER BY datname",
    );
    if (
      JSON.stringify(databases.map((r) => r.datname)) !==
      '["postgres","template0","template1"]'
    )
      throw new Error("CI service is not a fresh bootstrap cluster");
    const { rows: roles } = await pool.query(
      "SELECT rolname FROM pg_roles WHERE rolname='native_session_fixture'",
    );
    if (roles.length !== 0) throw new Error("CI fixture role already exists");
    // No IF EXISTS, reuse, reset, DROP, application migrations or retry. The service is discarded by the runner.
    stage = "BOOTSTRAP_ROLE_CREATE_FAILED";
    if (
      (
        await pool.query(
          "CREATE ROLE native_session_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'native-session-disposable-only'",
        )
      ).command !== "CREATE"
    )
      throw new Error("CI fixture role creation unacknowledged");
    stage = "BOOTSTRAP_DATABASE_CREATE_FAILED";
    if (
      (
        await pool.query(
          `CREATE DATABASE "${target.database}" OWNER native_session_fixture TEMPLATE template0`,
        )
      ).command !== "CREATE"
    )
      throw new Error("CI fixture database creation unacknowledged");
    stage = "BOOTSTRAP_MARKER_FAILED";
    if (
      (
        await pool.query(
          `COMMENT ON DATABASE "${target.database}" IS '${target.marker}'`,
        )
      ).command !== "COMMENT"
    )
      throw new Error("CI fixture database marker unacknowledged");
  } catch (error) {
    throw failure(stage, error);
  }
}

export async function runNativeCi(env: Env, driver: CiDriver): Promise<void> {
  const childEnv = atStage("TARGET_REJECTED", () => {
    // Reject caller-supplied designation: this entrypoint always chooses a new random target.
    for (const key of [
      "NATIVE_SESSION_TEST_DATABASE",
      "NATIVE_SESSION_TEST_PORT",
      "NATIVE_SESSION_TEST_CONFIRM",
    ])
      if (env[key] !== undefined)
        throw new Error("CI target must be created by this invocation");
    const nonce = driver.random();
    if (!/^[0-9a-f]{16}$/.test(nonce))
      throw new Error("Invalid CI database nonce");
    return {
      ...env,
      NATIVE_SESSION_TEST_DATABASE: `zephipay_native_session_test_${nonce}`,
      NATIVE_SESSION_TEST_PORT: "55432",
      NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_GITHUB_NATIVE_SESSION_V1",
    };
  });
  // Includes actual Docker network/image/mount inspection BEFORE the first database socket.
  const target = ciDisposableTarget(childEnv, driver.inspect);
  const pool = atStage("BOOTSTRAP_CONNECT_FAILED", () =>
    driver.connect({
      ...target.pool,
      database: "postgres",
      user: CI_ADMIN,
      password: CI_ADMIN_PASSWORD,
      max: 1,
    }),
  );
  await withCleanup(
    () => provisionCiDatabase(pool, target),
    "BOOTSTRAP_CLEANUP_FAILED",
    () => pool.end(),
  );
  atStage("PREPARATION_CHILD_FAILED", () =>
    driver.child(
      ["--import", "tsx", "scripts/prepare-native-session-postgres-local.ts"],
      childEnv,
      "prepare",
    ),
  );
  atStage("INTEGRATION_CHILD_FAILED", () =>
    driver.child(
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=./scripts/native-postgres-ci-reporter.cjs",
        "tests/postgresNativeSession.integration.ts",
      ],
      childEnv,
      "integrate",
    ),
  );
}

/** Dedicated fd 3 transports a bounded allowlisted report; stdout/stderr are never forwarded or parsed. */
export function executeCiChild(
  args: string[],
  env: Env,
  phase: "prepare" | "integrate",
  spawn: typeof spawnSync = spawnSync,
): void {
  const codes =
    phase === "prepare"
      ? ({
          failed: "PREPARATION_CHILD_FAILED",
          missing: "PREPARATION_REPORT_MISSING",
          invalid: "PREPARATION_REPORT_INVALID",
          success: PREPARATION_OK,
        } as const)
      : ({
          failed: "INTEGRATION_CHILD_FAILED",
          missing: "INTEGRATION_REPORT_MISSING",
          invalid: "INTEGRATION_REPORT_INVALID",
          success: INTEGRATION_OK,
        } as const);
  atStage(codes.failed, () => {
    const result = spawn(process.execPath, args, {
      env: { ...env, NATIVE_SESSION_CI_DIAGNOSTIC_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    const channel = result.output?.[3];
    const text = typeof channel === "string" ? channel : "";
    const reported = readFailureReport(text);
    if (reported) throw reported;
    if (result.error || result.signal || result.status !== 0)
      throw failure(codes.failed);
    if (!text) throw failure(codes.missing);
    if (text !== codes.success) throw failure(codes.invalid);
  });
}

export async function nativeCiExit(
  env: Env,
  driver: CiDriver,
  output: { out: (text: string) => void; error: (text: string) => void },
): Promise<0 | 1> {
  try {
    await atAsyncStage("UNCLASSIFIED_FAILURE", () => runNativeCi(env, driver));
    output.out(
      "Native PostgreSQL CI: fresh isolated fixture; preparation and all 16 integration cases passed.\n",
    );
    return 0;
  } catch (error) {
    output.error(renderFailure(error));
    return 1;
  }
}
if (require.main === module) {
  void nativeCiExit(
    process.env,
    {
      random: () => randomBytes(8).toString("hex"),
      connect: (config) => new Pool(config),
      child: executeCiChild,
    },
    {
      out: (text) => {
        process.stdout.write(text);
      },
      error: (text) => {
        process.stderr.write(text);
      },
    },
  )
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
