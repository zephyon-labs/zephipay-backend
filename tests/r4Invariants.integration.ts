import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { verifyEconomicInvariants } from "../scripts/r4/invariants";

const url=process.env.TEST_DATABASE_URL?.trim();if(!url)throw new Error("TEST_DATABASE_URL is required.");const pool=new Pool({connectionString:url,max:1});
before(async()=>{await pool.query("TRUNCATE payment_execution_receipts,payment_execution_events,payment_execution_attempts,payment_executions,payment_events,payments,external_identities,account_security_events,account_sessions,economic_identities,payment_destinations,beta_allowlist,accounts CASCADE");});after(async()=>pool.end());
test("R4 authoritative invariant checker accepts a clean migrated database",async()=>{const report=await verifyEconomicInvariants(pool,{crossAccountReadsDenied:true});assert.equal(report.passed,true);assert.deepEqual(report.violations,[]);});
