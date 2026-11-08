/** Opt-in, empty disposable fixture only. Never called by normal migration/build/start scripts. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  nativeDisposableTarget,
  verifyNativeDisposable,
} from "../tests/helpers/nativePostgresTarget";
import {
  atStage,
  atAsyncStage,
  failure,
  renderFailure,
  withCleanup,
  sendChildReport,
  PREPARATION_OK,
  type DiagnosticCode,
} from "../tests/helpers/nativePostgresDiagnostics";

async function main() {
  const target = atStage("PREPARE_TARGET_FAILED", () =>
    nativeDisposableTarget(process.env),
  );
  const pool = atStage("PREPARE_CONNECT_FAILED", () => new Pool(target.pool));
  await withCleanup(
    async () => {
      const client = await atAsyncStage("PREPARE_CONNECT_FAILED", () =>
        pool.connect(),
      );
      await withCleanup(
        async () => {
          let stage: DiagnosticCode = "PREPARE_BEGIN_FAILED";
          try {
            if ((await client.query("BEGIN")).command !== "BEGIN")
              throw new Error(
                "Disposable preparation transaction was not acknowledged",
              );
            stage = "PREPARE_IDENTITY_FAILED";
            await verifyNativeDisposable(client, target, true);
            stage = "PREPARE_TRANSACTION_FAILED";
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
            stage = "PREPARE_SCHEMA_FAILED";
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
            stage = "PREPARE_DDL_FAILED";
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
            stage = "PREPARE_COMMIT_FAILED";
            if ((await client.query("COMMIT")).command !== "COMMIT")
              throw new Error(
                "Disposable preparation commit was not acknowledged",
              );
          } catch (error) {
            await withCleanup(
              async () => {
                throw failure(stage, error);
              },
              "PREPARE_ROLLBACK_FAILED",
              () => client.query("ROLLBACK"),
            );
          }
        },
        "PREPARE_RELEASE_FAILED",
        () => {
          // One-shot bootstrap connections are never returned for ordinary operations,
          // including when rollback or commit acknowledgement is uncertain.
          client.release(true);
        },
      );
    },
    "PREPARE_POOL_CLOSE_FAILED",
    () => pool.end(),
  );
  // No success acknowledgement before cleanup has completed successfully.
  process.stdout.write(PREPARATION_OK);
  sendChildReport(PREPARATION_OK, process.env);
}
void main().catch((error) => {
  const report = renderFailure(error);
  process.stderr.write(report);
  sendChildReport(report, process.env);
  process.exitCode = 1;
});
