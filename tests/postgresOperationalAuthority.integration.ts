import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { SignJWT } from "jose";
import { Pool, type PoolConfig, type PoolClient } from "pg";
import { parse } from "pg-connection-string";
import { Keypair, Message, Transaction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { EconomicIntentEnvelopeV1, authorizationBindingDigestV1, createEconomicIntentEnvelopeV1, offlineSponsoredMessageV1 } from "zephyon-protocol";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresFinalizationRepository } from "../src/economic/foundation/postgresFinalizationRepository";
import { createEconomicEvidenceIngestion, EvidencePolicy, TrustedRuntimeIssuer } from "../src/economic/foundation/evidenceIngestion";
import { SignerRequest, SignerResponse, TrustedExposureObserver, TrustedSignerPort } from "../src/economic/foundation/finalizationTypes";
import { TrustedRegistryAdministration, devnetUsdcConfiguration, qualifyAsset } from "../src/economic/foundation/trustedRegistry";
import { EconomicSessionAdministration } from "../src/economic/foundation/sessionAuthority";
import { sha256, transaction } from "../src/economic/foundation/database";

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL required; use a disposable database only.");
const pool = new Pool({ connectionString: url, max: 16 });
const roleNames = ["app","issuer","signer","observer","reader"] as const;
function loginPool(role: string): Pool { return new Pool({...parse(url!),user:`economic_fixture_${role}`,password:"disposable-economic-fixture-only",max:8} as PoolConfig); }
const appPool=loginPool("app"),issuerPool=loginPool("issuer"),signerPool=loginPool("signer"),observerPool=loginPool("observer"),readerPool=loginPool("reader");
const authorities={signerResults:signerPool,observerEvidence:observerPool};
const identities = new PostgresIdentityPersistence(pool), admin = new TrustedRegistryAdministration(pool);
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json", "utf8"));
const user = Keypair.fromSeed(new Uint8Array(32).fill(1)), sponsor = Keypair.fromSeed(new Uint8Array(32).fill(2));
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); // Disposable authentication test keys only.
const issuer = "https://economic-auth.example/", audience = "https://economic-api.example/";
const policy: EvidencePolicy = { auth: { issuer, audience, requiredScope: "confirm:economic", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }, runtimeIssuer: "runtime:test-authority", policyVersions: ["policy-v1"], context: "production" };
const config = devnetUsdcConfiguration(fixture.qualifiedAsset.network.genesisHash, "2026-01-01T00:00:00.000Z");
let principalId: string, accountId: string, sessionId: string, baseUrl: string, token: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

class RuntimeFixture implements TrustedRuntimeIssuer {
  transform: (value: any) => any = value => value;
  async evaluate(envelope: EconomicIntentEnvelopeV1): Promise<Uint8Array> {
    const value = this.transform(copy({ issuer: policy.runtimeIssuer, network: envelope.amount.asset.network, binding: {
      schema: "zephyon.runtime-binding/v1", reference: envelope.runtime, envelopeDigest: authorizationBindingDigestV1(envelope,envelope.amount.asset), result: "approved",
    } }));
    return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  }
}
const runtime = new RuntimeFixture(), ingestion = createEconomicEvidenceIngestion(issuerPool,policy,runtime);

class SignerFixture implements TrustedSignerPort {
  calls = 0; queries = 0; loseResponse = false; refuse = false;
  results = new Map<string,SignerResponse>();
  transform: (response: SignerResponse, request: SignerRequest) => SignerResponse = value => value;
  async finalize(request: SignerRequest): Promise<SignerResponse> {
    this.calls++;
    const stored = (await pool.query("SELECT signer_state,exposure_state FROM economic_finalizations WHERE finalization_id=$1", [request.operation.sponsorFinalizationId])).rows[0];
    assert.equal(stored.signer_state,"CONTACT_COMMITTED"); assert.equal(stored.exposure_state,"UNCERTAIN");
    const op = request.operation, identity = { signerOperationId: op.signerOperationId, tupleDigest: op.tupleDigest, network: op.tuple.network, sponsorKeyVersion: op.tuple.sponsorKeyVersion };
    const tx = Transaction.from(request.customerArtifact); tx.partialSign(sponsor);
    const response: SignerResponse = this.refuse ? { ...identity, state: "REFUSED", reference: `refusal:${op.signerOperationId}` } : { ...identity, state: "SIGNED", artifact: tx.serialize() };
    this.results.set(op.signerOperationId,response);
    if (this.loseResponse) throw new Error("fixture response lost after signing");
    return this.transform(response,request);
  }
  async query(request: SignerRequest): Promise<SignerResponse> {
    this.queries++;
    const op = request.operation;
    return this.transform(this.results.get(op.signerOperationId) ?? { signerOperationId: op.signerOperationId, tupleDigest: op.tupleDigest, network: op.tuple.network, sponsorKeyVersion: op.tuple.sponsorKeyVersion, state: "UNKNOWN" },request);
  }
}
let signer: SignerFixture, repo: PostgresFinalizationRepository;

before(async () => {
  for(const role of roleNames) {
    const name=`economic_fixture_${role}`,group=`zephipay_economic_${role}`;
    assert.equal((await pool.query("SELECT count(*) FROM pg_roles WHERE rolname=$1",[group])).rows[0].count,"1","Explicit db:economic:roles setup is mandatory");
    if(!(await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[name])).rowCount)
      await pool.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'disposable-economic-fixture-only'`);
    await pool.query(`GRANT ${group} TO ${name}`);
  }
  for(const [index,db] of [appPool,issuerPool,signerPool,observerPool,readerPool].entries()) {
    const r=(await db.query("SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(r.current_user,`economic_fixture_${roleNames[index]}`);assert.equal(r.session_user,r.current_user);
    for(const key of ["rolsuper","rolcreatedb","rolcreaterole","rolbypassrls"]) assert.equal(r[key],false);
    assert.equal((await db.query("SELECT pg_has_role(current_user,'zephipay_economic_admin','MEMBER') AS member")).rows[0].member,false);
  }
  assert.equal((await pool.query("SELECT count(*) FROM payment_schema_migrations WHERE version='023_trusted_economic_finalization.sql'")).rows[0].count,"1");
  const app = express();
  // No permissive JSON parser before the unmounted factory router.
  app.use("/test-consent",ingestion.consentRouter);
  server = app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening",resolve));
  const address = server.address(); assert(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}/test-consent`;
});
beforeEach(async () => {
  await pool.query("TRUNCATE economic_authority_events,economic_network_registry,economic_sponsor_budgets,accounts RESTART IDENTITY CASCADE");
  const provisioned = await identities.provisionExternalIdentity({ accountId: randomUUID(), identityId: randomUUID(), issuer, subject: "subject:alice", occurredAt:new Date(Date.now()-60_000).toISOString() });
  accountId = provisioned.account.accountId; principalId = provisioned.account.actorSubject;
  sessionId = randomUUID();
  await identities.createAccountSession({sessionId,accountId,expectedAccountVersion:provisioned.account.version,createdAt:new Date(Date.now()-30_000).toISOString(),expiresAt:new Date(Date.now()+7200_000).toISOString()});
  await new EconomicSessionAdministration(issuerPool).bind({issuer,providerSubject:"subject:alice",providerSessionReference:"session:test",accountSessionId:sessionId});
  token = await jwt(); runtime.transform = value => value;
  signer = new SignerFixture(); repo = new PostgresFinalizationRepository(appPool,policy,signer,undefined,authorities);
  await admin.install(config);
});
after(async () => { if (server) await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); await Promise.all([appPool,issuerPool,signerPool,observerPool,readerPool,pool].map(db=>db.end())); });

async function jwt(options: { issuer?: string; audience?: string; subject?: string; scope?: string; expires?: number; key?: any } = {}) {
  const now = Math.floor(Date.now()/1000);
  return new SignJWT({ scope: options.scope ?? "confirm:economic", sid: "session:test" }).setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(options.issuer ?? issuer).setAudience(options.audience ?? audience).setSubject(options.subject ?? "subject:alice")
    .setIssuedAt(now-2).setExpirationTime(options.expires ?? now+3600).sign(options.key ?? keys.privateKey);
}
function envelope(change?: (e: any) => void): EconomicIntentEnvelopeV1 {
  const e = copy(fixture.envelope), now = Date.now();
  e.principal.id = principalId; e.attempt.intentId = randomUUID(); e.attempt.attemptId = randomUUID(); e.attempt.fenceToken = randomUUID();
  e.createdAt = new Date(now-60_000).toISOString(); e.expiresAt = new Date(now+3600_000).toISOString();
  e.runtime.decisionId = randomUUID(); e.runtime.validFrom = e.createdAt; e.runtime.validUntil = e.expiresAt; e.runtime.scope = "production";
  change?.(e); return createEconomicIntentEnvelopeV1(e,e.amount.asset);
}
function artifact(e: EconomicIntentEnvelopeV1, blockhash = fixture.recentBlockhash): Buffer {
  const tx = Transaction.populate(Message.from(offlineSponsoredMessageV1(e,blockhash))); tx.partialSign(user);
  return tx.serialize({ requireAllSignatures: false });
}
async function confirm(digest: string, bearer = token, raw = JSON.stringify({ envelopeDigest: digest })) {
  return fetch(baseUrl,{ method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: raw });
}
async function prepared(e = envelope(), options = { consent: true, runtime: true }) {
  const digest = await repo.registerAttempt(e,fixture.recentBlockhash);
  let consentId = randomUUID();
  if (options.consent) { const res = await confirm(digest); assert.equal(res.status,201,await res.clone().text()); consentId = (await res.json() as any).consentId; }
  if (options.runtime) await ingestion.issueRuntimeDecision(digest);
  return { e, digest, claim: { sponsorFinalizationId: randomUUID(), envelopeDigest: digest, consentId, customerArtifact: artifact(e) } };
}
async function budget(limits: Partial<{ base: string; priority: string; rent: string; outstanding: number }> = {}) {
  await admin.installBudget({ id: "test-budget", network: config.network.identity, sponsorPublicKey: sponsor.publicKey.toBase58(), sponsorKeyVersion: "key-v1", base: "1000000", priority: "200000", rent: "300000000", outstanding: 100, ...limits });
}
async function count(table: string): Promise<number> { return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count); }

async function claimed() { await budget(); const p=await prepared(); await repo.claim(p.claim); return {...p,id:p.claim.sponsorFinalizationId}; }
async function revokeSession() { const a=(await identities.findAccount(accountId))!; return identities.revokeAccountSession({sessionId,accountId,expectedAccountVersion:a.version}); }
async function expiryRecord(id:string) { return (await pool.query("SELECT * FROM economic_expiry_records WHERE finalization_id=$1",[id])).rows[0]; }
async function assertReleasedOnce(id:string) {
  const op=(await repo.find(id))!; assert.equal(op.signerState,"EXPIRED_NEVER_CONTACTED"); assert.equal(op.exposureState,"RELEASED"); assert.equal(op.version,"1");
  const row=await expiryRecord(id); assert.equal(row.base_released,op.requested.base);assert.equal(row.priority_released,op.requested.priority);assert.equal(row.rent_released,op.requested.rent);
  assert.equal((await pool.query("SELECT count(*) FROM economic_authority_events WHERE finalization_id=$1 AND event_type='EXPIRED_NEVER_CONTACTED'",[id])).rows[0].count,"1");
  assert.equal((await pool.query("SELECT count(*) FROM economic_signer_contact_authority WHERE finalization_id=$1",[id])).rows[0].count,"0");
}
async function revision() { return (await pool.query("SELECT revision FROM economic_budget_heads WHERE family_id='test-budget'")).rows[0].revision; }
async function revise(newBudgetId="test-budget-v2",limits:Partial<{base:string;priority:string;rent:string;outstanding:number}>={}) {
  await admin.reviseBudget({familyId:"test-budget",expectedRevision:await revision(),newBudgetId,base:"1000000",priority:"200000",rent:"300000000",outstanding:100,...limits});
}
async function waiting(client:PoolClient) {
  const pid=(client as any).processID;
  for(let i=0;i<200;i++) {
    if((await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type==="Lock") return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error("Expected independent connection to wait on authority lock");
}
async function failEvent(type:string,action:()=>Promise<unknown>) {
  await pool.query(`CREATE FUNCTION authority_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${type}' THEN RAISE EXCEPTION 'injected authority crash'; END IF; RETURN NEW; END; $$;
    CREATE CONSTRAINT TRIGGER authority_test_fault AFTER INSERT ON economic_authority_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION authority_test_fault()`);
  try { await assert.rejects(action,/injected authority crash/); }
  finally { await pool.query("DROP TRIGGER authority_test_fault ON economic_authority_events; DROP FUNCTION authority_test_fault()"); }
}

test("restricted role flow creates only initial authority, returns signed result via signer writer and accounts via observer evidence",async()=>{
  const p=await claimed(); const op=await repo.recover(p.id);assert.equal(op.signerState,"RESULT_AVAILABLE");assert.equal(signer.calls,1);
  const observer:TrustedExposureObserver={async observe(o){return {state:"FINALIZED",finalizationId:o.sponsorFinalizationId,transactionId:o.finalTransactionId!,network:o.tuple.network,reference:"fixture:finalized",base:"8000",priority:"0",rent:"1000"};}};
  const r=new PostgresFinalizationRepository(appPool,policy,signer,observer,authorities);
  const result=await r.settleExposure(p.id);assert.equal(result.exposureState,"CONSUMED");assert.deepEqual(await r.settleExposure(p.id),result);
  assert.equal(await count("economic_effect_evidence"),1);await assert.rejects(()=>repo.expireNeverContacted(p.id),/cannot be reclaimed/);
});

test("live valid NOT_CONTACTED operation is not reclaimable",async()=>{const p=await claimed();await assert.rejects(()=>repo.expireNeverContacted(p.id),/not authoritatively/);assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");});

for(const kind of ["consent","runtime","session","asset","network"] as const) test(`${kind} revocation permits only provably never-contacted expiry with retained references`,async()=>{
  const p=await claimed(),before=(await pool.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[p.claim.consentId])).rows[0];
  if(kind==="consent")await ingestion.revoke("consent",p.claim.consentId);
  else if(kind==="runtime")await ingestion.revoke("runtime",p.e.runtime.decisionId);
  else if(kind==="session")await revokeSession();
  else await admin.revoke(kind,kind==="asset"?"devnet-usdc-v1":config.network.id);
  await assert.rejects(()=>repo.recover(p.id));assert.equal(signer.calls,0);
  const first=await repo.expireNeverContacted(p.id,"expiry-test");await assertReleasedOnce(p.id);
  const history=await expiryRecord(p.id);assert(history.reasons.some((r:any)=>r.reason===`${kind.toUpperCase()}_REVOKED`));
  assert.equal(history.consent_id,p.claim.consentId);assert.equal(history.runtime_id,p.e.runtime.decisionId);assert.equal(history.account_session_id,sessionId);assert.equal(history.actor,"expiry-test");
  assert.deepEqual(await repo.expireNeverContacted(p.id),first);assert.deepEqual(await repo.recover(p.id),first);assert.equal(signer.queries,0);
  if(kind==="session")assert.deepEqual((await pool.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[p.claim.consentId])).rows[0],before);
});

test("expired intent releases capacity without cancellation or generation replacement",async()=>{
  await budget({outstanding:1});const e=envelope(v=>{v.expiresAt=new Date(Date.now()+2200).toISOString();v.runtime.validUntil=v.expiresAt;});const p=await prepared(e);await repo.claim(p.claim);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(e.expiresAt)-Date.now()+20)));
  await repo.expireNeverContacted(p.claim.sponsorFinalizationId);await assertReleasedOnce(p.claim.sponsorFinalizationId);
  assert((await expiryRecord(p.claim.sponsorFinalizationId)).reasons.some((r:any)=>r.reason==="INTENT_EXPIRED"));
  assert.equal(await repo.cancel(e.attempt.intentId,"1",e.attempt.fenceToken,principalId),"FINALIZATION_WON");
  const next=await prepared();assert.equal((await repo.claim(next.claim)).disposition,"CREATED");
});

test("revoked canonical session rejects new consent, claim and first contact without changing historical evidence",async()=>{
  await budget();const p=await prepared();await revokeSession();const original=(await pool.query("SELECT * FROM economic_consent_evidence")).rows;
  assert.equal((await confirm(p.digest)).status,400);await assert.rejects(()=>repo.claim(p.claim),/session/i);assert.deepEqual((await pool.query("SELECT * FROM economic_consent_evidence")).rows,original);
});

test("unmapped provider session cannot issue consent or be rebound to revive revoked authority",async()=>{
  const p=await prepared(envelope(),{consent:false,runtime:false});
  const unmapped=await new SignJWT({scope:"confirm:economic",sid:"missing-session"}).setProtectedHeader({alg:"RS256",typ:"JWT"}).setIssuer(issuer).setAudience(audience).setSubject("subject:alice").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
  assert.equal((await confirm(p.digest,unmapped)).status,400);await revokeSession();
  const a=(await identities.findAccount(accountId))!,other=randomUUID();await identities.createAccountSession({sessionId:other,accountId,expectedAccountVersion:a.version,expiresAt:new Date(Date.now()+7200_000).toISOString()});
  await assert.rejects(()=>new EconomicSessionAdministration(issuerPool).bind({issuer,providerSubject:"subject:alice",providerSessionReference:"session:test",accountSessionId:other}),/rebound/);
  assert.equal((await confirm(p.digest)).status,400);
});

test("session binding rejects another account's session",async()=>{
  const b=await identities.provisionExternalIdentity({accountId:randomUUID(),identityId:randomUUID(),issuer,subject:"subject:bob"});const id=randomUUID();
  await identities.createAccountSession({sessionId:id,accountId:b.account.accountId,expectedAccountVersion:b.account.version,expiresAt:new Date(Date.now()+7200_000).toISOString()});
  await assert.rejects(()=>new EconomicSessionAdministration(issuerPool).bind({issuer,providerSubject:"subject:alice",providerSessionReference:"cross-account",accountSessionId:id}),/Session is invalid/);
});

for(const kind of ["consent","runtime","session"] as const) test(`contacted uncertainty survives later ${kind} revocation and recovers by same signer ID`,async()=>{
  const p=await claimed();signer.loseResponse=true;const unknown=await repo.recover(p.id);assert.equal(unknown.signerState,"RESULT_UNKNOWN");
  if(kind==="session")await revokeSession();else await ingestion.revoke(kind,kind==="consent"?p.claim.consentId:p.e.runtime.decisionId);
  await assert.rejects(()=>repo.expireNeverContacted(p.id),/cannot be reclaimed/);assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");
  const known=await repo.recover(p.id);assert.equal(known.signerState,"RESULT_AVAILABLE");assert.equal(known.signerOperationId,unknown.signerOperationId);assert.equal(signer.calls,1);assert.equal(await count("economic_expiry_records"),0);
});

test("contradictory possible effect evidence blocks reclamation and first contact",async()=>{
  const p=await claimed();await observerPool.query("INSERT INTO economic_effect_evidence(evidence_id,finalization_id,kind,network,reference) VALUES($1,$2,'POSSIBLE_EFFECT',$3,$4)",[randomUUID(),p.id,p.e.amount.asset.network,"fixture:possible-submission"]);
  await assert.rejects(()=>repo.recover(p.id),/contradictory/);await ingestion.revoke("consent",p.claim.consentId);await assert.rejects(()=>repo.expireNeverContacted(p.id),/contradictory/);assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");
});

test("expired operations permanently reject effect evidence and lifecycle revival even by ordinary privileged writer",async()=>{
  const p=await claimed();await ingestion.revoke("consent",p.claim.consentId);await repo.expireNeverContacted(p.id);
  await assert.rejects(()=>observerPool.query("INSERT INTO economic_effect_evidence(evidence_id,finalization_id,kind,network,reference) VALUES($1,$2,'POSSIBLE_EFFECT',$3,'late')",[randomUUID(),p.id,p.e.amount.asset.network]),/terminal expiry/);
  await assert.rejects(()=>pool.query("UPDATE economic_finalizations SET signer_state='CONTACT_COMMITTED',exposure_state='UNCERTAIN',version=version+1 WHERE finalization_id=$1",[p.id]),/permanently terminal/);
  assert.equal((await appPool.query("SELECT economic_commit_signer_contact($1) AS granted",[p.id])).rows[0].granted,false);
});

test("race: expiry holds canonical authority before recovery; no finalize or query occurs",async()=>{
  const p=await claimed();await ingestion.revoke("consent",p.claim.consentId);const first=await appPool.connect(),second=await appPool.connect();
  try{await first.query("BEGIN");await first.query("SELECT economic_expire_never_contacted($1,'race-worker')",[p.id]);
    const competing=second.query("SELECT economic_commit_signer_contact($1) AS granted",[p.id]);await waiting(second);await first.query("COMMIT");assert.equal((await competing).rows[0].granted,false);
    assert.equal((await repo.recover(p.id)).signerState,"EXPIRED_NEVER_CONTACTED");await assertReleasedOnce(p.id);assert.equal(signer.calls+signer.queries,0);
  }finally{await first.query("ROLLBACK");first.release();second.release();}
});

test("race: committed contact defeats expiry despite subsequent revocation and absent signer result",async()=>{
  const p=await claimed();const first=await appPool.connect(),second=await appPool.connect();
  try{await first.query("BEGIN");assert.equal((await first.query("SELECT economic_commit_signer_contact($1) AS granted",[p.id])).rows[0].granted,true);
    const competing=second.query("SELECT economic_expire_never_contacted($1,'race-worker')",[p.id]).then(()=>false,()=>true);await waiting(second);await first.query("COMMIT");assert.equal(await competing,true);
    await ingestion.revoke("consent",p.claim.consentId);await assert.rejects(()=>repo.expireNeverContacted(p.id),/cannot be reclaimed/);
    assert.equal((await repo.recover(p.id)).signerState,"RESULT_UNKNOWN");assert.equal(signer.calls,0);assert.equal(signer.queries,1);assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");
  }finally{await first.query("ROLLBACK");first.release();second.release();}
});

test("race: expiry vs signer-result recovery retains signed authority and uncertainty",async()=>{
  const p=await claimed();signer.loseResponse=true;await repo.recover(p.id);await ingestion.revoke("runtime",p.e.runtime.decisionId);
  const r=await Promise.allSettled([repo.recover(p.id),repo.expireNeverContacted(p.id)]);assert.equal(r[0].status,"fulfilled");assert.equal(r[1].status,"rejected");assert.equal((await repo.find(p.id))?.signerState,"RESULT_AVAILABLE");assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");
});

for(const kind of ["consent","runtime","session"] as const) test(`race: expiry vs ${kind} revocation converges only after authoritative invalidation`,async()=>{
  const p=await claimed();const revoke=()=>kind==="session"?revokeSession():ingestion.revoke(kind,kind==="consent"?p.claim.consentId:p.e.runtime.decisionId);
  const outcomes=await Promise.allSettled([repo.expireNeverContacted(p.id),revoke()]);assert.equal(outcomes[1].status,"fulfilled");await repo.expireNeverContacted(p.id);await assertReleasedOnce(p.id);
});

test("race: expiry vs cancellation retains committed fence and one release",async()=>{
  const p=await claimed();await ingestion.revoke("consent",p.claim.consentId);
  const r=await Promise.all([repo.expireNeverContacted(p.id),repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId)]);assert.equal(r[1],"FINALIZATION_WON");await assertReleasedOnce(p.id);
});

test("race: double expiry workers release exactly once; audit and version remain stable on replay",async()=>{
  const p=await claimed();await ingestion.revoke("consent",p.claim.consentId);
  const r=await Promise.all(Array.from({length:8},()=>repo.expireNeverContacted(p.id)));for(const op of r)assert.deepEqual(op,r[0]);await assertReleasedOnce(p.id);
});

test("fault: before expiry commit rolls back terminal state, release and audit atomically",async()=>{
  const p=await claimed();await ingestion.revoke("consent",p.claim.consentId);
  await failEvent("EXPIRED_NEVER_CONTACTED",()=>repo.expireNeverContacted(p.id));assert.equal((await repo.find(p.id))?.signerState,"NOT_CONTACTED");assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");assert.equal(await count("economic_expiry_records"),0);
  await repo.expireNeverContacted(p.id);await assertReleasedOnce(p.id);
});

for(const label of ["terminal/release commit before response","released response lost before caller receives it"]) test(`fault: ${label} retries without new release or audit`,async()=>{
  const p=await claimed();await revokeSession();await assert.rejects(async()=>{await repo.expireNeverContacted(p.id);throw new Error("lost response");},/lost response/);
  const before=await expiryRecord(p.id);await repo.expireNeverContacted(p.id);await assertReleasedOnce(p.id);assert.deepEqual(await expiryRecord(p.id),before);
});

test("budget disablement freezes new reservations and preserves existing contacted or uncontacted authority",async()=>{
  const p=await claimed();await admin.setBudgetStatus("test-budget",await revision(),"DISABLED");const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/disabled/);
  assert.equal((await repo.find(p.id))?.budgetId,"test-budget");assert.equal((await repo.recover(p.id)).signerState,"RESULT_AVAILABLE");await assert.rejects(()=>repo.expireNeverContacted(p.id));
  assert.equal((await pool.query("SELECT status FROM economic_budget_heads")).rows[0].status,"DISABLED");
});

test("budget versions retain historical attribution and sum existing exposure across versions",async()=>{
  const p=await claimed();await revise("test-budget-v2",{outstanding:1});const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/budget exhausted/);
  assert.equal((await repo.find(p.id))?.budgetVersion,"1");await ingestion.revoke("consent",p.claim.consentId);await repo.expireNeverContacted(p.id);
  const op=(await repo.claim(q.claim)).operation;assert.equal(op.budgetId,"test-budget-v2");assert.equal(op.budgetVersion,"2");assert.equal(await count("economic_sponsor_budgets"),2);
});

test("lowered limits do not prevent older operations recovering; disabled version changes never silently reactivate",async()=>{
  const p=await claimed();await admin.setBudgetStatus("test-budget",await revision(),"DISABLED");await revise("test-budget-v2",{base:"1",priority:"1",rent:"1"});
  assert.equal((await repo.recover(p.id)).signerState,"RESULT_AVAILABLE");assert.equal((await repo.find(p.id))?.budgetVersion,"1");assert.equal((await pool.query("SELECT status FROM economic_budget_heads")).rows[0].status,"DISABLED");
  await admin.setBudgetStatus("test-budget",await revision(),"ACTIVE");const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/budget exhausted/);
});

test("consumed costs remain charged across budget version changes",async()=>{
  const p=await claimed();await repo.recover(p.id);
  const observer:TrustedExposureObserver={async observe(op){return{state:"FINALIZED",finalizationId:op.sponsorFinalizationId,transactionId:op.finalTransactionId!,network:op.tuple.network,reference:"fixture:cost",base:"8000",priority:"0",rent:"0"};}};
  await new PostgresFinalizationRepository(appPool,policy,signer,observer,authorities).settleExposure(p.id);
  await revise("test-budget-v2",{base:"15000"});const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/budget exhausted/);
});

for(const kind of ["disable","version"] as const) test(`race: budget ${kind} vs new reservation serializes on family head`,async()=>{
  await budget();const p=await prepared();const results=await Promise.allSettled([repo.claim(p.claim),kind==="disable"?admin.setBudgetStatus("test-budget","1","DISABLED"):revise()]);
  assert.equal(results[1].status,"fulfilled");const op=await repo.find(p.claim.sponsorFinalizationId);
  if(op) {assert.equal(op.exposureState,"RESERVED");assert.equal(op.budgetVersion,op.budgetId==="test-budget"?"1":"2");}
  if(kind==="disable") {const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/disabled/);}
  else assert(op);
});

for(const kind of ["disable","version"] as const) test(`fault: budget ${kind} rollback and stale retry cannot erase exposure or partially update head`,async()=>{
  const p=await claimed();const event=kind==="disable"?"BUDGET_DISABLED":"BUDGET_VERSION_CREATED";
  const action=()=>kind==="disable"?admin.setBudgetStatus("test-budget","1","DISABLED"):admin.reviseBudget({familyId:"test-budget",expectedRevision:"1",newBudgetId:"test-budget-v2",base:"1",priority:"1",rent:"1",outstanding:1});
  await failEvent(event,action);assert.equal(await revision(),"1");assert.equal(await count("economic_sponsor_budgets"),1);assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");
  await action();await assert.rejects(action,/Stale/);assert.equal(await revision(),"2");assert.equal((await repo.find(p.id))?.budgetVersion,"1");
});

test("fault: session eligibility waits for canonical revocation transaction and fails after commit",async()=>{
  const p=await claimed(),first=await pool.connect(),second=await appPool.connect();
  const revocationPool=new Pool({connectionString:url,max:1});
  const revocationPid=Number((await revocationPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  try{await first.query("BEGIN");await first.query("SELECT * FROM accounts WHERE account_id=$1 FOR UPDATE",[accountId]);
    const a=(await identities.findAccount(accountId))!;
    const revoke=new PostgresIdentityPersistence(revocationPool).revokeAccountSession({sessionId,accountId,expectedAccountVersion:a.version});
    await waiting({processID:revocationPid} as unknown as PoolClient);
    const check=second.query("SELECT economic_commit_signer_contact($1)",[p.id]).then(()=>false,()=>true);
    await waiting(second);await first.query("COMMIT");await revoke;assert.equal(await check,true);assert.equal((await repo.find(p.id))?.signerState,"NOT_CONTACTED");await repo.expireNeverContacted(p.id);await assertReleasedOnce(p.id);
  }finally{await first.query("ROLLBACK");first.release();second.release();await revocationPool.end();}
});

test("fault: aborted session revocation check leaves authority unchanged and can retry",async()=>{
  const p=await claimed(),first=await pool.connect(),second=await appPool.connect();
  try{await first.query("BEGIN");await first.query("SELECT * FROM accounts WHERE account_id=$1 FOR UPDATE",[accountId]);
    await second.query("SET lock_timeout='100ms'");await assert.rejects(()=>second.query("SELECT economic_commit_signer_contact($1)",[p.id]),/lock timeout/);await first.query("ROLLBACK");
    assert.equal((await repo.find(p.id))?.signerState,"NOT_CONTACTED");assert.equal(await count("economic_signer_contact_authority"),0);assert.equal((await repo.recover(p.id)).signerState,"RESULT_AVAILABLE");
  }finally{await first.query("ROLLBACK");await second.query("RESET lock_timeout");first.release();second.release();}
});

test("application cannot manufacture terminal INSERTs, signer contact, observer evidence, expiry records or accounting",async()=>{
  const p=await claimed();const denied=[
    ["INSERT INTO economic_finalizations(finalization_id,signer_state) VALUES($1,'RESULT_AVAILABLE')",[randomUUID()]],
    ["UPDATE economic_finalizations SET signer_state='RESULT_AVAILABLE' WHERE finalization_id=$1",[p.id]],
    ["UPDATE economic_finalizations SET exposure_state='RELEASED' WHERE finalization_id=$1",[p.id]],
    ["INSERT INTO economic_signer_contact_authority(finalization_id,signer_operation_id,tuple_digest,origin) VALUES($1,$2,'fake','CONTACT_COMMIT')",[p.id,randomUUID()]],
    ["INSERT INTO economic_expiry_records(finalization_id) VALUES($1)",[p.id]],
    ["INSERT INTO economic_effect_evidence(evidence_id,finalization_id,kind,network,reference) VALUES($1,$2,'POSSIBLE_EFFECT','{}','fake')",[randomUUID(),p.id]],
    ["UPDATE economic_consent_evidence SET revoked_at=clock_timestamp() WHERE consent_id=$1",[p.claim.consentId]],
    ["UPDATE account_sessions SET revoked_at=clock_timestamp() WHERE session_id=$1",[sessionId]],
    ["SELECT economic_lock_operation($1)",[p.id]],
    ["SELECT economic_locked_invalidation_reasons($1)",[p.id]],
  ] as [string,unknown[]][];
  for(const [sql,args] of denied)await assert.rejects(()=>appPool.query(sql,args),/permission denied/);
  await assert.rejects(()=>appPool.query("SELECT economic_apply_finalized_accounting($1,$2)",[p.id,randomUUID()]),/trusted finalized evidence/);
});

test("even privileged ordinary INSERT cannot introduce terminal-shaped state",async()=>{
  await assert.rejects(()=>pool.query("INSERT INTO economic_finalizations(finalization_id,signer_state) VALUES($1,'REFUSED')",[randomUUID()]),/INSERT cannot manufacture/);
});

test("restricted roles cannot escalate, alter schema/triggers, truncate or mutate immutable lock columns",async()=>{
  const p=await claimed();
  for(const db of [appPool,issuerPool,signerPool,observerPool,readerPool]) {
    for(const sql of ["SET ROLE zephipay_economic_admin","ALTER TABLE economic_finalizations DISABLE TRIGGER ALL","TRUNCATE economic_finalizations CASCADE","CREATE TABLE public.authority_spoof(x integer)"])
      await assert.rejects(()=>db.query(sql));
  }
  for(const sql of ["UPDATE economic_finalizations SET finalization_id=finalization_id","UPDATE economic_sponsor_budgets SET budget_id=budget_id","UPDATE economic_budget_heads SET family_id=family_id","UPDATE accounts SET account_id=account_id","UPDATE account_sessions SET session_id=session_id"])
    await assert.rejects(()=>appPool.query(sql));
  assert.equal((await repo.find(p.id))?.signerState,"NOT_CONTACTED");
});

test("signer, observer, issuer and support role grants are separated",async()=>{
  const p=await claimed();
  for(const db of [signerPool,observerPool,issuerPool,readerPool])await assert.rejects(()=>db.query("SELECT economic_commit_signer_contact($1)",[p.id]),/permission denied/);
  await assert.rejects(()=>observerPool.query("UPDATE economic_finalizations SET signer_state='REFUSED' WHERE finalization_id=$1",[p.id]),/permission denied/);
  await assert.rejects(()=>signerPool.query("UPDATE economic_finalizations SET base_consumed=0 WHERE finalization_id=$1",[p.id]),/permission denied/);
  await assert.rejects(()=>signerPool.query("INSERT INTO economic_effect_evidence(evidence_id) VALUES($1)",[randomUUID()]),/permission denied/);
  await assert.rejects(()=>readerPool.query("SELECT customer_artifact FROM economic_finalizations"),/permission denied/);
  await assert.rejects(()=>observerPool.query("SELECT * FROM economic_consent_evidence"),/permission denied/);
  await assert.rejects(()=>readerPool.query("INSERT INTO economic_authority_events(event_type,actor) VALUES('FAKE','support')"),/permission denied/);
  assert.equal((await readerPool.query("SELECT count(*) FROM economic_exposure_projection")).rows[0].count,"1");
});

test("observer cannot create finalized accounting without a verified signed transaction",async()=>{
  const p=await claimed();await assert.rejects(()=>observerPool.query(`INSERT INTO economic_effect_evidence(evidence_id,finalization_id,kind,network,transaction_id,reference,base_consumed,priority_consumed,rent_consumed) VALUES($1,$2,'FINALIZED_ACCOUNTING',$3,'fake','fake',0,0,0)`,[randomUUID(),p.id,p.e.amount.asset.network]),/exact signed result/);
});

test("pinned function search path ignores attacker-owned temporary authority tables",async()=>{
  const p=await claimed(),client=await appPool.connect();await ingestion.revoke("consent",p.claim.consentId);
  try{await client.query("CREATE TEMP TABLE economic_finalizations(finalization_id uuid); CREATE TEMP TABLE economic_consent_evidence(consent_id uuid); SET search_path=pg_temp,public");
    await assert.rejects(()=>client.query("SELECT public.economic_commit_signer_contact($1)",[p.id]),/expired or revoked/);
    await client.query("SELECT public.economic_expire_never_contacted($1,'shadow-test')",[p.id]);await assertReleasedOnce(p.id);
  }finally{await client.query("DROP TABLE pg_temp.economic_finalizations; DROP TABLE pg_temp.economic_consent_evidence; RESET search_path");client.release();}
});

test("expiry history cannot be deleted, rewritten or duplicated",async()=>{
  const p=await claimed();await revokeSession();await repo.expireNeverContacted(p.id);
  for(const sql of ["UPDATE economic_expiry_records SET actor='changed' WHERE finalization_id=$1","DELETE FROM economic_expiry_records WHERE finalization_id=$1"])
    await assert.rejects(()=>pool.query(sql,[p.id]),/append.only/i);
  await assertReleasedOnce(p.id);
});

test("verified sponsor-signed callback is contradictory evidence even when claim rejects it",async()=>{
  const p=await claimed();const tx=Transaction.from(p.claim.customerArtifact);tx.partialSign(sponsor);
  await assert.rejects(()=>repo.claim({...p.claim,customerArtifact:tx.serialize()}),/customer-only/);
  assert.equal((await pool.query("SELECT validation FROM economic_callback_evidence")).rows[0].validation,"SPONSOR_RESULT_PRESENT");
  await assert.rejects(()=>repo.recover(p.id),/contradictory/);await ingestion.revoke("consent",p.claim.consentId);await assert.rejects(()=>repo.expireNeverContacted(p.id),/contradictory/);assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");
});

test("known invalid callback artifacts do not masquerade as signer authority",async()=>{
  const p=await claimed();await assert.rejects(()=>repo.claim({...p.claim,customerArtifact:Buffer.alloc(100)}));
  assert.equal((await pool.query("SELECT validation FROM economic_callback_evidence")).rows[0].validation,"INVALID_ARTIFACT");
  await ingestion.revoke("consent",p.claim.consentId);await repo.expireNeverContacted(p.id);await assertReleasedOnce(p.id);
});

test("legacy unclassified rejected callbacks retain uncertainty and block reclamation",async()=>{
  const p=await claimed();await pool.query("INSERT INTO economic_callback_evidence(evidence_id,intent_id,generation,artifact_digest,artifact,validation) VALUES($1,$2,'1',$3,$4,'REJECTED')",[randomUUID(),p.e.attempt.intentId,sha256(p.claim.customerArtifact),p.claim.customerArtifact]);
  await ingestion.revoke("consent",p.claim.consentId);await assert.rejects(()=>repo.expireNeverContacted(p.id),/contradictory/);
});

test("valid sponsor slot with missing customer signature remains uncertain after SDK rejection",async()=>{
  const p=await claimed();const tx=Transaction.from(p.claim.customerArtifact);tx.partialSign(sponsor);tx.signatures[1].signature=null;
  await assert.rejects(()=>repo.claim({...p.claim,customerArtifact:tx.serialize({requireAllSignatures:false})}),/Sponsor signature/);
  assert.equal((await pool.query("SELECT validation FROM economic_callback_evidence")).rows[0].validation,"REJECTED");await ingestion.revoke("consent",p.claim.consentId);await assert.rejects(()=>repo.expireNeverContacted(p.id),/contradictory/);
});
