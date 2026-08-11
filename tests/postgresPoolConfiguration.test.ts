import assert from "node:assert/strict";
import { test } from "node:test";
import { PAYMENT_POSTGRES_POOL_CONFIG } from "../src/storage/postgres/postgresPool";

test("runtime PostgreSQL pool uses the approved bounded lifecycle and timeout configuration",()=>{
  assert.deepEqual(PAYMENT_POSTGRES_POOL_CONFIG,{
    max:10,min:0,idleTimeoutMillis:30_000,connectionTimeoutMillis:5_000,
    keepAlive:true,keepAliveInitialDelayMillis:10_000,maxUses:5_000,
    statement_timeout:30_000,lock_timeout:15_000,idle_in_transaction_session_timeout:15_000,
  });
  assert.equal("query_timeout" in PAYMENT_POSTGRES_POOL_CONFIG,false);
  assert.equal("maxLifetimeSeconds" in PAYMENT_POSTGRES_POOL_CONFIG,false);
});
