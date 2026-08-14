import"dotenv/config";import{runE6aReadOnlyValidation}from"../src/devnet/e6aReadOnlyValidation";
async function main(){const result=await runE6aReadOnlyValidation(process.env,globalThis.fetch);process.stdout.write(`${JSON.stringify(result,null,2)}\n`);process.stdout.write("E6A is operator-only and does not activate normal startup, capabilities, or workers.\n");process.exitCode=result.verdict==="PASS"?0:1;}
main().catch(()=>{process.stderr.write("E6A launcher failed with a sanitized local error.\n");process.exitCode=1;});
