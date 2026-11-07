import type { Pool, PoolConfig } from "pg";

export type DisposableTarget = { database: string; port: number; marker: string; pool: PoolConfig };
/** No DATABASE_URL/TEST_DATABASE_URL/PG* fallback. No provider credentials. */
export function nativeDisposableTarget(env: Record<string, string | undefined>): DisposableTarget {
  const database = env.NATIVE_SESSION_TEST_DATABASE;
  const rawPort = env.NATIVE_SESSION_TEST_PORT;
  if (
    env.NATIVE_SESSION_TEST_CONFIRM !== "DISPOSABLE_LOCAL_NATIVE_SESSION_V1" ||
    !database ||
    !/^zephipay_native_session_test_[0-9a-f]{16}$/.test(database) ||
    !rawPort ||
    !/^[0-9]{4,5}$/.test(rawPort)
  )
    throw new Error("Explicit unique disposable native-session database designation required");
  const port = Number(rawPort);
  if (port < 1024 || port > 65535) throw new Error("Invalid disposable port");
  return {
    database,
    port,
    marker: `ZEPHIPAY_NATIVE_SESSION_DISPOSABLE_V1:${database}`,
    pool: {
      host: "127.0.0.1",
      port,
      database,
      user: "native_session_fixture",
      password: "native-session-disposable-only",
      ssl: false,
      application_name: "native-session-disposable-tests",
      options: "-c search_path=pg_catalog,public,pg_temp",
      max: 12,
      connectionTimeoutMillis: 1500,
      query_timeout: 12_000,
      idleTimeoutMillis: 1000,
    },
  };
}

/** Read-only checks precede any schema/data mutation. Marker must be set by the local fixture owner. */
export async function verifyNativeDisposable(
  pool: Pick<Pool, "query">,
  target: DisposableTarget,
  empty: boolean,
): Promise<void> {
  const { rows } =
    await pool.query(`SELECT current_database() AS database, current_user AS username,
    inet_server_addr()::text AS address, inet_server_port() AS port, current_setting('server_version_num')::integer AS version,
    pg_is_in_recovery() AS recovery, shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`);
  const r = rows[0];
  if (
    rows.length !== 1 ||
    r.database !== target.database ||
    r.username !== "native_session_fixture" ||
    r.address !== "127.0.0.1" ||
    r.port !== target.port ||
    r.marker !== target.marker ||
    r.recovery !== false ||
    r.version < 160000 ||
    r.version >= 170000
  )
    throw new Error("Disposable database identity verification failed");
  if (empty) {
    const { rows: objects } = await pool.query(`SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS count`);
    if (objects[0]?.count !== "0")
      throw new Error(
        "Disposable target must be empty; existing application databases are rejected",
      );
  }
}
