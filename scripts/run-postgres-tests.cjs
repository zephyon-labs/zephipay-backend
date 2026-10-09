const {spawnSync}=require("node:child_process");
const {resolve}=require("node:path");
const source=process.env.CONTROLLED_SITE_SOURCE;
const env=source?{...process.env,TSX_TSCONFIG_PATH:resolve(source,"tsconfig.json")}:process.env;
const args=["--test", "--test-concurrency=1", "tests/postgresPaymentFoundation.integration.ts", "tests/postgresIdentityFoundation.integration.ts", "tests/postgresEconomicIdentity.integration.ts", "tests/postgresPaymentIdentity.integration.ts", "tests/postgresExecution.integration.ts", "tests/postgresDevnetExecutionState.integration.ts", "tests/postgresBrowserDevnetExecution.integration.ts", "tests/postgresPaymentRequests.integration.ts", "tests/postgresOpenBetaActivity.integration.ts", "tests/postgresActivity.integration.ts", "tests/r4Invariants.integration.ts", "tests/postgresE2eReliability.integration.ts", "tests/postgresEconomicFinalization.integration.ts", "tests/postgresOperationalAuthority.integration.ts", "tests/postgresAuthorityComposition.integration.ts", "tests/postgresProviderReadiness.integration.ts", "tests/postgresAuth0Confirmation.integration.ts", "tests/postgresConfirmationUpgrade.integration.ts"];
const result=spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs",...args],{stdio:"inherit",env});
if(result.error)throw result.error;
process.exit(result.status ?? 1);
