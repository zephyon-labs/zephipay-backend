import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const REQUIRED_TOKENS = [
  "CREATE EXTENSION IF NOT EXISTS pgcrypto",
  "CREATE TYPE payment_status",
  "CREATE TYPE payment_event_type",
  "CREATE TYPE terminal_proof_kind",
  "CREATE TABLE beta_allowlist",
  "CREATE TABLE payments",
  "CREATE TABLE payment_receipts",
  "CREATE TABLE payment_events",
  "payment_receipts_append_only",
  "payment_events_append_only",
  "payments_protect_settlement_evidence",
  "payments_validate_lifecycle",
  "payment_receipts_match_payment",
  "payment_events_authoritative_guard",
  "payments_terminal_artifacts_guard",
];

async function main(): Promise<void> {
  const directory = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  if (files.length === 0) throw new Error("No ordered SQL migrations found.");
  if (new Set(files).size !== files.length) throw new Error("Migration names must be unique.");
  const first = await readFile(path.join(directory, files[0]), "utf8");
  for (const token of REQUIRED_TOKENS) {
    if (!first.includes(token)) throw new Error(`Migration is missing required token: ${token}`);
  }
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(first)) {
    throw new Error("Transaction control belongs to the migration runner.");
  }
  const runner = await readFile(path.resolve(process.cwd(), "scripts/run-migrations.ts"), "utf8");
  for (const token of ['client.query("BEGIN")', 'client.query("COMMIT")', 'client.query("ROLLBACK")']) {
    if (!runner.includes(token)) throw new Error(`Migration runner is missing ${token}.`);
  }
  for (const token of ["pg_advisory_lock", "pg_advisory_unlock"]) {
    if (!runner.includes(token)) throw new Error(`Migration runner is missing ${token}.`);
  }
  process.stdout.write(`Validated ${files.length} ordered migration file(s).\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Migration validation failed."}\n`);
  process.exitCode = 1;
});
