import { readFile } from "node:fs/promises";
import { Pool } from "pg";

/** Explicit privileged deployment step, never called by application startup or ordinary migrations. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL required for explicit economic role provisioning.");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(await readFile("sql/economic-database-roles-v1.sql", "utf8"));
    process.stdout.write("Economic authority roles configured; deployment login membership still requires verification.\n");
  } finally { await pool.end(); }
}
void main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
