import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";

import { PostgresEconomicIdentityPersistence } from "../src/storage/postgres/postgresEconomicIdentityPersistence";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresPaymentPersistence } from "../src/storage/postgres/postgresPaymentPersistence";

const url=process.env.TEST_DATABASE_URL?.trim(); if(!url) throw new Error("TEST_DATABASE_URL is required.");
const pool=new Pool({connectionString:url,max:12}); const accounts=new PostgresIdentityPersistence(pool);
const economic=new PostgresEconomicIdentityPersistence(pool); const payments=new PostgresPaymentPersistence(pool);
const SENDER="00000000-0000-4000-8000-000000000801", RECIPIENT="00000000-0000-4000-8000-000000000802";
const ACTOR=`zp:account:${SENDER}`, WALLET="2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const NOW="2026-08-05T12:00:00.000Z"; const execFileAsync=promisify(execFile);

before(async()=>{
  for(let i=0;i<2;i++) await execFileAsync(process.execPath,["--import","tsx","scripts/run-migrations.ts"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url}});
  const sql=await readFile(path.resolve("migrations/004_payment_identity_linkage.sql"),"utf8");
  const row=await pool.query("SELECT checksum FROM payment_schema_migrations WHERE version='004_payment_identity_linkage.sql'");
  assert.equal(row.rows.length,1); assert.equal(row.rows[0].checksum,createHash("sha256").update(sql).digest("hex"));
});
beforeEach(async()=>{
  await pool.query("TRUNCATE payment_events,payment_receipts,payments,beta_allowlist,economic_identities,payment_destinations,account_security_events,account_sessions,external_identities,accounts RESTART IDENTITY CASCADE");
  await accounts.createAccount({accountId:SENDER,createdAt:NOW}); await accounts.createAccount({accountId:RECIPIENT,createdAt:NOW});
  await payments.createAllowlistEntry({actorSubject:ACTOR});
  const identity=(await economic.upsertEconomicIdentity({accountId:RECIPIENT,accountType:"CREATOR",username:"recent_01",normalizedUsername:"recent_01",displayName:"Recent Creator",discoverability:"USERNAME_ONLY",occurredAt:NOW})).identity;
  await economic.updateEconomicIdentityState({accountId:RECIPIENT,expectedVersion:identity.version,publicIdentityStatus:"ACTIVE",verificationState:"UNVERIFIED",payabilityState:"AVAILABLE",occurredAt:NOW});
  await economic.upsertSolanaDestination({destinationId:randomUUID(),accountId:RECIPIENT,address:WALLET,primary:true,occurredAt:NOW});
});
after(async()=>pool.end());

function input(overrides:Record<string,unknown>={}) { return {id:randomUUID(),actorSubject:ACTOR,senderAccountId:SENDER,idempotencyKey:"identity-key-00000001",recipientAccountId:RECIPIENT,trustAcknowledged:true,network:"solana-devnet" as const,rail:"solana" as const,asset:"USDC" as const,mintAddress:"mint",amountRaw:1_000_000n,purpose:"Identity test",capturedAt:NOW,...overrides}; }

describe("PostgreSQL Payment Identity linkage",()=>{
  it("atomically creates, snapshots, hides no persistence evidence, and converges",async()=>{
    const claims=await Promise.all(Array.from({length:12},()=>payments.claimPaymentIdentityKey(input({id:randomUUID()}))));
    assert.equal(claims.filter(x=>x.outcome==="CLAIMED").length,1); assert.equal(claims.filter(x=>x.outcome==="EXISTING").length,11);
    const payment=claims[0].payment; assert.equal(payment.recipientType,"PAYMENT_IDENTITY"); assert.equal(payment.recipientAddress,WALLET);
    assert.equal(payment.recipientSnapshot?.trustOutcome,"ACKNOWLEDGED"); assert.equal(payment.recipientSnapshotVersion,1);
    const events=await payments.listPaymentEvents(payment.id); assert.deepEqual(Object.keys(events[0].details).sort(),["recipientAccountId","recipientSnapshotVersion","recipientType","trustConfirmationOutcome"]);
    await assert.rejects(()=>pool.query("UPDATE payments SET recipient_snapshot=recipient_snapshot || '{\"displayName\":\"Changed\"}'::jsonb WHERE id=$1",[payment.id]),/immutable/);
  });
  it("requires trust, conflicts on canonical changes, and derives recents only after confirmation",async()=>{
    await assert.rejects(()=>payments.claimPaymentIdentityKey(input({trustAcknowledged:false})),/TRUST_ACKNOWLEDGMENT_REQUIRED/);
    const claim=await payments.claimPaymentIdentityKey(input()); assert.deepEqual(await payments.listRecentPaymentIdentities(ACTOR,5),[]);
    await payments.transitionPayment({paymentId:claim.payment.id,expectedVersion:0n,toStatus:"PROCESSING",evidence:{userConfirmedAt:NOW,executionStartedAt:NOW},occurredAt:NOW});
    const recent=await payments.listRecentPaymentIdentities(ACTOR,5); assert.equal(recent.length,1); assert.equal(recent[0].accountId,RECIPIENT);
    assert.equal((await payments.claimPaymentIdentityKey(input({amountRaw:2_000_000n}))).outcome,"HASH_CONFLICT");
    await pool.query("UPDATE economic_identities SET discoverability='PRIVATE',version=version+1,updated_at=updated_at + interval '1 second' WHERE account_id=$1",[RECIPIENT]);
    assert.equal((await payments.listRecentPaymentIdentities(ACTOR,5)).length,1);
    await assert.rejects(()=>payments.claimPaymentIdentityKey(input({idempotencyKey:"identity-key-00000002"})),/RECIPIENT_UNAVAILABLE/);
  });
});
