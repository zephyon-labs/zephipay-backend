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

const IDENTITY_REQUIRED_TOKENS = [
  "CREATE TYPE account_status",
  "CREATE TYPE account_security_event_type",
  "CREATE TABLE accounts",
  "CREATE TABLE external_identities",
  "CREATE TABLE account_sessions",
  "CREATE TABLE account_security_events",
  "accounts_protect_identity",
  "external_identities_append_only",
  "account_security_events_append_only",
  "account_sessions_protect_lifecycle",
  "accounts_security_artifact_guard",
  "external_identities_security_artifact_guard",
  "account_sessions_security_artifact_guard",
];

const ECONOMIC_IDENTITY_REQUIRED_TOKENS = [
  "CREATE TYPE economic_account_type",
  "CREATE TYPE identity_discoverability",
  "CREATE TYPE identity_verification_state",
  "CREATE TYPE identity_payability_state",
  "CREATE TABLE economic_identities",
  "CREATE TABLE payment_destinations",
  "economic_identities_normalized_username_unique",
  "payment_destinations_primary_per_type_unique",
  "economic_identities_protect_lifecycle",
  "payment_destinations_protect_lifecycle",
];
const EXECUTION_REQUIRED_TOKENS = ["CREATE TABLE payment_executions", "CREATE TABLE payment_execution_attempts",
  "CREATE TABLE payment_execution_events", "payment_executions_protect", "payment_execution_attempts_append_only",
  "payment_execution_events_append_only", "selected_rail='mock'", "UNIQUE REFERENCES payments"];
const REQUEST_REQUIRED_TOKENS=["CREATE TABLE payment_requests","CREATE TABLE payment_request_events","payment_requests_protect","payment_request_events_append_only","payment_requests_event_guard","payment_requests_mark_paid"];
const SYNTHETIC_REQUIRED_TOKENS=["CREATE TABLE synthetic_beta_identities","recipient_synthetic_id","SYNTHETIC_BETA","protect_payment_identity_linkage"];
const TELEMETRY_EPOCH_REQUIRED_TOKENS=["CREATE TABLE telemetry_epochs","'OPEN_BETA'","2026-08-09T06:09:34.531759Z","telemetry_epochs_append_only"];
const DEVNET_STATE_REQUIRED_TOKENS=["CREATE TABLE devnet_execution_preparations","CREATE TABLE devnet_submission_commitments","SUBMISSION_COMMITTED_RECONCILE_ONLY","devnet_submission_commitments_append_only","protect_devnet_preparation","devnet_execution_one_active_preparation","submission_provider_id<>reconciliation_provider_id"];
const DEVNET_RECONCILIATION_REQUIRED_TOKENS=["CREATE TABLE devnet_reconciliation_observations","devnet_reconciliation_observations_append_only","UNIQUE(execution_id,sequence_number)","devnet_reconciliation_outcome"];
const DEVNET_SUBMISSION_REQUIRED_TOKENS=["CREATE TABLE devnet_submission_observations","devnet_submission_observations_append_only","devnet_provider_contact_certainty","VALIDATION_FAILED"];
const DEVNET_RECOVERY_REQUIRED_TOKENS=["CREATE TYPE devnet_recovery_task_kind AS ENUM ('PREPARATION','RECONCILIATION')","CREATE TABLE devnet_recovery_leases","PRIMARY KEY(execution_id,task_kind)","lease_expires_at>claimed_at"];

async function main(): Promise<void> {
  const directory = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  if (files.length === 0) throw new Error("No ordered SQL migrations found.");
  if (new Set(files).size !== files.length) throw new Error("Migration names must be unique.");
  const first = await readFile(path.join(directory, files[0]), "utf8");
  for (const token of REQUIRED_TOKENS) {
    if (!first.includes(token)) throw new Error(`Migration is missing required token: ${token}`);
  }
  const identityMigration = files.find((file) => file === "002_identity_foundation.sql");
  if (!identityMigration) throw new Error("Identity foundation migration is missing.");
  const identitySql = await readFile(path.join(directory, identityMigration), "utf8");
  for (const token of IDENTITY_REQUIRED_TOKENS) {
    if (!identitySql.includes(token)) throw new Error(`Identity migration is missing required token: ${token}`);
  }
  const economicIdentityMigration = files.find((file) => file === "003_economic_identity.sql");
  if (!economicIdentityMigration) throw new Error("Economic identity migration is missing.");
  const economicIdentitySql = await readFile(path.join(directory, economicIdentityMigration), "utf8");
  for (const token of ECONOMIC_IDENTITY_REQUIRED_TOKENS) {
    if (!economicIdentitySql.includes(token)) throw new Error(`Economic identity migration is missing required token: ${token}`);
  }
  const executionMigration = files.find((file) => file === "005_payment_execution.sql");
  if (!executionMigration) throw new Error("Payment execution migration is missing.");
  const executionSql = await readFile(path.join(directory, executionMigration), "utf8");
  for (const token of EXECUTION_REQUIRED_TOKENS) {
    if (!executionSql.includes(token)) throw new Error(`Execution migration is missing required token: ${token}`);
  }
  const requestMigration=files.find(file=>file==="008_payment_requests.sql");
  if(!requestMigration)throw new Error("Payment request migration is missing.");
  const requestSql=await readFile(path.join(directory,requestMigration),"utf8");
  for(const token of REQUEST_REQUIRED_TOKENS)if(!requestSql.includes(token))throw new Error(`Payment request migration is missing required token: ${token}`);
  const syntheticMigration=files.find(file=>file==="009_synthetic_beta_identities.sql");if(!syntheticMigration)throw new Error("Synthetic beta identity migration is missing.");const syntheticSql=await readFile(path.join(directory,syntheticMigration),"utf8");for(const token of SYNTHETIC_REQUIRED_TOKENS)if(!syntheticSql.includes(token))throw new Error(`Synthetic migration is missing required token: ${token}`);
  const telemetryEpochMigration=files.find(file=>file==="011_open_beta_telemetry_epoch.sql");if(!telemetryEpochMigration)throw new Error("Open Beta telemetry epoch migration is missing.");const telemetryEpochSql=await readFile(path.join(directory,telemetryEpochMigration),"utf8");for(const token of TELEMETRY_EPOCH_REQUIRED_TOKENS)if(!telemetryEpochSql.includes(token))throw new Error(`Telemetry epoch migration is missing required token: ${token}`);
  const devnetStateMigration=files.find(file=>file==="012_devnet_execution_state_contract.sql");if(!devnetStateMigration)throw new Error("Devnet execution state migration is missing.");const devnetStateSql=await readFile(path.join(directory,devnetStateMigration),"utf8");for(const token of DEVNET_STATE_REQUIRED_TOKENS)if(!devnetStateSql.includes(token))throw new Error(`Devnet state migration is missing required token: ${token}`);
  const devnetReconciliationMigration=files.find(file=>file==="013_devnet_reconciliation_observations.sql");if(!devnetReconciliationMigration)throw new Error("Devnet reconciliation migration is missing.");const devnetReconciliationSql=await readFile(path.join(directory,devnetReconciliationMigration),"utf8");for(const token of DEVNET_RECONCILIATION_REQUIRED_TOKENS)if(!devnetReconciliationSql.includes(token))throw new Error(`Devnet reconciliation migration is missing required token: ${token}`);
  const devnetSubmissionMigration=files.find(file=>file==="014_devnet_submission_observations.sql");if(!devnetSubmissionMigration)throw new Error("Devnet submission observation migration is missing.");const devnetSubmissionSql=await readFile(path.join(directory,devnetSubmissionMigration),"utf8");for(const token of DEVNET_SUBMISSION_REQUIRED_TOKENS)if(!devnetSubmissionSql.includes(token))throw new Error(`Devnet submission observation migration is missing required token: ${token}`);
  const devnetRecoveryMigration=files.find(file=>file==="015_devnet_recovery_leases.sql");if(!devnetRecoveryMigration)throw new Error("Devnet recovery lease migration is missing.");const devnetRecoverySql=await readFile(path.join(directory,devnetRecoveryMigration),"utf8");for(const token of DEVNET_RECOVERY_REQUIRED_TOKENS)if(!devnetRecoverySql.includes(token))throw new Error(`Devnet recovery migration is missing required token: ${token}`);if(/SUBMISSION/i.test(devnetRecoverySql))throw new Error("Devnet recovery lease migration must never define submission work.");
  for (const [file, sql] of [[files[0], first], [identityMigration, identitySql], [economicIdentityMigration, economicIdentitySql]] as const) {
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(sql)) {
      throw new Error(`Transaction control belongs to the migration runner: ${file}`);
    }
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
