import { Pool } from "pg";
import { parseE6cRequest, postgresE6cDependencies, runE6cOperatorSubmission } from "../src/devnet/e6cOperatorSubmission";
async function main(){const request=parseE6cRequest(process.env),pool=new Pool({connectionString:request.databaseUrl,max:2,connectionTimeoutMillis:5_000,statement_timeout:30_000,lock_timeout:15_000,idle_in_transaction_session_timeout:15_000});try{const result=await runE6cOperatorSubmission(request,postgresE6cDependencies(pool,request));process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}finally{await pool.end();}}
main().catch(()=>{process.stderr.write("E6C operator submission stopped with a sanitized validation, persistence, or provider result.\n");process.exitCode=1;});
