import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import { CIRCLE_SOLANA_DEVNET_USDC_MINT } from "../src/devnet/canonicalDevnetAsset";
import { assertLiveCanaryDatabaseReady, buildLiveCanaryProcessEnvironment, LIVE_CANARY_ENV_KEYS, liveCanaryLaunch, loadLiveCanaryEnvironment } from "../src/e2e/liveCanaryEnvironment";

const signer = Keypair.fromSeed(Buffer.alloc(32, 31)), destination = Keypair.fromSeed(Buffer.alloc(32, 32)).publicKey.toBase58();
function values(): Record<string, string> {
  return {
    NODE_ENV: "test", DATABASE_URL: "postgresql://user:password@127.0.0.1:55432/zephipay_auth_test",
    E2E_DEVNET_DESTINATION_WALLET: destination, E2E_LIVE_CANARY_CONFIRMATION: "I_UNDERSTAND_THIS_SUBMITS_DEVNET_USDC",
    DEVNET_INTEGRATION_ENABLED: "true", DEVNET_BROWSER_API_ENABLED: "true", DEVNET_PREPARATION_ENABLED: "true",
    DEVNET_SUBMISSION_ENABLED: "true", DEVNET_RECONCILIATION_ENABLED: "true", DEVNET_SUBMISSION_PROVIDER_ID: "helius-devnet-submit",
    DEVNET_SUBMISSION_RPC_URL: "https://devnet.helius-rpc.com/", DEVNET_SUBMISSION_API_KEY: "test-secret",
    DEVNET_RECONCILIATION_PROVIDER_ID: "solana-public-devnet-reconcile", DEVNET_RECONCILIATION_RPC_URL: "https://api.devnet.solana.com/",
    DEVNET_RPC_TIMEOUT_MS: "500", DEVNET_PREPARATION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
    DEVNET_PREPARATION_ENCRYPTION_KEY_VERSION: "v1", DEVNET_SIGNER_SECRET_KEY_BASE64: Buffer.from(signer.secretKey).toString("base64"),
    DEVNET_SIGNER_KEY_ID: "canary", DEVNET_SIGNER_KEY_VERSION: "v1", DEVNET_SIGNER_PUBLIC_KEY: signer.publicKey.toBase58(),
    DEVNET_USDC_MINT: CIRCLE_SOLANA_DEVNET_USDC_MINT, DEVNET_MINT_DECIMALS: "6", DEVNET_SOURCE_TOKEN_ACCOUNT: destination,
  };
}
async function fixture(overrides: Record<string, string | undefined> = {}, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "zephipay-canary-env-")), file = join(directory, "canary.env"), data = { ...values(), ...overrides };
  await writeFile(file, Object.entries(data).filter((entry): entry is [string,string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`).join("\n"), { mode });
  await chmod(file, mode);
  return file;
}

test("missing or overbroad canary env file fails closed", async () => {
  await assert.rejects(() => loadLiveCanaryEnvironment(join(tmpdir(), "absent-canary.env")), /missing or unreadable/);
  const broad = await fixture({}, 0o644);
  await assert.rejects(() => loadLiveCanaryEnvironment(broad), /0600/);
});

test("explicit env file supplies the exact child process environment", async () => {
  const loaded = await loadLiveCanaryEnvironment(await fixture()), environment = buildLiveCanaryProcessEnvironment({ NODE_ENV: "production", DATABASE_URL: "postgresql://wrong/wrong" }, loaded), launch = liveCanaryLaunch(environment, "human-to-human-happy-path");
  assert.equal(environment.DATABASE_URL, values().DATABASE_URL);
  assert.equal(launch.environment, environment);
  assert.deepEqual(launch.arguments.slice(-3), ["--scenario", "human-to-human-happy-path", "--live-devnet"]);
});

test("missing required values, wrong database, undeclared keys, and forensic database variables fail closed", async () => {
  const missing = await loadLiveCanaryEnvironment(await fixture({ DATABASE_URL: undefined }));
  assert.throws(() => buildLiveCanaryProcessEnvironment({}, missing), /DATABASE_URL is missing/);
  const wrong = await loadLiveCanaryEnvironment(await fixture({ DATABASE_URL: "postgresql://user:password@127.0.0.1:55432/wrong" }));
  assert.throws(() => buildLiveCanaryProcessEnvironment({}, wrong), /must target zephipay_auth_test/);
  for (const key of ["E6_DATABASE_URL", "E6B_DATABASE_URL", "TEST_DATABASE_URL"]) assert.throws(() => buildLiveCanaryProcessEnvironment({ [key]: "postgresql://forensic/db" }, values()), new RegExp(key));
  const file = await fixture(); await writeFile(file, `${LIVE_CANARY_ENV_KEYS.map(key => `${key}=${values()[key]}`).join("\n")}\nUNREVIEWED=value`, { mode: 0o600 });
  await assert.rejects(() => loadLiveCanaryEnvironment(file), /undeclared key/);
});

test("missing capability or secret fails before readiness", () => {
  for (const override of [{ DEVNET_SUBMISSION_ENABLED: "false" }, { DEVNET_SUBMISSION_API_KEY: "" }, { DEVNET_SIGNER_SECRET_KEY_BASE64: "" }]) assert.throws(() => buildLiveCanaryProcessEnvironment({}, { ...values(), ...override }), /missing|required|enabled/i);
});

test("readiness checks only migration and actors and cannot create providers or payments", async () => {
  const queries: string[] = [];
  await assertLiveCanaryDatabaseReady({ async query(sql: string) { queries.push(sql); return { rows: [{ migration_019: true, actor_count: 2, destination }] }; } } as never, values());
  assert.equal(queries.length, 1); assert.equal(/INSERT|UPDATE|DELETE|payment_intents/i.test(queries[0]), false);
  await assert.rejects(() => assertLiveCanaryDatabaseReady({ async query() { return { rows: [{ migration_019: false, actor_count: 2, destination }] }; } } as never, values()), /Migration 019/);
  await assert.rejects(() => assertLiveCanaryDatabaseReady({ async query() { return { rows: [{ migration_019: true, actor_count: 1, destination: null }] }; } } as never, values()), /actors/);
});
