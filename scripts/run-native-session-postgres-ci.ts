/** Hosted fixture only; import is inert. Never part of application startup or migrations. */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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

type Env = Record<string, string | undefined>;
type Connection = Pick<Pool, "query" | "end">;
export type CiDriver = {
  inspect?: Inspect;
  random: () => string;
  connect: (config: PoolConfig) => Connection;
  child: (args: string[], env: Env) => void;
};
export async function provisionCiDatabase(
  pool: Connection,
  target: DisposableTarget,
): Promise<void> {
  await verifyCiDatabase(pool, target, true);
  await verifyCiEmpty(pool);
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
  if (
    (
      await pool.query(
        "CREATE ROLE native_session_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'native-session-disposable-only'",
      )
    ).command !== "CREATE"
  )
    throw new Error("CI fixture role creation unacknowledged");
  if (
    (
      await pool.query(
        `CREATE DATABASE "${target.database}" OWNER native_session_fixture TEMPLATE template0`,
      )
    ).command !== "CREATE"
  )
    throw new Error("CI fixture database creation unacknowledged");
  if (
    (
      await pool.query(
        `COMMENT ON DATABASE "${target.database}" IS '${target.marker}'`,
      )
    ).command !== "COMMENT"
  )
    throw new Error("CI fixture database marker unacknowledged");
}

export async function runNativeCi(env: Env, driver: CiDriver): Promise<void> {
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
  const childEnv = {
    ...env,
    NATIVE_SESSION_TEST_DATABASE: `zephipay_native_session_test_${nonce}`,
    NATIVE_SESSION_TEST_PORT: "55432",
    NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_GITHUB_NATIVE_SESSION_V1",
  };
  // Includes actual Docker network/image/mount inspection BEFORE the first database socket.
  const target = ciDisposableTarget(childEnv, driver.inspect);
  const pool = driver.connect({
    ...target.pool,
    database: "postgres",
    user: CI_ADMIN,
    password: CI_ADMIN_PASSWORD,
    max: 1,
  });
  try {
    await provisionCiDatabase(pool, target);
  } finally {
    await pool.end();
  }
  driver.child(
    ["--import", "tsx", "scripts/prepare-native-session-postgres-local.ts"],
    childEnv,
  );
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
  );
}

if (require.main === module) {
  void runNativeCi(process.env, {
    random: () => randomBytes(8).toString("hex"),
    connect: (config) => new Pool(config),
    child: (args, env) => {
      execFileSync(process.execPath, args, {
        env,
        stdio: "inherit",
        timeout: 180_000,
      });
    },
  })
    .then(() => {
      process.stdout.write(
        "Native PostgreSQL CI: fresh isolated fixture; preparation and all 16 integration cases passed.\n",
      );
    })
    .catch(() => {
      process.stderr.write(
        "Native PostgreSQL CI failed; no fallback, retry or database reuse.\n",
      );
      process.exitCode = 1;
    });
}
