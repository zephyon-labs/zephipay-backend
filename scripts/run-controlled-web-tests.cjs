const {spawnSync}=require("node:child_process");
const {existsSync}=require("node:fs");
const {resolve}=require("node:path");
const source=process.env.CONTROLLED_SITE_SOURCE;
if(!source || !existsSync(resolve(source,"src/lib/controlledConfirmation/sdkFlow.ts"))) {
  console.error("CONTROLLED_SITE_SOURCE must identify the candidate Site checkout; no synthetic replacement is allowed.");process.exit(1);
}
const result=spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","--test","--test-name-pattern=web handoff:","tests/postgresAuth0Confirmation.integration.ts"],{stdio:"inherit",env:{...process.env,TSX_TSCONFIG_PATH:resolve(source,"tsconfig.json")}});
if(result.error)throw result.error;
process.exit(result.status ?? 1);
