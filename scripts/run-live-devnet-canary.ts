import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Pool } from "pg";

import { assertLiveCanaryDatabaseReady, buildLiveCanaryProcessEnvironment, DEFAULT_LIVE_CANARY_ENV_FILE, liveCanaryLaunch, loadLiveCanaryEnvironment } from "../src/e2e/liveCanaryEnvironment";
import { sanitizedDatabaseTarget } from "../src/e2e/e2eDatabaseSelection";

type Command = "ready" | "live";
const executeFile = promisify(execFile);
function argumentsForInvocation(): { command: Command; envFile: string; scenario?: string } {
  const values = process.argv.slice(2), command = values.shift();
  if (command !== "ready" && command !== "live") throw new Error("Use ready or live.");
  const envAt = values.indexOf("--env-file"), envFile = envAt >= 0 ? values[envAt + 1] : DEFAULT_LIVE_CANARY_ENV_FILE;
  if (!envFile || (envAt >= 0 && !values[envAt + 1])) throw new Error("--env-file requires one explicit path.");
  if (envAt >= 0) values.splice(envAt, 2);
  if (command === "ready") { if (values.length) throw new Error("Readiness accepts only --env-file."); return { command, envFile }; }
  const scenarioAt = values.indexOf("--scenario");
  if (scenarioAt < 0 || values[scenarioAt + 1] !== "human-to-human-happy-path" || values.length !== 2) throw new Error("Live launch requires exactly --scenario human-to-human-happy-path.");
  return { command, envFile, scenario: values[scenarioAt + 1] };
}

async function main() {
  const invocation = argumentsForInvocation(), loaded = await loadLiveCanaryEnvironment(invocation.envFile), env = buildLiveCanaryProcessEnvironment(process.env, loaded);
  const [{ stdout: branch }, { stdout: worktree }] = await Promise.all([executeFile("git", ["branch", "--show-current"]), executeFile("git", ["status", "--porcelain"])]);
  if (branch.trim() !== "integration/devnet-v0.3") throw new Error("Live canary requires branch integration/devnet-v0.3.");
  if (worktree.trim()) throw new Error("Live canary requires a clean working tree.");
  const target = sanitizedDatabaseTarget(env.DATABASE_URL!), pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try { await assertLiveCanaryDatabaseReady(pool, env); } finally { await pool.end(); }
  process.stdout.write(`LIVE CANARY ENV: PASS\nDATABASE: ${target.database} @ ${target.host}:${target.port}\nSCHEMA 019: PASS\nSYNTHETIC ACTORS: PASS\nFLOW: H2H/P2P\nGIT: CLEAN integration/devnet-v0.3\nMAINNET: BLOCKED\nPROVIDERS: NOT CONSTRUCTED\n${invocation.command === "ready" ? "LIVE CANARY: READY" : "LIVE CANARY: PREFLIGHT PASS"}\n`);
  if (invocation.command === "ready") return;
  const launch = liveCanaryLaunch(env, invocation.scenario!);
  const child = spawn(launch.executable, launch.arguments, { cwd: process.cwd(), env: launch.environment as NodeJS.ProcessEnv, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", value => resolve(value ?? 1)); });
  process.exitCode = code;
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Live canary environment validation failed."}\n`); process.exitCode = 1; });
