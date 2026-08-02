import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

const MIGRATION_LOCK_ID = "827346192045711001";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const directory = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS payment_schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now(),
         checksum text NOT NULL
       )`,
    );
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        `SELECT checksum FROM payment_schema_migrations WHERE version=$1`,
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${file} has been modified.`);
        }
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO payment_schema_migrations (version, checksum) VALUES ($1,$2)`,
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      process.stdout.write(`Applied ${file}\n`);
    }
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
      await pool.end();
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Migration failed."}\n`);
  process.exitCode = 1;
});
