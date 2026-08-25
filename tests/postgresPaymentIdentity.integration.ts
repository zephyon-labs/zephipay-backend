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
import {PostgresSyntheticBetaIdentityStore}from"../src/storage/postgres/postgresSyntheticBetaIdentityStore";import{syntheticBetaIdentity}from"../src/recipients/syntheticBetaIdentity";

const url=process.env.TEST_DATABASE_URL?.trim(); if(!url) throw new Error("TEST_DATABASE_URL is required.");
const pool=new Pool({connectionString:url,max:12}); const accounts=new PostgresIdentityPersistence(pool);
const economic=new PostgresEconomicIdentityPersistence(pool); const payments=new PostgresPaymentPersistence(pool);
const synthetics=new PostgresSyntheticBetaIdentityStore(pool);
const SENDER="00000000-0000-4000-8000-000000000801", RECIPIENT="00000000-0000-4000-8000-000000000802";
const ACTOR=`zp:account:${SENDER}`, WALLET="2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";
const OTHER_RECIPIENT="00000000-0000-4000-8000-000000000803", ROTATED_WALLET="4Nd1mYwRkXkYtGT7dQz4FzRzCQXDpGfVv3YJz7drGqPv";
const NOW="2026-08-05T12:00:00.000Z"; const execFileAsync=promisify(execFile);

before(async()=>{
  for(let i=0;i<2;i++) await execFileAsync(process.execPath,["--import","tsx","scripts/run-migrations.ts"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url}});
  const sql=await readFile(path.resolve("migrations/004_payment_identity_linkage.sql"),"utf8");
  const row=await pool.query("SELECT checksum FROM payment_schema_migrations WHERE version='004_payment_identity_linkage.sql'");
  assert.equal(row.rows.length,1); assert.equal(row.rows[0].checksum,createHash("sha256").update(sql).digest("hex"));
});
beforeEach(async()=>{
  await pool.query("TRUNCATE payment_events,payment_receipts,payments,beta_allowlist,synthetic_beta_identities,economic_identities,payment_destinations,account_security_events,account_sessions,external_identities,accounts RESTART IDENTITY CASCADE");
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
    assert.equal(recent[0].username,"recent_01"); assert.equal(recent[0].displayName,"Recent Creator");
    assert.equal((await payments.claimPaymentIdentityKey(input({amountRaw:2_000_000n}))).outcome,"HASH_CONFLICT");
    const current=await economic.findEconomicIdentity(RECIPIENT); assert.ok(current);
    const changed=await economic.upsertEconomicIdentity({accountId:RECIPIENT,expectedVersion:current.version,accountType:"PERSONAL",username:"current_02",normalizedUsername:"current_02",displayName:"Current Creator",avatarUrl:"https://example.com/current.png",discoverability:"PUBLIC"});
    assert.equal(changed.identity.accountType,"CREATOR");
    const fresh=await payments.claimPaymentIdentityKey(input({idempotencyKey:"identity-key-00000002"}));
    assert.equal(fresh.payment.recipientSnapshot?.username,"current_02"); assert.equal(fresh.payment.recipientSnapshot?.displayName,"Current Creator");
    const historical=await payments.listRecentPaymentIdentities(ACTOR,5); assert.equal(historical[0].username,"recent_01"); assert.equal(historical[0].displayName,"Recent Creator");
    await pool.query("UPDATE economic_identities SET discoverability='PRIVATE',version=version+1,updated_at=updated_at + interval '1 second' WHERE account_id=$1",[RECIPIENT]);
    assert.equal((await payments.listRecentPaymentIdentities(ACTOR,5)).length,1);
    await assert.rejects(()=>payments.claimPaymentIdentityKey(input({idempotencyKey:"identity-key-00000003"})),/RECIPIENT_UNAVAILABLE/);
  });
  it("replays frozen recipient semantics before mutable PostgreSQL directory and destination state",async()=>{
    const claimed=await payments.claimPaymentIdentityKey(input());
    await economic.upsertSolanaDestination({destinationId:randomUUID(),accountId:RECIPIENT,address:ROTATED_WALLET,primary:true,occurredAt:"2026-08-05T12:01:00.000Z"});
    await pool.query("UPDATE economic_identities SET username='reassigned_02',normalized_username='reassigned_02',display_name='Reassigned Recipient',discoverability='PRIVATE',verification_state='RESTRICTED',payability_state='RESTRICTED',version=version+1,updated_at=updated_at+interval '2 seconds' WHERE account_id=$1",[RECIPIENT]);
    const recipientAccount=await accounts.findAccount(RECIPIENT);assert.ok(recipientAccount);await accounts.updateAccountStatus({accountId:RECIPIENT,expectedVersion:recipientAccount.version,status:"SUSPENDED",occurredAt:"2026-08-05T12:03:00.000Z"});
    const replay=await payments.claimPaymentIdentityKey(input({id:randomUUID(),capturedAt:"2026-08-05T12:05:00.000Z"}));
    assert.equal(replay.outcome,"EXISTING");assert.equal(replay.payment.id,claimed.payment.id);assert.equal(replay.payment.recipientAccountId,RECIPIENT);assert.equal(replay.payment.recipientAddress,WALLET);assert.equal(replay.payment.recipientSnapshot?.username,"recent_01");assert.equal(replay.payment.recipientSnapshot?.displayName,"Recent Creator");
    for(const override of[{recipientAccountId:OTHER_RECIPIENT},{amountRaw:2_000_000n},{purpose:"Changed"},{network:"solana-mainnet"},{mintAddress:"other-mint"},{rail:"mock"},{asset:"ZERA"},{trustAcknowledged:false}])assert.equal((await payments.claimPaymentIdentityKey(input(override) as any)).outcome,"HASH_CONFLICT");
    await assert.rejects(()=>payments.claimPaymentIdentityKey(input({idempotencyKey:"identity-key-00000099"})),/RECIPIENT_UNAVAILABLE/);
  });
  it("persists synthetic linkage as trust-not-required without canonical account pollution and excludes it from recents",async()=>{const synthetic=await synthetics.claim(syntheticBetaIdentity("Nova"));const claim=await payments.claimSyntheticPaymentIdentityKey({id:randomUUID(),actorSubject:ACTOR,senderAccountId:SENDER,idempotencyKey:"synthetic-pg-key-01",syntheticId:synthetic.syntheticId,username:synthetic.username,displayName:synthetic.displayName,network:"solana-devnet",rail:"solana",asset:"USDC",mintAddress:"mint",amountRaw:2_000_000n,purpose:null,capturedAt:NOW});assert.equal(claim.payment.recipientAccountId,undefined);assert.equal(claim.payment.recipientSyntheticId,synthetic.syntheticId);assert.equal(claim.payment.recipientSnapshot?.identitySource,"SYNTHETIC_BETA");assert.equal(claim.payment.recipientSnapshot?.trustOutcome,"NOT_REQUIRED");assert.equal(claim.payment.trustConfirmationOutcome,"NOT_REQUIRED");assert.equal((await accounts.findAccount(synthetic.syntheticId)),undefined);await payments.transitionPayment({paymentId:claim.payment.id,expectedVersion:0n,toStatus:"PROCESSING",evidence:{userConfirmedAt:NOW,executionStartedAt:NOW},occurredAt:NOW});assert.deepEqual(await payments.listRecentPaymentIdentities(ACTOR,5),[]);await assert.rejects(()=>pool.query("UPDATE payments SET recipient_synthetic_id=$2 WHERE id=$1",[claim.payment.id,randomUUID()]),/immutable|foreign key/)});
  it("replays synthetic linkage from frozen history even when current classification metadata differs",async()=>{const synthetic=await synthetics.claim(syntheticBetaIdentity("Replay Synthetic")),base={id:randomUUID(),actorSubject:ACTOR,senderAccountId:SENDER,idempotencyKey:"synthetic-replay-key-01",syntheticId:synthetic.syntheticId,username:synthetic.username,displayName:synthetic.displayName,network:"solana-devnet"as const,rail:"solana"as const,asset:"USDC"as const,mintAddress:"mint",amountRaw:2_000_000n,purpose:null,capturedAt:NOW};const first=await payments.claimSyntheticPaymentIdentityKey(base),metadataReplay=await payments.claimSyntheticPaymentIdentityKey({...base,id:randomUUID(),username:"changed_locator",displayName:"Changed Presentation"});assert.equal(metadataReplay.outcome,"EXISTING");assert.equal(metadataReplay.payment.id,first.payment.id);const canonicalPathReplay=await payments.claimPaymentIdentityKey(input({id:randomUUID(),idempotencyKey:base.idempotencyKey,recipientAccountId:synthetic.syntheticId,amountRaw:base.amountRaw,purpose:null}));assert.equal(canonicalPathReplay.outcome,"EXISTING");assert.equal(canonicalPathReplay.payment.recipientSyntheticId,synthetic.syntheticId);assert.equal((await payments.claimPaymentIdentityKey(input({idempotencyKey:base.idempotencyKey,recipientAccountId:synthetic.syntheticId,amountRaw:3_000_000n,purpose:null}))).outcome,"HASH_CONFLICT")});
});
