/** Opt-in, empty disposable fixture only. Never called by normal migration/build/start scripts. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  nativeDisposableTarget,
  verifyNativeDisposable,
} from "../tests/helpers/nativePostgresTarget";

async function main() {
  const target = nativeDisposableTarget(process.env);
  const pool = new Pool(target.pool);
  try {
    const client = await pool.connect();
    try {
      if ((await client.query("BEGIN")).command !== "BEGIN")
        throw new Error(
          "Disposable preparation transaction was not acknowledged",
        );
      await verifyNativeDisposable(client, target, true);
      const { rows: transactions } = await client.query(
        "SELECT pg_catalog.pg_current_xact_id()::text AS transaction_id",
      );
      const transactionId = transactions[0]?.transaction_id;
      if (
        transactions.length !== 1 ||
        typeof transactionId !== "string" ||
        !/^[1-9][0-9]*$/.test(transactionId)
      )
        throw new Error(
          "Disposable preparation transaction identity unavailable",
        );

      // Bootstrap only: implicit pg_catalog still resolves built-ins first, while
      // public is the explicit creation target. SET LOCAL ends on commit/rollback.
      // Never change the fixture pool or adapter's catalog-first runtime path.
      await client.query("SET LOCAL search_path=public,pg_temp");
      const { rows: contexts } = await client.query(`SELECT
        pg_catalog.pg_current_xact_id()::text AS transaction_id,
        pg_catalog.current_schema() AS schema,
        pg_catalog.current_setting('search_path') AS search_path,
        pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
        pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE') AS database_create,
        pg_catalog.has_language_privilege(current_user,'plpgsql','USAGE') AS language_usage`);
      const context = contexts[0];
      if (
        contexts.length !== 1 ||
        context.transaction_id !== transactionId ||
        context.schema !== "public" ||
        typeof context.search_path !== "string" ||
        context.search_path.replace(/\s/g, "") !== "public,pg_temp" ||
        context.schema_usage !== true ||
        context.schema_create !== true ||
        context.database_create !== true ||
        context.language_usage !== true
      )
        throw new Error(
          "Disposable preparation schema, privileges or transaction unverified",
        );
      await client.query(
        "CREATE TABLE public.payment_schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
      );
      for (const [file, name] of [
        [
          "migrations/002_identity_foundation.sql",
          "002_identity_foundation.sql",
        ],
        [
          "sql/candidates/native-session-postgres-v1.sql",
          "candidate_native_session_postgres_v1.sql",
        ],
      ]) {
        const sql = await readFile(file, "utf8");
        await client.query(sql);
        await client.query(
          "INSERT INTO public.payment_schema_migrations(version,checksum) VALUES($1,$2)",
          [name, createHash("sha256").update(sql).digest("hex")],
        );
      }
      if ((await client.query("COMMIT")).command !== "COMMIT")
        throw new Error("Disposable preparation commit was not acknowledged");
      process.stdout.write(
        `Prepared ONLY ${target.database} at 127.0.0.1:${target.port}; identity foundation and native candidate schema.\n`,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      // One-shot bootstrap connections are never returned for ordinary operations,
      // including when rollback or commit acknowledgement is uncertain.
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  process.stderr.write(
    "Disposable native-session preparation failed; no automatic fallback or retry.\n",
  );
  process.exitCode = 1;
});
