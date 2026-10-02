import { Pool } from "pg";
import { verifyAuthorityLogin } from "../src/economic/composition/verifyAuthorityLogin";
import { authorityPrivilegePolicy, EconomicAuthorityRole } from "../src/economic/composition/authorityPrivilegePolicy";
async function main() {
  const role=process.argv[2],url=process.env.DATABASE_URL?.trim();
  if (!url || !Object.prototype.hasOwnProperty.call(authorityPrivilegePolicy,role ?? "")) throw new Error("Usage: DATABASE_URL=<login connection> npm run db:economic:verify -- app|issuer|signer|observer|reader");
  const pool=new Pool({connectionString:url,max:1});
  try { await verifyAuthorityLogin(pool,role as EconomicAuthorityRole,{syntheticFixtures:process.argv.includes("--synthetic-fixtures")}); process.stdout.write(`Economic ${role} login readiness passed.\n`); }
  finally { await pool.end(); }
}
void main().catch(error=>{process.stderr.write(`${error instanceof Error && error.message.startsWith("Economic ACL") ? error.message : "Economic login verification failed; check connection and role configuration."}\n`);process.exitCode=1;});
