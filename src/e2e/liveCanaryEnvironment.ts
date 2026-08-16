import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PublicKey } from "@solana/web3.js";
import type { Pool } from "pg";

import { CIRCLE_SOLANA_DEVNET_USDC_MINT } from "../devnet/canonicalDevnetAsset";
import { parseDevnetLiveConfiguration } from "../devnet/devnetLiveConfiguration";
import { sanitizedDatabaseTarget, selectE2eDatabase } from "./e2eDatabaseSelection";
import { LIVE_CANARY_CONFIRMATION } from "./liveDevnetCanaryPolicy";
import { LIVE_SYNTHETIC_DESTINATION, LIVE_SYNTHETIC_SOURCE } from "./liveDevnetHarness";

export const DEFAULT_LIVE_CANARY_ENV_FILE = resolve(homedir(), ".zephipay/devnet/canary.env");
export const LIVE_CANARY_ENV_KEYS = Object.freeze([
  "NODE_ENV", "DATABASE_URL", "E2E_DEVNET_DESTINATION_WALLET", "E2E_LIVE_CANARY_CONFIRMATION",
  "DEVNET_INTEGRATION_ENABLED", "DEVNET_BROWSER_API_ENABLED", "DEVNET_PREPARATION_ENABLED",
  "DEVNET_SUBMISSION_ENABLED", "DEVNET_RECONCILIATION_ENABLED", "DEVNET_SUBMISSION_PROVIDER_ID",
  "DEVNET_SUBMISSION_RPC_URL", "DEVNET_SUBMISSION_API_KEY", "DEVNET_RECONCILIATION_PROVIDER_ID",
  "DEVNET_RECONCILIATION_RPC_URL", "DEVNET_RPC_TIMEOUT_MS", "DEVNET_PREPARATION_ENCRYPTION_KEY_BASE64",
  "DEVNET_PREPARATION_ENCRYPTION_KEY_VERSION", "DEVNET_SIGNER_SECRET_KEY_BASE64", "DEVNET_SIGNER_KEY_ID",
  "DEVNET_SIGNER_KEY_VERSION", "DEVNET_SIGNER_PUBLIC_KEY", "DEVNET_USDC_MINT", "DEVNET_MINT_DECIMALS",
  "DEVNET_SOURCE_TOKEN_ACCOUNT",
] as const);
export const FORBIDDEN_CANARY_DATABASE_KEYS = Object.freeze(["E6_DATABASE_URL", "E6B_DATABASE_URL", "TEST_DATABASE_URL"] as const);
export const MAX_LIVE_CANARY_BATCH_COUNT = 5;
type Environment = Record<string, string | undefined>;

export function parseLiveCanaryInvocation(values: readonly string[]): { scenario: "human-to-human-happy-path"; count: number } {
  const args = [...values], scenarioAt = args.indexOf("--scenario"), countAt = args.indexOf("--count");
  if (scenarioAt < 0 || args[scenarioAt + 1] !== "human-to-human-happy-path") throw new Error("Live launch requires --scenario human-to-human-happy-path.");
  if (args.filter(value => value === "--scenario").length !== 1 || args.filter(value => value === "--count").length > 1) throw new Error("Live launch arguments must not be repeated.");
  const countText = countAt < 0 ? "1" : args[countAt + 1], expectedLength = countAt < 0 ? 2 : 4;
  if (args.length !== expectedLength || !countText || !/^[1-5]$/.test(countText)) throw new Error(`Live canary count must be an integer from 1 through ${MAX_LIVE_CANARY_BATCH_COUNT}.`);
  return Object.freeze({ scenario: "human-to-human-happy-path", count: Number(countText) });
}

export async function loadLiveCanaryEnvironment(filePath = DEFAULT_LIVE_CANARY_ENV_FILE): Promise<Record<string, string>> {
  const path = resolve(filePath);
  try { await access(path, fsConstants.R_OK); } catch { throw new Error("Live canary env file is missing or unreadable."); }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Live canary env path must be a regular file.");
  if ((metadata.mode & 0o077) !== 0) throw new Error("Live canary env file permissions must not be broader than 0600.");
  const allowed = new Set<string>(LIVE_CANARY_ENV_KEYS), parsed: Record<string, string> = {};
  for (const [index, raw] of (await readFile(path, "utf8")).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Live canary env file has invalid syntax on line ${index + 1}.`);
    const [, key, encoded] = match;
    if (!allowed.has(key)) throw new Error(`Live canary env file contains undeclared key ${key}.`);
    if (Object.prototype.hasOwnProperty.call(parsed, key)) throw new Error(`Live canary env file repeats key ${key}.`);
    parsed[key] = decodeValue(encoded, index + 1);
  }
  return Object.freeze(parsed);
}

function decodeValue(raw: string, line: number): string {
  if (!raw.length) return "";
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const quote = raw[0];
    if (raw.length < 2 || raw[raw.length - 1] !== quote) throw new Error(`Live canary env file has unterminated quoted value on line ${line}.`);
    const value = raw.slice(1, -1);
    if (quote === "'" || !value.includes("\\")) return value;
    return value.replace(/\\([\\"nrt])/g, (_match, escaped: string) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' }[escaped] ?? escaped));
  }
  if (/\s/.test(raw) || raw.includes("#")) throw new Error(`Live canary env file requires quotes around whitespace or # on line ${line}.`);
  return raw;
}

export function buildLiveCanaryProcessEnvironment(ambient: Environment, loaded: Readonly<Record<string, string>>): Environment {
  for (const key of FORBIDDEN_CANARY_DATABASE_KEYS) if (ambient[key]?.trim() || loaded[key]?.trim()) throw new Error(`${key} must be absent for live canary execution.`);
  for (const key of LIVE_CANARY_ENV_KEYS) if (!loaded[key]?.trim()) throw new Error(`${key} is missing from the live canary env file.`);
  const env = { ...ambient };
  for (const key of LIVE_CANARY_ENV_KEYS) env[key] = loaded[key];
  for (const key of FORBIDDEN_CANARY_DATABASE_KEYS) delete env[key];
  assertLiveCanaryEnvironmentContract(env);
  return env;
}

export function assertLiveCanaryEnvironmentContract(env: Environment): void {
  if (env.NODE_ENV !== "test") throw new Error("NODE_ENV must equal test.");
  if (env.E2E_LIVE_CANARY_CONFIRMATION !== LIVE_CANARY_CONFIRMATION) throw new Error("Live Devnet confirmation is missing.");
  const selected = selectE2eDatabase("LIVE_DEVNET_CANARY", env), target = sanitizedDatabaseTarget(selected.connectionString);
  if (target.database !== "zephipay_auth_test" || target.host !== "127.0.0.1" || target.port !== "55432") throw new Error("DATABASE_URL must target zephipay_auth_test at 127.0.0.1:55432.");
  if (env.E2E_DEVNET_DESTINATION_WALLET !== canonicalPublicKey(env.E2E_DEVNET_DESTINATION_WALLET)) throw new Error("E2E_DEVNET_DESTINATION_WALLET must be a canonical Solana address.");
  const config = parseDevnetLiveConfiguration(env);
  if (!config.enabled || !config.browserApiEnabled || !config.preparationEnabled || !config.submissionEnabled || !config.reconciliationEnabled) throw new Error("Every required live Devnet capability must be enabled.");
  if (config.mint !== CIRCLE_SOLANA_DEVNET_USDC_MINT || config.decimals !== 6) throw new Error("Canonical Circle Devnet USDC configuration is required.");
  if (!config.signerSecretKey) throw new Error("DEVNET_SIGNER_SECRET_KEY_BASE64 is required for live canary execution.");
}

function canonicalPublicKey(value: string | undefined): string {
  if (!value) return "";
  try { return new PublicKey(value).toBase58(); } catch { return ""; }
}

export async function assertLiveCanaryDatabaseReady(pool: Pick<Pool, "query">, env: Environment): Promise<void> {
  let result;
  try {
    result = await pool.query(`SELECT
      EXISTS(SELECT 1 FROM payment_schema_migrations WHERE version='019_synthetic_e2e_reliability.sql') AS migration_019,
      (SELECT count(*)::int FROM synthetic_test_actors WHERE synthetic_actor_id IN ($1,$2) AND actor_class='synthetic_test' AND actor_kind='human' AND test_origin='codex_e2e') AS actor_count,
      (SELECT devnet_destination_address FROM synthetic_test_actors WHERE synthetic_actor_id=$2) AS destination` , [LIVE_SYNTHETIC_SOURCE, LIVE_SYNTHETIC_DESTINATION]);
  } catch { throw new Error("Selected DATABASE_URL database is not ready for live canary validation."); }
  const row = result.rows[0];
  if (!row?.migration_019) throw new Error("Migration 019 is not applied.");
  if (Number(row.actor_count) !== 2 || row.destination !== env.E2E_DEVNET_DESTINATION_WALLET) throw new Error("Required H2H synthetic actors or reviewed destination are missing.");
}

export function liveCanaryLaunch(env: Environment, scenario: string) {
  if (scenario !== "human-to-human-happy-path") throw new Error("Only human-to-human-happy-path may be launched live.");
  return Object.freeze({
    executable: process.execPath,
    arguments: Object.freeze([require.resolve("tsx/cli"), "scripts/run-devnet-e2e.ts", "--scenario", scenario, "--live-devnet"]),
    environment: env,
  });
}

export async function assertLiveCanaryBatch(pool: Pick<Pool, "query">, runIds: readonly string[], expectedCount: number): Promise<void> {
  if (runIds.length !== expectedCount || new Set(runIds).size !== expectedCount) throw new Error("Live batch did not produce the expected distinct run IDs.");
  const result = await pool.query(`SELECT r.run_id,r.result,r.invariant_violations,p.status payment_status,e.status execution_status,
    prep.lifecycle_state,
    (SELECT count(*)::int FROM payments xp WHERE xp.idempotency_key='codex-live-canary:'||r.run_id::text) payment_count,
    (SELECT count(*)::int FROM payment_executions xe WHERE xe.execution_id=r.execution_id) execution_count,
    (SELECT count(*)::int FROM devnet_submission_commitments c WHERE c.execution_id=r.execution_id) commitment_count,
    (SELECT count(*)::int FROM devnet_submission_observations s WHERE s.execution_id=r.execution_id) submission_count,
    (SELECT count(*)::int FROM payment_execution_receipts x WHERE x.execution_id=r.execution_id) receipt_count,
    (SELECT count(*)::int FROM payment_events pe WHERE pe.payment_id=r.payment_intent_id AND pe.event_type='SETTLEMENT_CONFIRMED') settlement_event_count
    FROM e2e_test_runs r JOIN payments p ON p.id=r.payment_intent_id JOIN payment_executions e ON e.execution_id=r.execution_id
    JOIN devnet_execution_preparations prep ON prep.execution_id=e.execution_id AND prep.lifecycle_state<>'ABANDONED_PRE_CONTACT'
    WHERE r.run_id=ANY($1::uuid[])`, [runIds]);
  if (result.rows.length !== expectedCount) throw new Error("Live batch durable run count does not match the requested count.");
  for (const row of result.rows) {
    const valid = row.result === "PASSED" && row.payment_status === "COMPLETED" && row.execution_status === "SETTLED" && row.lifecycle_state === "SETTLED" &&
      [row.payment_count,row.execution_count,row.commitment_count,row.submission_count,row.receipt_count,row.settlement_event_count].every(value => Number(value) === 1) &&
      Array.isArray(row.invariant_violations) && row.invariant_violations.length === 0;
    if (!valid) throw new Error(`Live batch invariant failed for run ${String(row.run_id)}.`);
  }
}

export async function executeLiveCanaryBatch(
  count: number,
  runItem: (item: number) => Promise<Readonly<{ runId?: string; result?: string; exitCode: number }>>,
  audit: (runIds: readonly string[], expectedCount: number) => Promise<void>,
): Promise<readonly string[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_LIVE_CANARY_BATCH_COUNT) throw new Error(`Live canary count must be an integer from 1 through ${MAX_LIVE_CANARY_BATCH_COUNT}.`);
  const runIds: string[] = [];
  for (let item = 1; item <= count; item++) {
    const run = await runItem(item);
    if (!run.runId) throw new Error(`Live canary item ${item} did not return a durable run ID.`);
    runIds.push(run.runId);
    if (run.exitCode !== 0 || run.result !== "PASSED") throw new Error(`Live canary item ${item} failed; batch stopped without retry.`);
  }
  await audit(runIds, count);
  return Object.freeze(runIds);
}
