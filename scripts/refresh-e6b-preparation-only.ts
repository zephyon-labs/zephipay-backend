import { Pool } from "pg";
import { parseE6bRefreshRequest, postgresE6bRefreshDependencies, runE6bPreparationRefresh } from "../src/devnet/e6bPreparationRefresh";
async function main(){const request=parseE6bRefreshRequest(process.env),pool=new Pool({connectionString:request.databaseUrl,max:2,connectionTimeoutMillis:5_000,statement_timeout:30_000,lock_timeout:15_000,idle_in_transaction_session_timeout:15_000});try{const result=await runE6bPreparationRefresh(request,postgresE6bRefreshDependencies(pool,request));process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}finally{await pool.end();}}
main().catch(()=>{process.stderr.write("E6B pre-contact refresh failed with a sanitized validation, persistence, or Devnet read error.\n");process.exitCode=1;});
