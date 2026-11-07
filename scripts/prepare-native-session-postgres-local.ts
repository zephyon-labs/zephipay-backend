/** Opt-in, empty disposable fixture only. Never called by normal migration/build/start scripts. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  nativeDisposableTarget,
  verifyNativeDisposable,
} from "../tests/helpers/nativePostgresSafety";

async function main() {
  const target = nativeDisposableTarget(process.env);
  const pool = new Pool(target.pool);
  try {
    await verifyNativeDisposable(pool, target, true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TABLE public.payment_schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
      );
      for (const [file, name] of [
        ["migrations/002_identity_foundation.sql", "002_identity_foundation.sql"],
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
      await client.query("COMMIT");
      process.stdout.write(
        `Prepared ONLY ${target.database} at 127.0.0.1:${target.port}; identity foundation and native candidate schema.\n`,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
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
