import assert from "node:assert/strict";
import { assertPostgresBeforeExpiry, postgresDeadline, waitForPostgresPast } from "./helpers/postgresClock";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { createTrustedAuthorityComposition, AuthorityConnections } from "../src/economic/composition/trustedAuthorityComposition";
import { verifyAuthorityLogin } from "../src/economic/composition/verifyAuthorityLogin";
import { DurableSyntheticSigner,DurableSyntheticObserver,SyntheticRuntimeIssuer,installSyntheticStore } from "./helpers/syntheticAuthorityAdapters";
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
function loginPool(role: string): Pool { return new Pool({...parse(url!),user:`composition_fixture_${role}`,password:"disposable-economic-fixture-only",max:8} as PoolConfig); }
const appPool=loginPool("app"),issuerPool=loginPool("issuer"),signerPool=loginPool("signer"),observerPool=loginPool("observer"),readerPool=loginPool("reader");
const authorities={signerResults:signerPool,observerEvidence:observerPool};
const identityPool=loginPool("identity");
const identities = new PostgresIdentityPersistence(identityPool), admin = new TrustedRegistryAdministration(pool);
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json", "utf8"));
const user = Keypair.fromSeed(new Uint8Array(32).fill(1)), sponsor = Keypair.fromSeed(new Uint8Array(32).fill(2));
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); // Disposable authentication test keys only.
const issuer = "https://economic-auth.example/", audience = "https://economic-api.example/";
const policy: EvidencePolicy = { auth: { issuer, audience, requiredScope: "confirm:economic", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }, runtimeIssuer: "runtime:test-authority", policyVersions: ["policy-v1"], context: "production" };
const config = devnetUsdcConfiguration(fixture.qualifiedAsset.network.genesisHash, "2026-01-01T00:00:00.000Z");
let principalId: string, accountId: string, sessionId: string, baseUrl: string, token: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

let composition: Awaited<ReturnType<typeof createTrustedAuthorityComposition>>;
const connections:AuthorityConnections={app:appPool,issuer:issuerPool,signer:signerPool,observer:observerPool,reader:readerPool};
async function make(options:{runtime?:SyntheticRuntimeIssuer;signer?:DurableSyntheticSigner;observerPlan?:string;connections?:AuthorityConnections}={}) {
  return createTrustedAuthorityComposition({mode:"synthetic-internal",connections:options.connections??connections,identities,policy,
    runtime:options.runtime??new SyntheticRuntimeIssuer(policy.runtimeIssuer),signer:options.signer??new DurableSyntheticSigner(signerPool),
    observer:new DurableSyntheticObserver(observerPool,options.observerPlan),expectedSignerSource:"synthetic-signer-v1",expectedObserverSource:"synthetic-observer-v1"});
}
let repo: PostgresFinalizationRepository;
before(async () => {
  for(const role of roleNames) {
    const name=`composition_fixture_${role}`,group=`zephipay_economic_${role}`;
    assert.equal((await pool.query("SELECT count(*) FROM pg_roles WHERE rolname=$1",[group])).rows[0].count,"1","Explicit db:economic:roles setup is mandatory");
    if(!(await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[name])).rowCount)
      await pool.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'disposable-economic-fixture-only'`);
    await pool.query(`GRANT ${group} TO ${name}`);
  }
  for(const [index,db] of [appPool,issuerPool,signerPool,observerPool,readerPool].entries()) {
    const r=(await db.query("SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(r.current_user,`composition_fixture_${roleNames[index]}`);assert.equal(r.session_user,r.current_user);
    for(const key of ["rolsuper","rolcreatedb","rolcreaterole","rolbypassrls"]) assert.equal(r[key],false);
    assert.equal((await db.query("SELECT pg_has_role(current_user,'zephipay_economic_admin','MEMBER') AS member")).rows[0].member,false);
  }
  assert.equal((await pool.query("SELECT count(*) FROM payment_schema_migrations WHERE version='023_trusted_economic_finalization.sql'")).rows[0].count,"1");
  if(!(await pool.query("SELECT 1 FROM pg_roles WHERE rolname='composition_fixture_identity'")).rowCount)await pool.query("CREATE ROLE composition_fixture_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'disposable-economic-fixture-only'");
  await pool.query(`GRANT USAGE ON SCHEMA public TO composition_fixture_identity;
    GRANT SELECT,INSERT ON accounts,external_identities,account_sessions,account_security_events TO composition_fixture_identity;
    GRANT UPDATE(status,version,updated_at) ON accounts TO composition_fixture_identity;
    GRANT UPDATE(revoked_at) ON account_sessions TO composition_fixture_identity;
    GRANT USAGE ON SEQUENCE account_security_events_event_id_seq TO composition_fixture_identity`);
  await installSyntheticStore(pool);
  const app = express();
  // No permissive JSON parser before the unmounted factory router.
  app.use("/test-consent",(req,res,next)=>composition.consentRouter(req,res,next));
  server = app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening",resolve));
  const address = server.address(); assert(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}/test-consent`;
});
beforeEach(async () => {
  await pool.query("TRUNCATE economic_synthetic.signer_plans,economic_synthetic.signer_operations,economic_synthetic.observer_plans");
  await pool.query("TRUNCATE economic_authority_events,economic_network_registry,economic_sponsor_budgets,accounts RESTART IDENTITY CASCADE");
  const provisioned = await identities.provisionExternalIdentity({ accountId: randomUUID(), identityId: randomUUID(), issuer, subject: "subject:alice", occurredAt:new Date(Date.now()-60_000).toISOString() });
  accountId = provisioned.account.accountId; principalId = provisioned.account.actorSubject;
  sessionId = randomUUID();
  await identities.createAccountSession({sessionId,accountId,expectedAccountVersion:provisioned.account.version,createdAt:new Date(Date.now()-30_000).toISOString(),expiresAt:new Date(Date.now()+7200_000).toISOString()});
  composition=await make();
  await composition.sessions.bindExisting({principal:{issuer,providerSubject:"subject:alice",providerSessionId:"session:test"},accountSessionId:sessionId,assertedTokenIssuedAt:new Date(Date.now()-2000).toISOString()});
  token=await jwt();repo=new PostgresFinalizationRepository(appPool,policy);
  await admin.install(config);
});
after(async () => { if (server) await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); await Promise.all([appPool,issuerPool,signerPool,observerPool,readerPool,identityPool,pool].map(db=>db.end())); });

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
  const digest = await composition.prepare(e,fixture.recentBlockhash);
  let consentId = randomUUID();
  if (options.consent) { const res = await confirm(digest); assert.equal(res.status,201,await res.clone().text()); consentId = (await res.json() as any).consentId; }
  if (options.runtime) await composition.issueRuntime(digest);
  return { e, digest, claim: { sponsorFinalizationId: randomUUID(), envelopeDigest: digest, consentId, customerArtifact: artifact(e) } };
}
async function budget(limits: Partial<{ base: string; priority: string; rent: string; outstanding: number }> = {}) {
  await admin.installBudget({ id: "test-budget", network: config.network.identity, sponsorPublicKey: sponsor.publicKey.toBase58(), sponsorKeyVersion: "key-v1", base: "1000000", priority: "200000", rent: "300000000", outstanding: 100, ...limits });
}
async function count(table: string): Promise<number> { return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count); }

async function claimed(e=envelope()) { await budget();const p=await prepared(e);await composition.claim(p.claim);return {...p,id:p.claim.sponsorFinalizationId}; }
async function signerPlan(id:string,mode:"SIGNED"|"UNKNOWN"|"REFUSED"="SIGNED",lose=false) {
  const op=(await repo.find(id))!;const row=(await pool.query("SELECT customer_artifact FROM economic_finalizations WHERE finalization_id=$1",[id])).rows[0];
  const tx=Transaction.from(row.customer_artifact);tx.partialSign(sponsor); // Dummy fixture keys; adapter receives bytes only.
  const reply={signerOperationId:op.signerOperationId,tupleDigest:op.tupleDigest,network:op.tuple.network,sponsorKeyVersion:op.tuple.sponsorKeyVersion,state:mode,
    ...(mode==="SIGNED"?{artifact:tx.serialize().toString("base64")}:mode==="REFUSED"?{reference:`fixture-refusal:${op.signerOperationId}`}:{})};
  await pool.query("INSERT INTO economic_synthetic.signer_plans(operation_id,tuple_digest,customer_digest,reply,lose_response) VALUES($1,$2,$3,$4,$5)",[op.signerOperationId,op.tupleDigest,sha256(row.customer_artifact),reply,lose]);
  return reply;
}
async function observerPlan(id:string,changes:Record<string,unknown>={}) {
  const op=(await repo.find(id))!,planId=randomUUID();
  const report={sourceId:"synthetic-observer-v1",reference:`fixture:${planId}`,finalizationId:id,network:op.tuple.network,state:"FINALIZED",transactionId:op.finalTransactionId,
    outcome:"settled",base:"8000",priority:"0",rent:"1000",...changes};
  await pool.query("INSERT INTO economic_synthetic.observer_plans(plan_id,finalization_id,report) VALUES($1,$2,$3)",[planId,id,report]);return {planId,report};
}
async function signed() {const p=await claimed();await signerPlan(p.id);await composition.recover(p.id);return p;}
async function revokeSession() {const a=(await identities.findAccount(accountId))!;return composition.sessions.revoke({sessionId,accountId,expectedAccountVersion:a.version});}
async function lost(action:()=>Promise<unknown>) {await assert.rejects(async()=>{await action();throw new Error("synthetic caller response loss");},/synthetic caller response loss/);}
function failingPool(real:Pool,match:RegExp):Pool {
  let fired=false;
  return new Proxy(real,{get(target,key){if(key==="connect")return async()=>{const client=await real.connect();return new Proxy(client,{get(c,k){if(k==="query")return (...args:any[])=>{if(!fired&&match.test(String(args[0]))){fired=true;return Promise.reject(new Error("synthetic persistence crash"));}return (c.query as any)(...args);};const value=(c as any)[k];return typeof value==="function"?value.bind(c):value;}});};const value=(target as any)[key];return typeof value==="function"?value.bind(target):value;}});
}

test("full restricted composition reconstructs session, consent, Runtime, contact, signer, observer and accounting",async()=>{
  const p=await signed();let trace=await composition.trace(p.id);assert.equal(trace.state.exposure_state,"UNCERTAIN");assert.equal(trace.state.account_session_id,sessionId);assert.equal(trace.state.contact_committed,true);
  assert.equal((await composition.observe(p.id)).disposition,"PENDING");assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");
  const plan=await observerPlan(p.id);const worker=await make({observerPlan:plan.planId});assert.equal((await worker.observe(p.id)).disposition,"FINALIZED");
  trace=await worker.trace(p.id);assert.equal(trace.state.exposure_state,"CONSUMED");assert.equal(trace.state.base_consumed,"8000");assert.equal(trace.state.manual_review_required,false);assert.equal(trace.state.consent_id,p.claim.consentId);assert.equal(trace.state.runtime_id,p.e.runtime.decisionId);
  for(const event of ["ATTEMPT_REQUESTED","CONSENT_ACCEPTED","RUNTIME_ACCEPTED","FINALIZATION_COMMITTED","SIGNER_CONTACT_COMMITTED","SIGNER_RESULT_VERIFIED","OBSERVER_REPORT_RECORDED","EXPOSURE_CONSUMED"])assert(trace.events.some((e:any)=>e.event_type===event),event);
  assert.equal(trace.reports.length,2);assert(!JSON.stringify(trace).includes(token));assert.equal(await count("economic_synthetic.signer_operations"),1);
});

test("actual identity-service credential creates and revokes canonical sessions with account-version security events",async()=>{
  const current=(await identities.findAccount(accountId))!,other=randomUUID();const created=await composition.sessions.create({sessionId:other,accountId,expectedAccountVersion:current.version,expiresAt:new Date(Date.now()+3600_000).toISOString()});
  assert.equal(created.account.version,current.version+1n);await composition.sessions.revoke({sessionId:other,accountId,expectedAccountVersion:created.account.version});
  const events=await identities.listAccountSecurityEvents(accountId);assert(events.some(e=>e.sessionId===other&&e.eventType==="SESSION_CREATED"));assert(events.some(e=>e.sessionId===other&&e.eventType==="SESSION_REVOKED"));
  await assert.rejects(()=>identityPool.query("SELECT economic_commit_signer_contact($1)",[randomUUID()]),/permission denied/);
});

test("session created after issuer-asserted token issuance cannot bind or create consent",async()=>{
  await assert.rejects(()=>composition.sessions.bindExisting({principal:{issuer,providerSubject:"subject:alice",providerSessionId:"session:test"},accountSessionId:sessionId,assertedTokenIssuedAt:new Date(Date.now()-120_000).toISOString()}),/predates/);
  const p=await prepared(envelope(),{consent:false,runtime:false});const now=Math.floor(Date.now()/1000);
  const old=await new SignJWT({scope:"confirm:economic",sid:"session:test"}).setProtectedHeader({alg:"RS256",typ:"JWT"}).setIssuer(issuer).setAudience(audience).setSubject("subject:alice").setIssuedAt(now-120).setExpirationTime(now+3600).sign(keys.privateKey);
  assert.equal((await confirm(p.digest,old)).status,400);assert.equal(await count("economic_consent_evidence"),0);
});

for(const kind of ["missing","wrong-account","wrong-provider"] as const)test(`canonical session binding rejects ${kind}`,async()=>{
  const other=await identities.provisionExternalIdentity({accountId:randomUUID(),identityId:randomUUID(),issuer,subject:"subject:bob"});const id=randomUUID();
  if(kind!=="missing")await identities.createAccountSession({sessionId:id,accountId:other.account.accountId,expectedAccountVersion:other.account.version,expiresAt:new Date(Date.now()+3600_000).toISOString()});
  await assert.rejects(()=>composition.sessions.bindExisting({principal:{issuer,providerSubject:kind==="wrong-provider"?"unknown:subject":"subject:alice",providerSessionId:"other:session"},accountSessionId:id,assertedTokenIssuedAt:new Date().toISOString()}),/mismatch/);
});

test("revoked session denies consent and claim; historical consent remains unchanged",async()=>{
  await budget();const p=await prepared();const original=(await pool.query("SELECT * FROM economic_consent_evidence")).rows;
  await revokeSession();assert.equal((await confirm(p.digest)).status,400);await assert.rejects(()=>composition.claim(p.claim),/session/i);assert.deepEqual((await pool.query("SELECT * FROM economic_consent_evidence")).rows,original);
});

test("expired canonical session rejects binding and future consent",async()=>{
  const a=(await identities.findAccount(accountId))!,id=randomUUID();
  await composition.sessions.create({sessionId:id,accountId,expectedAccountVersion:a.version,createdAt:new Date(Date.now()-20000).toISOString(),expiresAt:new Date(Date.now()-10000).toISOString()});
  await assert.rejects(()=>composition.sessions.bindExisting({principal:{issuer,providerSubject:"subject:alice",providerSessionId:"expired-session"},accountSessionId:id,assertedTokenIssuedAt:new Date().toISOString()}),/expired/);
});

for(const [name,transform] of [
  ["rejected",(v:any)=>{v.binding.result="denied";return v;}],
  ["wrong issuer",(v:any)=>{v.issuer="untrusted-runtime";return v;}],
  ["envelope mismatch",(v:any)=>{v.binding.envelopeDigest="ab".repeat(32);return v;}],
  ["wrong network",(v:any)=>{v.network={...v.network,environment:"mainnet"};return v;}],
  ["wrong scope",(v:any)=>{v.binding.reference={...v.binding.reference,scope:"devnet-test-only"};return v;}],
  ["malformed",()=>'{"binding":'],
  ["duplicate members",()=>'{"issuer":"one","issuer":"two"}'],
] as const)test(`synthetic trusted Runtime rejects ${name} evidence`,async()=>{
  const p=await prepared(envelope(),{consent:true,runtime:false});const worker=await make({runtime:new SyntheticRuntimeIssuer(policy.runtimeIssuer,transform)});
  await assert.rejects(()=>worker.issueRuntime(p.digest));assert.equal(await count("economic_runtime_evidence"),0);
});

test("composition cannot silently swap configured Runtime producer identity",async()=>{
  await assert.rejects(()=>make({runtime:new SyntheticRuntimeIssuer("another-source")}),/source identity/);
});

test("client-shaped consent, missing evidence, wrong principal and wrong envelope cannot claim",async()=>{
  await budget();const p=await prepared();await assert.rejects(()=>composition.claim({...p.claim,consentId:randomUUID(),consent:{approved:true}} as any),/consent/);
  const q=await prepared();await assert.rejects(()=>composition.claim({...p.claim,envelopeDigest:q.digest}));
  const wrong=await jwt({subject:"unrelated:principal"});assert.notEqual((await confirm(p.digest,wrong)).status,201);assert.equal(await count("economic_finalizations"),0);
});

for(const kind of ["session","runtime"] as const)test(`revoked ${kind} after claim prevents contact and permits authoritative expiry`,async()=>{
  const p=await claimed();await signerPlan(p.id);if(kind==="session")await revokeSession();else await composition.revokeEvidence("runtime",p.e.runtime.decisionId);
  await assert.rejects(()=>composition.recover(p.id));assert.equal(await count("economic_synthetic.signer_operations"),0);
  assert.equal((await composition.runExpiryBatch()).expired.length,1);assert.equal((await repo.find(p.id))?.signerState,"EXPIRED_NEVER_CONTACTED");assert.equal((await composition.recover(p.id)).signerState,"EXPIRED_NEVER_CONTACTED");
});

test("expired intent and Runtime evidence deny contact; expiry selection remains advisory",async t=>{
  await budget();const deadline=await postgresDeadline(pool);
  const preparedIntent=await prepared(envelope(e=>{e.expiresAt=deadline;e.runtime.validUntil=e.expiresAt;}));
  const consent=(await pool.query("SELECT confirmed_at::text FROM economic_consent_evidence WHERE consent_id=$1",[preparedIntent.claim.consentId])).rows[0];
  t.diagnostic(JSON.stringify(await waitForPostgresPast(pool,consent.confirmed_at)));
  await assertPostgresBeforeExpiry(pool,deadline);await composition.claim(preparedIntent.claim);
  const p={...preparedIntent,id:preparedIntent.claim.sponsorFinalizationId};await signerPlan(p.id);
  t.diagnostic(JSON.stringify(await waitForPostgresPast(pool,p.e.expiresAt)));
  await assert.rejects(()=>composition.recover(p.id));assert.equal((await composition.runExpiryBatch()).expired.length,1);assert.equal((await composition.runExpiryBatch()).selected,0);
});

test("disabled/versioned budget blocks new reservations while old reserved operations recover and account",async()=>{
  const p=await claimed();await signerPlan(p.id);await admin.setBudgetStatus("test-budget","1","DISABLED");
  await admin.reviseBudget({familyId:"test-budget",expectedRevision:"2",newBudgetId:"test-v2",base:"1",priority:"1",rent:"1",outstanding:1});
  const q=await prepared();await assert.rejects(()=>composition.claim(q.claim),/disabled/);await composition.recover(p.id);assert.equal((await repo.find(p.id))?.budgetVersion,"1");
  const plan=await observerPlan(p.id);await (await make({observerPlan:plan.planId})).observe(p.id);assert.equal((await repo.find(p.id))?.exposureState,"CONSUMED");
});

for(const mode of ["SIGNED","UNKNOWN","REFUSED"] as const)test(`durable synthetic signer ${mode} persists exact same-operation lookup across instances`,async t=>{
  const p=await claimed();await signerPlan(p.id,mode);const first=await composition.recover(p.id);
  if(mode==="UNKNOWN") {
    const previous=(await pool.query("SELECT updated_at::text FROM economic_finalizations WHERE finalization_id=$1",[p.id])).rows[0];
    t.diagnostic(JSON.stringify(await waitForPostgresPast(pool,previous.updated_at)));
  }
  const second=await (await make()).recover(p.id);
  assert.equal(first.signerOperationId,second.signerOperationId);assert.equal(await count("economic_synthetic.signer_operations"),1);
  assert.equal(second.signerState,mode==="SIGNED"?"RESULT_AVAILABLE":mode==="UNKNOWN"?"RESULT_UNKNOWN":"REFUSED");
  assert.equal(second.exposureState,mode==="REFUSED"?"RELEASED":"UNCERTAIN");
});

test("race: lost signer response and duplicate recovery callers converge without replacement operations",async()=>{
  const p=await claimed();await signerPlan(p.id,"SIGNED",true);assert.equal((await composition.recover(p.id)).signerState,"RESULT_UNKNOWN");
  const workers=await Promise.all([make(),make(),make()]);await Promise.all(workers.map(w=>w.recover(p.id)));
  assert.equal((await repo.find(p.id))?.signerState,"RESULT_AVAILABLE");assert.equal(await count("economic_signer_contact_authority"),1);assert.equal(await count("economic_synthetic.signer_operations"),1);
});

test("conflicting signer callback retains evidence and freezes further exposure release/accounting",async()=>{
  const p=await claimed();await signerPlan(p.id);const broken=await make({signer:new DurableSyntheticSigner(signerPool,true)});await assert.rejects(()=>broken.recover(p.id),/conflict/);
  let trace=await composition.trace(p.id);assert.equal(trace.state.manual_review_required,true);assert.equal(trace.state.exposure_state,"UNCERTAIN");assert.equal(trace.incidents.length,1);assert.equal(trace.signerReports.length,1);assert.equal(trace.signerReports[0].report.tupleDigest.excerpt,"ef".repeat(32));
  await composition.recover(p.id);assert.equal((await repo.find(p.id))?.signerState,"RESULT_AVAILABLE");const plan=await observerPlan(p.id);const worker=await make({observerPlan:plan.planId});assert.equal((await worker.observe(p.id)).disposition,"INCIDENT");
  trace=await composition.trace(p.id);assert.equal(trace.state.exposure_state,"UNCERTAIN");
});

for(const outcome of ["settled","failed-onchain"] as const)test(`finalized authoritative ${outcome} records actual exposure without conflating signing with settlement`,async()=>{
  const p=await signed();const plan=await observerPlan(p.id,{outcome});const worker=await make({observerPlan:plan.planId});await worker.observe(p.id);
  const trace=await worker.trace(p.id);assert.equal(trace.reports[0].outcome,outcome);assert.equal(trace.state.base_consumed,"8000");assert.equal(trace.state.exposure_state,"CONSUMED");
});

for(const change of [{transactionId:"wrong-transaction"},{network:{family:"solana",environment:"mainnet",genesisHash:"wrong"}},{sourceId:"untrusted-observer"},{finalizationId:randomUUID()},{state:"garbage"}])test(`observer contradiction ${Object.keys(change)[0]} is retained and grants no accounting`,async()=>{
  const p=await signed();const plan=await observerPlan(p.id,change);const worker=await make({observerPlan:plan.planId});assert.equal((await worker.observe(p.id)).disposition,"INCIDENT");
  const trace=await worker.trace(p.id);assert.equal(trace.incidents.length,1);assert.equal(trace.reports.length,1);assert.equal(trace.state.exposure_state,"UNCERTAIN");
});

test("race: duplicate observer evidence across instances creates one effect and one accounting event",async()=>{
  const p=await signed(),plan=await observerPlan(p.id);const workers=await Promise.all(Array.from({length:4},()=>make({observerPlan:plan.planId})));
  const results=await Promise.all(workers.map(w=>w.observe(p.id)));assert.equal(new Set(results.map(r=>r.report_id)).size,1);
  const trace=await composition.trace(p.id);assert.equal(trace.reports.length,1);assert.equal(trace.events.filter((e:any)=>e.event_type==="EXPOSURE_CONSUMED").length,1);assert.equal(await count("economic_effect_evidence"),1);
});

test("contradictory finalized outcomes preserve both reports and previous accounting; no additional release",async()=>{
  const p=await signed(),one=await observerPlan(p.id);await (await make({observerPlan:one.planId})).observe(p.id);const before=await repo.find(p.id);
  const two=await observerPlan(p.id,{outcome:"failed-onchain"});assert.equal((await (await make({observerPlan:two.planId})).observe(p.id)).disposition,"INCIDENT");
  const trace=await composition.trace(p.id);assert.equal(trace.reports.length,2);assert.equal(trace.state.manual_review_required,true);assert.deepEqual(await repo.find(p.id),before);
});

test("possible effect before contact and late evidence after expiry become incidents without revival or release",async()=>{
  const p=await claimed(),one=await observerPlan(p.id,{state:"POSSIBLE_EFFECT",transactionId:"unexpected"});await (await make({observerPlan:one.planId})).observe(p.id);
  await composition.revokeEvidence("consent",p.claim.consentId);await assert.rejects(()=>composition.expire(p.id),/frozen/);assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");
  const q=await prepared();await composition.claim(q.claim);await composition.revokeEvidence("consent",q.claim.consentId);await composition.expire(q.claim.sponsorFinalizationId);
  const two=await observerPlan(q.claim.sponsorFinalizationId,{state:"POSSIBLE_EFFECT",transactionId:"late"});await (await make({observerPlan:two.planId})).observe(q.claim.sponsorFinalizationId);
  const trace=await composition.trace(q.claim.sponsorFinalizationId);assert.equal(trace.state.signer_state,"EXPIRED_NEVER_CONTACTED");assert.equal(trace.state.manual_review_required,true);assert.equal(trace.expiry.base_released,trace.state.base_requested);
});

test("race: duplicate expiry workers converge and restarted scheduler never treats selection as authority",async()=>{
  const p=await claimed();await composition.revokeEvidence("consent",p.claim.consentId);const workers=await Promise.all([make(),make()]);await Promise.all(workers.map(w=>w.runExpiryBatch(10)));
  assert.equal(await count("economic_expiry_records"),1);assert.equal((await (await make()).runExpiryBatch()).selected,0);assert.equal((await repo.find(p.id))?.version,"1");
  await assert.rejects(()=>composition.runExpiryBatch(101),/between 1 and 100/);
});

test("race: canonical session revocation vs first contact preserves either committed uncertainty or never-contacted expiry",async()=>{
  const p=await claimed();await signerPlan(p.id);await Promise.allSettled([composition.recover(p.id),revokeSession()]);const op=(await repo.find(p.id))!;
  if(op.signerState==="NOT_CONTACTED"){await composition.runExpiryBatch();assert.equal((await repo.find(p.id))?.signerState,"EXPIRED_NEVER_CONTACTED");}
  else {assert.equal(op.exposureState,"UNCERTAIN");await assert.rejects(()=>composition.expire(p.id),/cannot be reclaimed/);}
});

for(const [kind,grant,revoke,target] of [
  ["forbidden table write","GRANT UPDATE(exposure_state) ON economic_finalizations TO composition_fixture_app","REVOKE UPDATE(exposure_state) ON economic_finalizations FROM composition_fixture_app","app"],
  ["forbidden function execute","GRANT EXECUTE ON FUNCTION economic_lock_operation(uuid) TO composition_fixture_reader","REVOKE EXECUTE ON FUNCTION economic_lock_operation(uuid) FROM composition_fixture_reader","reader"],
  ["PUBLIC function leakage","GRANT EXECUTE ON FUNCTION economic_commit_signer_contact(uuid) TO PUBLIC","REVOKE EXECUTE ON FUNCTION economic_commit_signer_contact(uuid) FROM PUBLIC","app"],
  ["PUBLIC column leakage","GRANT INSERT(finalization_id) ON economic_finalizations TO PUBLIC","REVOKE INSERT(finalization_id) ON economic_finalizations FROM PUBLIC","app"],
  ["missing required grant","REVOKE EXECUTE ON FUNCTION economic_commit_signer_contact(uuid) FROM zephipay_economic_app","GRANT EXECUTE ON FUNCTION economic_commit_signer_contact(uuid) TO zephipay_economic_app","app"],
] as const)test(`ACL readiness rejects ${kind} without fallback`,async()=>{
  await pool.query(grant);try{await assert.rejects(()=>verifyAuthorityLogin(connections[target],target,{syntheticFixtures:true}),/ACL readiness failed/);await assert.rejects(()=>make(),/ACL readiness failed/);}finally{await pool.query(revoke);}
  await composition.readiness();
});

test("ACL readiness rejects unexpected inherited role and schema ownership",async()=>{
  await pool.query("CREATE ROLE composition_acl_extra NOLOGIN; GRANT composition_acl_extra TO composition_fixture_app");
  try{await assert.rejects(()=>composition.readiness(),/inherited role/);}finally{await pool.query("REVOKE composition_acl_extra FROM composition_fixture_app; DROP ROLE composition_acl_extra");}
  await pool.query("CREATE SCHEMA composition_acl_owned AUTHORIZATION composition_fixture_app");
  try{await assert.rejects(()=>composition.readiness(),/schema ownership/);}finally{await pool.query("DROP SCHEMA composition_acl_owned");}
});

test("ACL drift after construction stops first contact and consent readiness",async()=>{
  const p=await claimed();await signerPlan(p.id);await pool.query("GRANT UPDATE(exposure_state) ON economic_finalizations TO composition_fixture_app");
  try{await assert.rejects(()=>composition.recover(p.id),/ACL readiness failed/);assert.equal((await confirm(p.digest)).status,503);assert.equal(await count("economic_signer_contact_authority"),0);}
  finally{await pool.query("REVOKE UPDATE(exposure_state) ON economic_finalizations FROM composition_fixture_app");}
  assert.equal((await composition.recover(p.id)).signerState,"RESULT_AVAILABLE");
});

test("superuser and role-sharing composition is rejected at startup",async()=>{
  await assert.rejects(()=>make({connections:{...connections,app:pool}}),/ACL readiness failed/);
  await assert.rejects(()=>make({connections:{...connections,signer:appPool}}),/ACL readiness failed/);
});

test("wrong credentials cannot create consent, Runtime evidence, reservation, contact, signer result, observer evidence, accounting or expiry",async()=>{
  const p=await claimed();const checks:[Pool,string,unknown[]][]=[
    [observerPool,"INSERT INTO economic_consent_evidence(consent_id) VALUES($1)",[randomUUID()]],
    [appPool,"INSERT INTO economic_runtime_evidence(decision_id) VALUES('forged')",[]],
    [issuerPool,"INSERT INTO economic_finalizations(finalization_id) VALUES($1)",[randomUUID()]],
    [readerPool,"SELECT economic_commit_signer_contact($1)",[p.id]],
    [appPool,"UPDATE economic_finalizations SET signer_state='REFUSED' WHERE finalization_id=$1",[p.id]],
    [signerPool,"SELECT economic_ingest_observation($1,'forged','{}')",[p.id]],
    [observerPool,"SELECT economic_apply_finalized_accounting($1,$2)",[p.id,randomUUID()]],
    [readerPool,"SELECT economic_expire_never_contacted($1,'forged')",[p.id]],
    [issuerPool,"SELECT economic_record_incident($1,'forged','forged')",[p.id]],
    [appPool,"INSERT INTO economic_observer_reports(report_id) VALUES($1)",[randomUUID()]],
    [observerPool,"INSERT INTO economic_signer_contact_authority(finalization_id) VALUES($1)",[p.id]],
  ];
  for(const [db,sql,args]of checks)await assert.rejects(()=>db.query(sql,args),/permission denied/);
  const wrong=new PostgresFinalizationRepository(readerPool,policy);await assert.rejects(()=>wrong.claim(p.claim),/permission denied/);
  assert.equal((await repo.find(p.id))?.signerState,"NOT_CONTACTED");assert.equal(await count("economic_authority_incidents"),0);
});

test("race: conflicting wrong-role actions cannot mutate an authorized recovery",async()=>{
  const p=await claimed();await signerPlan(p.id);const results=await Promise.allSettled([composition.recover(p.id),appPool.query("UPDATE economic_finalizations SET result_artifact='bad' WHERE finalization_id=$1",[p.id]),observerPool.query("SELECT economic_commit_signer_contact($1)",[p.id])]);
  assert.equal(results[0].status,"fulfilled");assert.equal(results[1].status,"rejected");assert.equal(results[2].status,"rejected");assert.equal((await repo.find(p.id))?.signerState,"RESULT_AVAILABLE");
});

test("fault after consent write reconfirms safely without creating extra reservations",async()=>{
  await budget();const p=await prepared(envelope(),{consent:false,runtime:false});await lost(async()=>{const r=await confirm(p.digest);assert.equal(r.status,201);});
  composition=await make();const response=await confirm(p.digest);p.claim.consentId=(await response.json() as any).consentId;
  await composition.issueRuntime(p.digest);await composition.claim(p.claim);assert.equal(await count("economic_consent_evidence"),2);assert.equal(await count("economic_finalizations"),1);
});

test("fault after Runtime evidence write reuses immutable decision on restart",async()=>{
  await budget();const p=await prepared(envelope(),{consent:true,runtime:false});await lost(()=>composition.issueRuntime(p.digest));
  const restarted=await make();await restarted.issueRuntime(p.digest);await restarted.claim(p.claim);assert.equal(await count("economic_runtime_evidence"),1);
});

test("fault after claim converges on original canonical finalization and reservation",async()=>{
  await budget();const p=await prepared();await lost(()=>composition.claim(p.claim));const replay=await (await make()).claim(p.claim);assert.equal(replay.disposition,"REPLAY");assert.equal(await count("economic_finalizations"),1);
});

test("fault after contact commitment queries the same unseen operation and retains uncertainty",async()=>{
  const p=await claimed();await signerPlan(p.id);await lost(()=>appPool.query("SELECT economic_commit_signer_contact($1)",[p.id]));
  const result=await (await make()).recover(p.id);assert.equal(result.signerState,"RESULT_UNKNOWN");assert.equal(result.exposureState,"UNCERTAIN");assert.equal(await count("economic_synthetic.signer_operations"),0);await assert.rejects(()=>composition.expire(p.id),/cannot be reclaimed/);
});

test("fault after signer returns before result persistence recovers durable signer truth without a false incident",async()=>{
  const p=await claimed();await signerPlan(p.id);const broken=await make({connections:{...connections,signer:failingPool(signerPool,/UPDATE economic_finalizations SET signer_state='RESULT_AVAILABLE'/)}});
  await assert.rejects(()=>broken.recover(p.id),/synthetic persistence crash/);assert.equal((await repo.find(p.id))?.signerState,"RESULT_UNKNOWN");assert.equal(await count("economic_authority_incidents"),0);
  assert.equal((await (await make()).recover(p.id)).signerState,"RESULT_AVAILABLE");assert.equal(await count("economic_synthetic.signer_operations"),1);
});

test("fault after signer result persistence returns identical result after restart",async()=>{
  const p=await claimed();await signerPlan(p.id);await lost(()=>composition.recover(p.id));const before=await repo.find(p.id);assert.deepEqual(await (await make()).recover(p.id),before);
});

test("fault after observer effect write retries accounting using the same immutable effect",async()=>{
  const p=await signed(),plan=await observerPlan(p.id);const broken=await make({observerPlan:plan.planId,connections:{...connections,app:failingPool(appPool,/SELECT economic_apply_finalized_accounting/)}});
  await assert.rejects(()=>broken.observe(p.id),/synthetic persistence crash/);assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");assert.equal(await count("economic_effect_evidence"),1);
  await (await make({observerPlan:plan.planId})).observe(p.id);assert.equal((await repo.find(p.id))?.exposureState,"CONSUMED");assert.equal(await count("economic_effect_evidence"),1);
});

test("fault after finalized accounting cannot duplicate realized charge or release",async()=>{
  const p=await signed(),plan=await observerPlan(p.id),worker=await make({observerPlan:plan.planId});await lost(()=>worker.observe(p.id));const before=await repo.find(p.id);
  await (await make({observerPlan:plan.planId})).observe(p.id);assert.deepEqual(await repo.find(p.id),before);const trace=await composition.trace(p.id);assert.equal(trace.events.filter((e:any)=>e.event_type==="EXPOSURE_CONSUMED").length,1);
});

test("fault during expiry-worker action rolls back and restart retries accepted expiry transaction",async()=>{
  const p=await claimed();await composition.revokeEvidence("consent",p.claim.consentId);const broken=await make({connections:{...connections,app:failingPool(appPool,/SELECT economic_expire_never_contacted/)}});
  await assert.rejects(()=>broken.runExpiryBatch(),/synthetic persistence crash/);assert.equal((await repo.find(p.id))?.exposureState,"RESERVED");assert.equal(await count("economic_expiry_records"),0);
  await lost(()=>composition.runExpiryBatch());assert.equal((await (await make()).runExpiryBatch()).selected,0);assert.equal(await count("economic_expiry_records"),1);
});

test("race: expiry vs first contact cannot authorize signer execution after terminal release",async()=>{
  const p=await claimed();await signerPlan(p.id);await composition.revokeEvidence("runtime",p.e.runtime.decisionId);const workers=await Promise.all([make(),make()]);
  await Promise.allSettled([workers[0].recover(p.id),workers[1].runExpiryBatch()]);await composition.runExpiryBatch();assert.equal((await repo.find(p.id))?.signerState,"EXPIRED_NEVER_CONTACTED");assert.equal(await count("economic_synthetic.signer_operations"),0);
});

test("PA-01 query planner uses the bounded finalization/event-type index on representative history",async()=>{
  const p=await claimed(),client=await pool.connect();try{await client.query("BEGIN");await client.query(`INSERT INTO economic_authority_events(event_type,actor,finalization_id) SELECT 'TEST_HISTORY','planner-fixture',gen_random_uuid() FROM generate_series(1,20000)`);
    await client.query("ANALYZE economic_authority_events");const result=(await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT 1 FROM economic_authority_events WHERE finalization_id=$1 AND event_type IN ('SIGNER_CONTACT_COMMITTED','SIGNER_RESULT_UNKNOWN','SIGNER_RESULT_VERIFIED','SIGNER_REFUSED_EXPOSURE_RELEASED','EXPOSURE_CONSUMED')`,[p.id])).rows[0]["QUERY PLAN"];
    assert(JSON.stringify(result).includes("economic_authority_events_finalization_type_idx"));
  }finally{await client.query("ROLLBACK");client.release();}
});

test("possible effect remains distinct from finalized accounting",async()=>{
  const p=await signed(),possible=await observerPlan(p.id,{state:"POSSIBLE_EFFECT"});const one=await make({observerPlan:possible.planId});assert.equal((await one.observe(p.id)).disposition,"POSSIBLE_EFFECT");assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");
  const finalized=await observerPlan(p.id);await (await make({observerPlan:finalized.planId})).observe(p.id);const trace=await composition.trace(p.id);assert.equal(trace.reports.length,2);assert.equal(trace.state.exposure_state,"CONSUMED");
});

test("previous possible-effect transaction contradiction cannot be normalized by a later matching final report",async()=>{
  const p=await claimed();await signerPlan(p.id,"SIGNED",true);await composition.recover(p.id);
  const possible=await observerPlan(p.id,{state:"POSSIBLE_EFFECT",transactionId:"unexpected-prior-transaction"});await (await make({observerPlan:possible.planId})).observe(p.id);
  await composition.recover(p.id);const finalized=await observerPlan(p.id);assert.equal((await (await make({observerPlan:finalized.planId})).observe(p.id)).disposition,"INCIDENT");assert.equal((await repo.find(p.id))?.exposureState,"UNCERTAIN");
});

test("late signed callback after terminal expiry is retained as incident evidence without revival",async()=>{
  const p=await claimed();await composition.revokeEvidence("consent",p.claim.consentId);await composition.expire(p.id);
  const tx=Transaction.from(p.claim.customerArtifact);tx.partialSign(sponsor);await assert.rejects(()=>composition.claim({...p.claim,customerArtifact:tx.serialize()}),/customer-only/);
  const trace=await composition.trace(p.id);assert.equal(trace.state.signer_state,"EXPIRED_NEVER_CONTACTED");assert.equal(trace.state.manual_review_required,true);assert.equal(await count("economic_callback_evidence"),1);assert.equal(await count("economic_expiry_records"),1);
});


test("session chronology compares instants consistently across timezone offsets",async()=>{
  const bind=(time:string)=>composition.sessions.bindExisting({principal:{issuer,providerSubject:"subject:alice",providerSessionId:"session:test"},accountSessionId:sessionId,assertedTokenIssuedAt:time});
  await bind(new Date(Date.now()-6*3600_000).toISOString().replace("Z","-06:00"));
  await assert.rejects(()=>bind(new Date(Date.now()-120_000+6*3600_000).toISOString().replace("Z","+06:00")),/predates/);
});

test("ACL verifier rejects same-named sequence grants in an unrelated schema",async()=>{
  await pool.query("CREATE SCHEMA composition_acl_sequence; CREATE SEQUENCE composition_acl_sequence.economic_authority_events_event_id_seq; GRANT USAGE ON SCHEMA composition_acl_sequence TO composition_fixture_app; GRANT USAGE ON SEQUENCE composition_acl_sequence.economic_authority_events_event_id_seq TO composition_fixture_app");
  try{await assert.rejects(()=>composition.readiness(),/sequence authority mismatch/);}
  finally{await pool.query("DROP SEQUENCE composition_acl_sequence.economic_authority_events_event_id_seq; DROP SCHEMA composition_acl_sequence");}
});

test("stale attempt cannot claim or contact through composition after a canonical replacement",async()=>{
  await budget();const old=await prepared();await repo.cancel(old.e.attempt.intentId,"1",old.e.attempt.fenceToken,principalId);
  const next=await prepared(envelope(e=>{e.attempt.intentId=old.e.attempt.intentId;e.attempt.generation="2";e.attempt.intentVersion="2";}));
  await assert.rejects(()=>composition.claim(old.claim),/Stale|cancelled/);await composition.claim(next.claim);
  await assert.rejects(()=>composition.recover(old.claim.sponsorFinalizationId),/Unknown finalization/);
  assert.equal(await count("economic_finalizations"),1);assert.equal(await count("economic_signer_contact_authority"),0);
});

test("conflicting finalization identity cannot gain another reservation or contact authority",async()=>{
  const p=await claimed();const q=await prepared();
  await assert.rejects(()=>composition.claim({...q.claim,sponsorFinalizationId:p.id}),/conflict/);
  assert.equal(await count("economic_finalizations"),1);assert.equal(await count("economic_signer_contact_authority"),0);
  await signerPlan(p.id);assert.equal((await composition.recover(p.id)).signerState,"RESULT_AVAILABLE");
});

test("heavily escaped malformed signer reply still retains a bounded incident",async()=>{
  const p=await claimed();const real=new DurableSyntheticSigner(signerPool);
  const bad={kind:"synthetic" as const,sourceId:real.sourceId,finalize:async()=>({signerOperationId:"\u0001".repeat(512),tupleDigest:"\u0002".repeat(512),network:"\u0003".repeat(512),sponsorKeyVersion:"\u0004".repeat(512),state:"\u0005".repeat(512),reference:"\u0006".repeat(512)} as any),query:real.query.bind(real)};
  await assert.rejects(()=>(make({signer:bad}).then(c=>c.recover(p.id))),/conflict/);
  const trace=await composition.trace(p.id);assert.equal(trace.incidents.length,1);assert.equal(trace.signerReports.length,1);assert.equal(trace.state.exposure_state,"UNCERTAIN");
});


for(const kind of ["session","runtime"] as const)test(`expired ${kind} rejects consent-to-claim composition without reserving exposure`,async t=>{
  await budget();let deadline:number;let p:Awaited<ReturnType<typeof prepared>>;
  if(kind==="runtime") {
    deadline=Date.now()+4000;p=await prepared(envelope(e=>{e.runtime.validUntil=new Date(deadline).toISOString();e.expiresAt=e.runtime.validUntil;}));
  } else {
    const account=(await identities.findAccount(accountId))!,shortId=randomUUID();deadline=Date.now()+4000;
    await composition.sessions.create({sessionId:shortId,accountId,expectedAccountVersion:account.version,createdAt:new Date(Date.now()-3000).toISOString(),expiresAt:new Date(deadline).toISOString()});
    await composition.sessions.bindExisting({principal:{issuer,providerSubject:"subject:alice",providerSessionId:"short-session"},accountSessionId:shortId,assertedTokenIssuedAt:new Date(Date.now()-1000).toISOString()});
    p=await prepared(envelope(),{consent:false,runtime:true});const now=Math.floor(Date.now()/1000);
    const bearer=await new SignJWT({scope:"confirm:economic",sid:"short-session"}).setProtectedHeader({alg:"RS256",typ:"JWT"}).setIssuer(issuer).setAudience(audience).setSubject("subject:alice").setIssuedAt(now-1).setExpirationTime(now+3600).sign(keys.privateKey);
    const response=await confirm(p.digest,bearer);assert.equal(response.status,201);p.claim.consentId=(await response.json() as any).consentId;
  }
  t.diagnostic(JSON.stringify(await waitForPostgresPast(pool,new Date(deadline).toISOString())));
  await assert.rejects(()=>composition.claim(p.claim),/stale|expired|unauthenticated/i);assert.equal(await count("economic_finalizations"),0);assert.equal(await count("economic_signer_contact_authority"),0);
});


// No handler, validator, connection options or user mapping: catalog-only FDW fixtures cannot read external data.
async function withInertForeign(action:(relation:string)=>Promise<void>,options:{schema?:string;name?:string;empty?:boolean}={}) {
  const schema=options.schema??"public",name=options.name??"composition_acl_foreign",relation=`${schema}.${name}`;
  if(schema!=="public")await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE FOREIGN DATA WRAPPER composition_inert NO HANDLER NO VALIDATOR;
    CREATE SERVER composition_inert FOREIGN DATA WRAPPER composition_inert;
    CREATE FOREIGN TABLE ${relation} (${options.empty?"":"payload text"}) SERVER composition_inert`);
  try {
    const fdw=(await pool.query("SELECT fdwhandler,fdwvalidator,fdwoptions FROM pg_foreign_data_wrapper WHERE fdwname='composition_inert'")).rows[0];
    assert.equal(fdw.fdwhandler,0);assert.equal(fdw.fdwvalidator,0);assert.equal(fdw.fdwoptions,null);
    await composition.readiness(); // Mere inert existence with no operational/PUBLIC grants is not drift.
    await action(relation);
  } finally {
    await pool.query(`DROP FOREIGN TABLE ${relation}; DROP SERVER composition_inert; DROP FOREIGN DATA WRAPPER composition_inert`);
    if(schema!=="public")await pool.query(`DROP SCHEMA ${schema}`);
  }
  await composition.readiness();
}
async function checkLoginCommand(role:typeof roleNames[number],shouldPass:boolean) {
  const connection=new URL(url!);
  connection.searchParams.set("user",`composition_fixture_${role}`);
  connection.searchParams.set("password","disposable-economic-fixture-only");
  try {
    const result=await promisify(execFile)("npm",["run","db:economic:verify","--",role,"--synthetic-fixtures"],{
      env:{...process.env,DATABASE_URL:connection.toString()},timeout:20_000,maxBuffer:32768});
    assert.equal(shouldPass,true,"standalone checker accepted ACL drift");assert.match(result.stdout,/login readiness passed/);
  } catch(error:any) {
    if(shouldPass)throw error;
    assert.equal(error.code,1);assert.match(error.stderr,/Economic ACL readiness failed/);
  }
}
async function rejectsAclDrift(role:typeof roleNames[number],standalone=false) {
  await assert.rejects(()=>verifyAuthorityLogin(connections[role],role,{syntheticFixtures:true}),/ACL readiness failed/);
  await assert.rejects(()=>composition.readiness(),/ACL readiness failed/);
  await assert.rejects(()=>make(),/ACL readiness failed/);
  if(standalone)await checkLoginCommand(role,false);
}

for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])test(`AUD-TAC-01: foreign-table ${privilege} drift fails actual reader LOGIN and composition`,async()=>{
  await withInertForeign(async relation=>{
    await pool.query(`GRANT ${privilege} ON ${relation} TO composition_fixture_reader`);
    await rejectsAclDrift("reader",privilege==="SELECT"||privilege==="UPDATE");
    assert.equal((await readerPool.query("SELECT has_table_privilege(current_user,$1,$2) AS granted",[relation,privilege])).rows[0].granted,true,"readiness must not repair grants");
  });
});
for(const privilege of ["SELECT","INSERT","UPDATE","REFERENCES"])test(`AUD-TAC-01: foreign-table column ${privilege} is checked`,async()=>{
  await withInertForeign(async relation=>{await pool.query(`GRANT ${privilege}(payload) ON ${relation} TO composition_fixture_reader`);await rejectsAclDrift("reader");});
});
for(const role of roleNames)test(`AUD-TAC-01: foreign-table ownership by ${role} LOGIN fails readiness`,async()=>{
  await withInertForeign(async relation=>{await pool.query(`ALTER FOREIGN TABLE ${relation} OWNER TO composition_fixture_${role}`);await rejectsAclDrift(role,role==="reader");});
});
for(const privilege of ["SELECT","UPDATE"])test(`AUD-TAC-01: foreign-table PUBLIC ${privilege} fails verifier, CLI and composition`,async()=>{
  await withInertForeign(async relation=>{await pool.query(`GRANT ${privilege} ON ${relation} TO PUBLIC`);await rejectsAclDrift("reader",true);});
});
test("AUD-TAC-01: PUBLIC foreign-column write and inherited ownership cannot escape inventory",async()=>{
  await withInertForeign(async relation=>{
    await pool.query(`GRANT UPDATE(payload) ON ${relation} TO PUBLIC`);await rejectsAclDrift("reader");
    await pool.query(`REVOKE UPDATE(payload) ON ${relation} FROM PUBLIC; ALTER FOREIGN TABLE ${relation} OWNER TO zephipay_economic_reader`);
    await rejectsAclDrift("reader");
  });
});
test("AUD-TAC-01: same-name foreign relation in another user schema cannot borrow the public allowlist",async()=>{
  await withInertForeign(async relation=>{await pool.query(`GRANT SELECT ON ${relation} TO composition_fixture_reader`);await rejectsAclDrift("reader");},{schema:"pgscope",name:"economic_authority_trace"});
});
test("AUD-TAC-01: zero-column foreign tables retain PUBLIC and ownership checks",async()=>{
  await withInertForeign(async relation=>{
    await pool.query(`GRANT SELECT ON ${relation} TO PUBLIC`);await rejectsAclDrift("reader");
    await pool.query(`REVOKE SELECT ON ${relation} FROM PUBLIC; ALTER FOREIGN TABLE ${relation} OWNER TO composition_fixture_reader`);await rejectsAclDrift("reader");
  },{empty:true});
});

for(const [kind,definition] of [["TABLE","(payload text)"],["TABLE","(payload text) PARTITION BY LIST(payload)"],["VIEW","AS SELECT 'inert'::text AS payload"],["MATERIALIZED VIEW","AS SELECT 'inert'::text AS payload"]])test(`AUD-TAC-01 regression: ${kind} ${definition.includes("PARTITION")?"partitioned ":""}grant and ownership drift still fails`,async()=>{
  const relation="public.composition_acl_ordinary";await pool.query(`CREATE ${kind} ${relation} ${definition}`);
  try {
    await pool.query(`GRANT SELECT ON ${relation} TO composition_fixture_reader`);await rejectsAclDrift("reader");
    await pool.query(`REVOKE SELECT ON ${relation} FROM composition_fixture_reader; ALTER ${kind} ${relation} OWNER TO composition_fixture_reader`);await rejectsAclDrift("reader");
  } finally {await pool.query(`DROP ${kind} ${relation}`);}
  await composition.readiness();
});
test("AUD-TAC-01: standalone command passes all five unchanged restricted LOGINs",async()=>{
  for(const role of roleNames)await checkLoginCommand(role,true);
});

test("AUD-TAC-02: reader summary omits extra observer payload while forensic evidence stays intact",async()=>{
  const p=await signed();const extras={rawArtifact:"inert-artifact-canary",credentials:{token:"inert-credential-canary"},tokens:["inert-token-canary"],providerPayload:{nested:"inert-provider-canary"}};
  const plan=await observerPlan(p.id,extras),worker=await make({observerPlan:plan.planId});await worker.observe(p.id);
  const trace=await worker.trace(p.id),summary=trace.reports[0];
  assert.equal(summary.observation_state,"FINALIZED");assert.equal(summary.outcome,"settled");assert.equal(summary.base_consumed,"8000");
  assert.equal(summary.transaction_id,(await repo.find(p.id))?.finalTransactionId);assert.equal(summary.network_genesis_hash,plan.report.network.genesisHash);
  assert.deepEqual(Object.keys(summary).sort(),["report_id","finalization_id","report_digest","disposition","effect_evidence_id","database_actor","occurred_at","source_id","reference","observation_state","transaction_id","outcome","network_family","network_environment","network_genesis_hash","base_consumed","priority_consumed","rent_consumed"].sort());
  const forensic=(await observerPool.query("SELECT report FROM economic_observer_reports WHERE report_id=$1",[summary.report_id])).rows[0].report;
  assert.deepEqual(forensic,plan.report);assert.deepEqual((await pool.query("SELECT report FROM economic_observer_reports WHERE report_id=$1",[summary.report_id])).rows[0].report,forensic);
  assert(!JSON.stringify(trace).includes("-canary"));
  for(const db of [readerPool,appPool])await assert.rejects(()=>db.query("SELECT report FROM economic_observer_reports WHERE report_id=$1",[summary.report_id]),{code:"42501"});
  assert.equal(trace.state.exposure_state,"CONSUMED");
});
test("AUD-TAC-02: malformed nested or oversized allowed fields do not leak into reader projection",async()=>{
  const p=await signed();const plan=await observerPlan(p.id,{state:"UNKNOWN",transactionId:{rawArtifact:"nested-transaction-canary"},network:{family:{token:"nested-family-canary"},environment:"x".repeat(100),genesisHash:{token:"nested-network-canary"}},base:{token:"nested-cost-canary"}});
  const worker=await make({observerPlan:plan.planId});assert.equal((await worker.observe(p.id)).disposition,"INCIDENT");
  const trace=await worker.trace(p.id),summary=trace.reports[0];
  for(const field of ["transaction_id","network_family","network_environment","network_genesis_hash","base_consumed"])assert.equal(summary[field],null);
  assert(!JSON.stringify(trace).includes("-canary"));assert.equal((await observerPool.query("SELECT report FROM economic_observer_reports WHERE report_id=$1",[summary.report_id])).rows[0].report.transactionId.rawArtifact,"nested-transaction-canary");
});


test("AUD-TAC-01: quoted foreign-table name cannot impersonate an allowed synthetic-schema relation",async()=>{
  await withInertForeign(async relation=>{await pool.query(`GRANT SELECT ON ${relation} TO composition_fixture_signer`);await rejectsAclDrift("signer");},{name:'"economic_synthetic.signer_plans"'});
});
