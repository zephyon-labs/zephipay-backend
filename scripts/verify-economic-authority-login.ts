import { Pool } from "pg";
import { verifyAuthorityLogin, type DeploymentExpectation } from "../src/economic/composition/verifyAuthorityLogin";
import { authorityPrivilegePolicy, EconomicAuthorityRole } from "../src/economic/composition/authorityPrivilegePolicy";
async function main() {
  const role=process.argv[2],url=process.env.DATABASE_URL?.trim();
  if (!url || !Object.prototype.hasOwnProperty.call(authorityPrivilegePolicy,role ?? "")) throw new Error("Usage: DATABASE_URL=<login connection> npm run db:economic:verify -- identity|app|issuer|signer|observer|reader [--deployment]");
  let deployment: DeploymentExpectation | undefined;
  if(process.argv.includes("--deployment")) {
    const fields = {deploymentId:"ECONOMIC_DEPLOYMENT_ID",environment:"ECONOMIC_DEPLOYMENT_ENVIRONMENT",databaseName:"ECONOMIC_DATABASE_NAME",login:"ECONOMIC_LOGIN_NAME",
      credentialGeneration:"ECONOMIC_CREDENTIAL_GENERATION",schemaOwner:"ECONOMIC_SCHEMA_OWNER",identityOwner:"ECONOMIC_IDENTITY_OWNER"} as const;
    const values = Object.fromEntries(Object.entries(fields).map(([key,name])=>[key,process.env[name]?.trim()]));
    if(Object.values(values).some(value=>!value))throw new Error("Explicit deployment expectation is incomplete.");
    deployment=values as DeploymentExpectation;
  }
  const pool=new Pool({connectionString:url,max:1});
  try { await verifyAuthorityLogin(pool,role as EconomicAuthorityRole,{syntheticFixtures:process.argv.includes("--synthetic-fixtures"),deployment}); process.stdout.write(`Economic ${role} ${deployment?"deployment":"catalog"} login readiness passed.\n`); }
  finally { await pool.end(); }
}
void main().catch(error=>{process.stderr.write(`${error instanceof Error && error.message.startsWith("Economic ACL") ? error.message : "Economic login verification failed; check connection and role configuration."}\n`);process.exitCode=1;});
