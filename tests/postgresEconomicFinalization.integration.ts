import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { SignJWT } from "jose";
import { Pool } from "pg";
import { Keypair, Message, Transaction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { EconomicIntentEnvelopeV1, authorizationBindingDigestV1, createEconomicIntentEnvelopeV1, offlineSponsoredMessageV1 } from "zephyon-protocol";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresFinalizationRepository as BaseRepository } from "../src/economic/foundation/postgresFinalizationRepository";
import { createEconomicEvidenceIngestion, EvidencePolicy, TrustedRuntimeIssuer } from "../src/economic/foundation/evidenceIngestion";
import { SignerRequest, SignerResponse, TrustedExposureObserver, TrustedSignerPort } from "../src/economic/foundation/finalizationTypes";
import { TrustedRegistryAdministration, devnetUsdcConfiguration, qualifyAsset } from "../src/economic/foundation/trustedRegistry";
import { EconomicSessionAdministration } from "../src/economic/foundation/sessionAuthority";
import { sha256, transaction } from "../src/economic/foundation/database";

// Existing regression fixtures explicitly use the privileged disposable pool. Restricted LOGIN tests are separate.
class PostgresFinalizationRepository extends BaseRepository {
  constructor(db: Pool, configuration: EvidencePolicy, signer?: TrustedSignerPort, observer?: TrustedExposureObserver) {
    super(db,configuration,signer,observer,{signerResults:db,observerEvidence:db});
  }
}
const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL required; use a disposable database only.");
const pool = new Pool({ connectionString: url, max: 16 });
const identities = new PostgresIdentityPersistence(pool), admin = new TrustedRegistryAdministration(pool);
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json", "utf8"));
const user = Keypair.fromSeed(new Uint8Array(32).fill(1)), sponsor = Keypair.fromSeed(new Uint8Array(32).fill(2));
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); // Disposable authentication test keys only.
const issuer = "https://economic-auth.example/", audience = "https://economic-api.example/";
const policy: EvidencePolicy = { auth: { issuer, audience, requiredScope: "confirm:economic", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }, runtimeIssuer: "runtime:test-authority", policyVersions: ["policy-v1"], context: "production" };
const config = devnetUsdcConfiguration(fixture.qualifiedAsset.network.genesisHash, "2026-01-01T00:00:00.000Z");
let principalId: string, accountId: string, baseUrl: string, token: string;
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
const runtime = new RuntimeFixture(), ingestion = createEconomicEvidenceIngestion(pool,policy,runtime);

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
  const sessionId = randomUUID();
  await identities.createAccountSession({sessionId,accountId,expectedAccountVersion:provisioned.account.version,createdAt:new Date(Date.now()-30_000).toISOString(),expiresAt:new Date(Date.now()+7200_000).toISOString()});
  await new EconomicSessionAdministration(pool).bind({issuer,providerSubject:"subject:alice",providerSessionReference:"session:test",accountSessionId:sessionId});
  token = await jwt(); runtime.transform = value => value;
  signer = new SignerFixture(); repo = new PostgresFinalizationRepository(pool,policy,signer);
  await admin.install(config);
});
after(async () => { if (server) await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); await pool.end(); });

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

test("known configured Devnet USDC qualifies; unregistered identity, wrong genesis/program/decimals fail; ZERA absent",async () => {
  await transaction(pool,async client => assert.equal(await qualifyAsset(client,fixture.qualifiedAsset,"PAYMENT",new Date().toISOString()),"devnet-usdc-v1"));
  for (const mutate of [
    (a: any) => a.network.genesisHash = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58(),
    (a: any) => a.network.environment = "mainnet", (a: any) => a.tokenProgram = TOKEN_2022_PROGRAM_ID.toBase58(),
    (a: any) => a.decimals = 9, (a: any) => a.mint = sponsor.publicKey.toBase58(),
    (a: any) => a.registryStatus = "QUALIFIED",
  ]) { const a = copy(fixture.qualifiedAsset); mutate(a); await assert.rejects(() => transaction(pool,client => qualifyAsset(client,a,"PAYMENT",new Date().toISOString()))); }
  assert.equal(await count("economic_asset_registry"),2);
  assert.equal((await pool.query("SELECT count(*) FROM economic_asset_registry WHERE use_role='PAYMENT' AND identity->>'mint'<>$1",[fixture.qualifiedAsset.mint])).rows[0].count,"0");
});

test("network labels cannot alias one genesis; registry versions/effective times/revocation are authoritative",async () => {
  const alias = copy(config); alias.network.id = "fake-mainnet"; alias.network.identity.environment = "mainnet";
  await assert.rejects(() => admin.install(alias));
  await assert.rejects(() => admin.install({ ...config, network: { ...config.network, version: "2" } }));
  await admin.revoke("asset","devnet-usdc-v1");
  await assert.rejects(() => repo.registerAttempt(envelope(),fixture.recentBlockhash),/revoked/);
  await assert.rejects(() => pool.query("UPDATE economic_asset_registry SET revoked_at=NULL WHERE registry_id='devnet-usdc-v1'"));
});

test("JWT-authenticated confirmation creates durable subject/context/expiry evidence without storing the token",async () => {
  const p = await prepared();
  const row = (await pool.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[p.claim.consentId])).rows[0];
  assert.equal(row.principal_id,principalId); assert.equal(row.issuer,issuer); assert.equal(row.audience,audience);
  assert.equal(row.context,"zephipay-economic-consent-v1"); assert.equal(row.authentication_reference,sha256(token));
  assert.equal(row.session_reference,"session:test"); assert(row.expires_at > row.confirmed_at);
  assert(!JSON.stringify(row).includes(token));
});

test("forged consent, wrong JWT signature/issuer/audience/subject/scope/expiry and duplicate raw keys fail",async () => {
  const p = await prepared(envelope(),{ consent: false, runtime: false });
  const wrongKeys = generateKeyPairSync("rsa",{ modulusLength: 2048 });
  const tokens = ["not-a-token",await jwt({ key: wrongKeys.privateKey }),await jwt({ issuer: "https://wrong.example/" }),await jwt({ audience: "wrong" }),await jwt({ subject: "someone:else" }),await jwt({ scope: "read:account" }),await jwt({ expires: Math.floor(Date.now()/1000)-60 })];
  for (const bad of tokens) assert.notEqual((await confirm(p.digest,bad)).status,201);
  for (const raw of [JSON.stringify({ envelopeDigest: p.digest, principalId, approved: true }),`{"envelopeDigest":"${p.digest}","envelopeDigest":"${p.digest}"}`,`{"envelopeDigest":"${p.digest}","\\u0065nvelopeDigest":"${p.digest}"}`]) assert.equal((await confirm(p.digest,token,raw)).status,400);
  assert.equal(await count("economic_consent_evidence"),0);
});

test("already-parsed transport cannot bypass duplicate detection",async () => {
  const app = express(); app.use(express.json()); app.use(ingestion.consentRouter);
  const wrongServer = app.listen(0,"127.0.0.1"); await new Promise<void>(resolve => wrongServer.once("listening",resolve));
  try {
    const address = wrongServer.address(); assert(address && typeof address === "object");
    const res = await fetch(`http://127.0.0.1:${address.port}/`,{ method: "POST", headers: { Authorization: `Bearer ${token}`,"Content-Type":"application/json" },body:'{"envelopeDigest":"a","envelopeDigest":"b"}' });
    assert.equal(res.status,400);
  } finally { await new Promise<void>((resolve,reject) => wrongServer.close(error => error ? reject(error) : resolve())); }
});

test("missing server evidence rejects structurally valid forged approval and consent at finalization",async () => {
  await budget(); const p = await prepared(envelope(),{ consent:false,runtime:false });
  await assert.rejects(() => repo.claim({ ...p.claim, consent: { approved:true }, decision:{ result:"approved" } } as any),/consent/);
  const c = await confirm(p.digest); p.claim.consentId = (await c.json() as any).consentId;
  await assert.rejects(() => repo.claim(p.claim),/Runtime/);
  assert.equal(await count("economic_finalizations"),0);
});

test("trusted Runtime ingestion rejects wrong issuer, scope, network, envelope, policy, decision and duplicate members",async () => {
  const p = await prepared(envelope(),{ consent:true,runtime:false });
  const changes = [
    (v: any) => { v.issuer="forged";return v; }, (v: any) => { v.network.genesisHash=sponsor.publicKey.toBase58();return v; },
    (v: any) => { v.binding.envelopeDigest="ef".repeat(32);return v; },(v: any) => { v.binding.result="denied";return v; },
    (v: any) => { v.binding.reference.policyVersion="unknown";return v; },(v: any) => { v.binding.reference.decisionId=randomUUID();return v; },
    (v: any) => { v.binding.reference.scope="devnet-test-only";return v; },
    (v: any) => JSON.stringify(v).replace('"result":"approved"','"result":"denied","result":"approved"'),
  ];
  for (const change of changes) { runtime.transform=change; await assert.rejects(() => ingestion.issueRuntimeDecision(p.digest)); }
  assert.equal(await count("economic_runtime_evidence"),0);
});

test("test-scope Runtime decisions cannot satisfy production-like eligibility",async () => {
  await budget(); const p = await prepared(envelope(e => e.runtime.scope="devnet-test-only"),{ consent:true,runtime:false });
  await assert.rejects(() => ingestion.issueRuntimeDecision(p.digest),/Test-scope/);
  const testing = createEconomicEvidenceIngestion(pool,{ ...policy,context:"devnet-test" },runtime);
  await testing.issueRuntimeDecision(p.digest);
  await assert.rejects(() => repo.claim(p.claim),/Test-scope/);
});

test("revoked consent/Runtime/registry and inactive accounts fail before claim or signer contact",async () => {
  await budget(); const p = await prepared(); await ingestion.revoke("consent",p.claim.consentId);
  await assert.rejects(() => repo.claim(p.claim),/consent/);
  const q = await prepared(); await ingestion.revoke("runtime",q.e.runtime.decisionId);
  await assert.rejects(() => repo.claim(q.claim),/Runtime/);
  const r = await prepared(); await repo.claim(r.claim); await admin.revoke("network",config.network.id);
  await assert.rejects(() => repo.recover(r.claim.sponsorFinalizationId),/revoked/); assert.equal(signer.calls,0);
});

test("concurrent same-ID finalization has one creator, one reservation and identical canonical lookup results",async () => {
  await budget(); const p = await prepared();
  const results = await Promise.all(Array.from({length:8},() => repo.claim(p.claim)));
  assert.equal(results.filter(r => r.disposition==="CREATED").length,1); assert.equal(await count("economic_finalizations"),1);
  assert.deepEqual(await repo.find(p.claim.sponsorFinalizationId),await repo.findByGeneration(p.e.attempt.intentId,"1"));
  assert.equal((await repo.find(p.claim.sponsorFinalizationId))?.signerState,"NOT_CONTACTED"); assert.equal(signer.calls,0);
});

test("competing IDs for same intent/generation converge on one operation; altered consent conflicts",async () => {
  await budget(); const p = await prepared();
  const results = await Promise.all(Array.from({length:8},() => repo.claim({ ...p.claim,sponsorFinalizationId:randomUUID() })));
  assert.equal(results.filter(r => r.disposition==="CREATED").length,1);
  assert.equal(new Set(results.map(r => r.operation.sponsorFinalizationId)).size,1);
  const res = await confirm(p.digest), otherConsent=(await res.json() as any).consentId;
  await assert.rejects(() => repo.claim({...p.claim,consentId:otherConsent}),/conflict/);
});

test("same finalization ID on different intents cannot reserve twice, including a concurrent race",async () => {
  await budget(); const p = await prepared(), q = await prepared(); q.claim.sponsorFinalizationId=p.claim.sponsorFinalizationId;
  const results=await Promise.allSettled([repo.claim(p.claim),repo.claim(q.claim)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1); assert.equal(await count("economic_finalizations"),1);
});

test("A handoff lost, cancel(A), create(B), late-A callback is retained as evidence without reviving authority",async () => {
  await budget(); const a=await prepared();
  const b=envelope(e=>{ e.attempt.intentId=a.e.attempt.intentId;e.attempt.generation="2";e.attempt.intentVersion="2"; });
  await assert.rejects(()=>repo.registerAttempt(b,fixture.recentBlockhash),/cancellation/);
  assert.equal(await repo.cancel(a.e.attempt.intentId,"1",a.e.attempt.fenceToken,principalId),"CANCELLED");
  const next=await prepared(b);
  await assert.rejects(()=>repo.claim(a.claim),/Stale|cancelled/);
  assert.equal((await repo.claim(next.claim)).disposition,"CREATED");
  const events=(await pool.query("SELECT event_type,reference FROM economic_authority_events WHERE intent_id=$1 ORDER BY event_id",[a.e.attempt.intentId])).rows;
  assert(events.some(e=>e.event_type==="CLAIM_REJECTED"&&e.reference===sha256(a.claim.customerArtifact)));
  assert.equal(signer.calls,0);
  const late=(await pool.query("SELECT artifact,validation FROM economic_callback_evidence WHERE intent_id=$1",[a.e.attempt.intentId])).rows[0];
  assert(late.artifact.equals(a.claim.customerArtifact));assert.equal(late.validation,"CUSTOMER_VERIFIED");
});

test("cancellation/finalization races serialize; finalization winner prevents successful cancellation and replacement",async () => {
  await budget();
  for(let i=0;i<8;i++) {
    const p=await prepared();
    const [claimed,cancelled]=await Promise.allSettled([repo.claim(p.claim),repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId)]);
    assert.equal(cancelled.status,"fulfilled");
    if(claimed.status==="fulfilled") assert.equal((cancelled as PromiseFulfilledResult<string>).value,"FINALIZATION_WON");
    else assert.equal((cancelled as PromiseFulfilledResult<string>).value,"CANCELLED");
  }
});

for(const dimension of ["base","priority","rent","outstanding"] as const) {
  test(`concurrent reservation enforces ${dimension} bound without double spending`,async()=>{
    await budget({[dimension]:dimension==="base"?"10000":dimension==="priority"?"2000":dimension==="rent"?"3000000":1});
    const p=await prepared(),q=await prepared();const results=await Promise.allSettled([repo.claim(p.claim),repo.claim(q.claim)]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1,JSON.stringify(results.map(r=>r.status==="fulfilled"?{status:r.status}:{status:r.status,message:r.reason instanceof Error?r.reason.message:String(r.reason)})));
    assert.equal(await count("economic_finalizations"),1);
  });
}

test("restart after claim and concurrent recovery grant exactly one signer contact; both lookups expose the same result",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);
  const restarted=new PostgresFinalizationRepository(pool,policy,signer);
  await Promise.all(Array.from({length:6},()=>restarted.recover(p.claim.sponsorFinalizationId)));
  const result=await repo.find(p.claim.sponsorFinalizationId);
  assert.equal(signer.calls,1);assert.equal(result?.signerState,"RESULT_AVAILABLE");assert.equal(result.exposureState,"UNCERTAIN");
  assert.deepEqual(result,await repo.findByGeneration(p.e.attempt.intentId,"1"));
  const again=await restarted.recover(p.claim.sponsorFinalizationId);assert.deepEqual(again,result);assert.equal(signer.calls,1);
});

test("lost signer response survives restart and queries the same operation without releasing exposure",async()=>{
  await budget({outstanding:1});const p=await prepared();const op=(await repo.claim(p.claim)).operation;
  signer.loseResponse=true;const unknown=await repo.recover(op.sponsorFinalizationId);
  assert.equal(unknown.signerState,"RESULT_UNKNOWN");assert.equal(unknown.exposureState,"UNCERTAIN");
  const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/budget exhausted/);
  const recovered=await new PostgresFinalizationRepository(pool,policy,signer).recover(op.sponsorFinalizationId);
  assert.equal(recovered.signerState,"RESULT_AVAILABLE");assert.equal(recovered.signerOperationId,op.signerOperationId);assert.equal(recovered.tupleDigest,op.tupleDigest);assert.equal(signer.calls,1);assert.equal(signer.queries,1);
});

test("crash after contact commitment before actual call remains query-only even when signer has never seen the operation",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);
  await pool.query("SELECT economic_commit_signer_contact($1)",[p.claim.sponsorFinalizationId]);
  const result=await new PostgresFinalizationRepository(pool,policy,signer).recover(p.claim.sponsorFinalizationId);
  assert.equal(result.signerState,"RESULT_UNKNOWN");assert.equal(result.exposureState,"UNCERTAIN");assert.equal(signer.calls,0);assert.equal(signer.queries,1);
  assert.equal(await repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId),"FINALIZATION_WON");
});

test("definitive authenticated signer refusal releases once; unknown/query absence never releases",async()=>{
  await budget({outstanding:1});const p=await prepared();await repo.claim(p.claim);signer.refuse=true;
  const result=await repo.recover(p.claim.sponsorFinalizationId);assert.equal(result.signerState,"REFUSED");assert.equal(result.exposureState,"RELEASED");
  assert.deepEqual(await repo.recover(p.claim.sponsorFinalizationId),result);assert.equal(signer.calls,1);
  const q=await prepared();assert.equal((await repo.claim(q.claim)).disposition,"CREATED");
});

test("exact full artifact validates customer signature, sponsor slot, message and fee-payer transaction ID",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);const result=await repo.recover(p.claim.sponsorFinalizationId);
  const row=(await pool.query("SELECT result_artifact,final_transaction_id FROM economic_finalizations WHERE finalization_id=$1",[p.claim.sponsorFinalizationId])).rows[0];
  const tx=Transaction.from(row.result_artifact);assert(tx.verifySignatures());assert.equal(tx.signatures[0].publicKey.toBase58(),sponsor.publicKey.toBase58());
  assert.equal(result.artifactReference,`sha256:${sha256(row.result_artifact)}`);assert.equal(result.finalTransactionId,row.final_transaction_id);
  assert.equal(result.finalTransactionId,base58.encode(tx.signatures[0].signature!));
  assert.notEqual(result.finalTransactionId,base58.encode(tx.signatures[1].signature!));
  assert.deepEqual(tx.serializeMessage(),Transaction.from(p.claim.customerArtifact).serializeMessage());
});

for(const kind of ["network","key-version","message","customer-signature","sponsor-signature","operation"] as const) {
  test(`reject signer result with wrong ${kind}; preserve uncertainty`,async()=>{
    await budget();const p=await prepared();await repo.claim(p.claim);
    signer.transform=(response)=>{
      if(kind==="network")return{...response,network:{...response.network,genesisHash:user.publicKey.toBase58()}};
      if(kind==="key-version")return{...response,sponsorKeyVersion:"other"};
      if(kind==="operation")return{...response,signerOperationId:randomUUID()};
      assert.equal(response.state,"SIGNED");if(response.state!=="SIGNED")return response;
      const tx=Transaction.from(response.artifact);
      if(kind==="message")tx.recentBlockhash=sponsor.publicKey.toBase58();
      else tx.signatures[kind==="customer-signature"?1:0].signature=Buffer.alloc(64,9);
      return{...response,artifact:tx.serialize({verifySignatures:false})};
    };
    await assert.rejects(()=>repo.recover(p.claim.sponsorFinalizationId));
    const result=await repo.find(p.claim.sponsorFinalizationId);assert.equal(result?.signerState,"RESULT_UNKNOWN");assert.equal(result.exposureState,"UNCERTAIN");
  });
}

test("wrong callback message/signer/envelope and corrupt replay cannot acquire authority",async()=>{
  await budget();const p=await prepared(),q=await prepared();
  await assert.rejects(()=>repo.claim({...p.claim,customerArtifact:q.claim.customerArtifact}));
  await assert.rejects(()=>repo.claim({...p.claim,envelopeDigest:"ef".repeat(32)}));
  const tx=Transaction.from(p.claim.customerArtifact);tx.signatures[1].signature=Buffer.alloc(64,1);
  await assert.rejects(()=>repo.claim({...p.claim,customerArtifact:tx.serialize({requireAllSignatures:false,verifySignatures:false})}));
  assert.equal(await count("economic_finalizations"),0);
});

test("finalized exposure observer binds exact transaction/network and realized amounts; consumed cost stays charged",async()=>{
  await budget({base:"15000"});const p=await prepared();await repo.claim(p.claim);await repo.recover(p.claim.sponsorFinalizationId);
  let mode="unknown";
  const observer:TrustedExposureObserver={async observe(op){if(mode==="unknown")return{state:"UNKNOWN"};return{state:"FINALIZED",finalizationId:op.sponsorFinalizationId,transactionId:mode==="wrong"?"wrong":op.finalTransactionId!,network:op.tuple.network,reference:"finalized:test:one",base:"9000",priority:"1000",rent:"2000000"};}};
  const accounting=new PostgresFinalizationRepository(pool,policy,signer,observer);
  assert.equal((await accounting.settleExposure(p.claim.sponsorFinalizationId)).exposureState,"UNCERTAIN");
  mode="wrong";await assert.rejects(()=>accounting.settleExposure(p.claim.sponsorFinalizationId));
  mode="final";const result=await accounting.settleExposure(p.claim.sponsorFinalizationId);assert.equal(result.exposureState,"CONSUMED");assert.equal(result.consumed?.base,"9000");
  assert.deepEqual(await accounting.settleExposure(p.claim.sponsorFinalizationId),result);
  const q=await prepared();await assert.rejects(()=>repo.claim(q.claim),/budget exhausted/);
});

test("database guards reject tuple/operation/result mutation, deletion, illegal signer and unsafe release transitions",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);
  for(const mutation of ["tuple_digest=repeat('a',64)","signer_operation_id=gen_random_uuid()","exposure_state='RELEASED'","signer_state='RESULT_AVAILABLE'","base_requested=0"])
    await assert.rejects(()=>pool.query(`UPDATE economic_finalizations SET ${mutation},version=version+1 WHERE finalization_id=$1`,[p.claim.sponsorFinalizationId]));
  await repo.recover(p.claim.sponsorFinalizationId);
  for(const mutation of ["final_transaction_id='different'","result_artifact=decode('00','hex')","signer_state='RESULT_UNKNOWN'","artifact_reference='other'"])
    await assert.rejects(()=>pool.query(`UPDATE economic_finalizations SET ${mutation},version=version+1 WHERE finalization_id=$1`,[p.claim.sponsorFinalizationId]));
  await assert.rejects(()=>pool.query("DELETE FROM economic_finalizations WHERE finalization_id=$1",[p.claim.sponsorFinalizationId]));
  await assert.rejects(()=>pool.query("UPDATE economic_consent_evidence SET principal_id='forged' WHERE consent_id=$1",[p.claim.consentId]));
  await assert.rejects(()=>pool.query("DELETE FROM economic_authority_events"));
});

async function installFault(event:string) {
  await pool.query(`CREATE FUNCTION economic_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${event}' THEN RAISE EXCEPTION 'injected crash before commit'; END IF; RETURN NEW; END; $$`);
  await pool.query("CREATE TRIGGER economic_test_fault BEFORE INSERT ON economic_authority_events FOR EACH ROW EXECUTE FUNCTION economic_test_fault()");
}
async function clearFault(){await pool.query("DROP TRIGGER economic_test_fault ON economic_authority_events; DROP FUNCTION economic_test_fault()");}

test("crash during finalization/reservation transaction rolls back fence and reservation together",async()=>{
  await budget({outstanding:1});const p=await prepared();await installFault("FINALIZATION_COMMITTED");
  try{await assert.rejects(()=>repo.claim(p.claim),/injected crash/);}finally{await clearFault();}
  assert.equal(await count("economic_finalizations"),0);
  assert.equal((await pool.query("SELECT state FROM economic_attempts WHERE envelope_digest=$1",[p.digest])).rows[0].state,"OPEN");
  assert.equal((await new PostgresFinalizationRepository(pool,policy,signer).claim(p.claim)).disposition,"CREATED");
});

test("crash during cancellation leaves predecessor open and prevents next generation",async()=>{
  const p=await prepared();await installFault("CANCELLED");
  try{await assert.rejects(()=>repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId),/injected crash/);}finally{await clearFault();}
  const next=envelope(e=>{e.attempt.intentId=p.e.attempt.intentId;e.attempt.generation="2";});
  await assert.rejects(()=>repo.registerAttempt(next,fixture.recentBlockhash),/cancellation/);
  assert.equal(await repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId),"CANCELLED");
});

test("audit history retains identifiers and transition evidence without tokens, raw transactions or signatures",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);await repo.recover(p.claim.sponsorFinalizationId);
  const rows=(await pool.query("SELECT * FROM economic_authority_events ORDER BY event_id")).rows;
  for(const event of ["CONSENT_ACCEPTED","RUNTIME_ACCEPTED","ATTEMPT_REQUESTED","FINALIZATION_COMMITTED","SIGNER_CONTACT_COMMITTED","SIGNER_RESULT_VERIFIED"])assert(rows.some(r=>r.event_type===event),event);
  const text=JSON.stringify(rows);assert(!text.includes(token));assert(!text.includes(p.claim.customerArtifact.toString("base64")));
});

test("expiry after claim blocks first signer contact, while historical replay remains a lookup",async()=>{
  await budget();
  const p=await prepared(envelope(e=>{e.expiresAt=new Date(Date.now()+2000).toISOString();e.runtime.validUntil=e.expiresAt;}));
  await repo.claim(p.claim);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(p.e.expiresAt)-Date.now())+20));
  await assert.rejects(()=>repo.recover(p.claim.sponsorFinalizationId),/stale|Expired/);
  assert.equal(signer.calls,0);assert.equal((await repo.claim(p.claim)).disposition,"REPLAY");
  assert.equal((await repo.find(p.claim.sponsorFinalizationId))?.exposureState,"RESERVED");
});

test("expired decision/consent cannot acquire a first reservation",async()=>{
  await budget();
  const p=await prepared(envelope(e=>{e.expiresAt=new Date(Date.now()+1600).toISOString();e.runtime.validUntil=e.expiresAt;}));
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(p.e.expiresAt)-Date.now())+20));
  await assert.rejects(()=>repo.claim(p.claim),/stale|Expired/);assert.equal(await count("economic_finalizations"),0);
});

test("suspended canonical account fails eligibility; other trusted configuration cannot reuse accepted evidence",async()=>{
  await budget();const p=await prepared();
  const account=await identities.findAccount(accountId);assert(account);
  await identities.updateAccountStatus({accountId,expectedVersion:account.version,status:"SUSPENDED"});
  await assert.rejects(()=>repo.claim(p.claim),/inactive/);
  const q=await identities.findAccount(accountId);assert(q);await identities.updateAccountStatus({accountId,expectedVersion:q.version,status:"ACTIVE"});
  for(const changed of [{...policy,auth:{...policy.auth,issuer:"https://other.example/"}}, {...policy,auth:{...policy.auth,audience:"different"}}, {...policy,runtimeIssuer:"runtime:other"}, {...policy,policyVersions:["policy-v2"]}]) {
    await assert.rejects(()=>new PostgresFinalizationRepository(pool,changed,signer).claim(p.claim));
  }
  assert.equal(await count("economic_finalizations"),0);
});

test("revocation races with eligibility and contact under the same evidence locks",async()=>{
  await budget();const p=await prepared();
  const results=await Promise.allSettled([repo.claim(p.claim),ingestion.revoke("consent",p.claim.consentId)]);
  assert.equal(results[1].status,"fulfilled");
  if(results[0].status==="fulfilled")await assert.rejects(()=>repo.recover(p.claim.sponsorFinalizationId),/revoked/);
  assert.equal(signer.calls,0);
});

test("after contact, evidence revocation still permits same-operation result recovery without another signature request",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);signer.loseResponse=true;
  await repo.recover(p.claim.sponsorFinalizationId);await ingestion.revoke("runtime",p.e.runtime.decisionId);await admin.revoke("asset","devnet-usdc-v1");
  const result=await new PostgresFinalizationRepository(pool,policy,signer).recover(p.claim.sponsorFinalizationId);
  assert.equal(result.signerState,"RESULT_AVAILABLE");assert.equal(signer.calls,1);assert.equal(signer.queries,1);
});

test("fresh configuration effective in the future cannot qualify an asset",async()=>{
  await pool.query("TRUNCATE economic_network_registry CASCADE");
  const future=devnetUsdcConfiguration(config.network.identity.genesisHash,new Date(Date.now()+3600_000).toISOString());
  await admin.install(future);
  await assert.rejects(()=>repo.registerAttempt(envelope(),fixture.recentBlockhash),/ineffective/);
});

test("concurrent cancelled-generation replacement permits only one fresh attempt",async()=>{
  const p=await prepared();await repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId);
  const next=()=>envelope(e=>{e.attempt.intentId=p.e.attempt.intentId;e.attempt.generation="2";});
  const results=await Promise.allSettled([repo.registerAttempt(next(),fixture.recentBlockhash),repo.registerAttempt(next(),fixture.recentBlockhash)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await pool.query("SELECT current_generation FROM economic_attempt_heads WHERE intent_id=$1",[p.e.attempt.intentId])).rows[0].current_generation,"2");
});

test("cancellation requires exact owner and fence; next generation cannot decrease intent version",async()=>{
  const p=await prepared(envelope(e=>e.attempt.intentVersion="2"));
  await assert.rejects(()=>repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,"someone:else"));
  await assert.rejects(()=>repo.cancel(p.e.attempt.intentId,"1","wrong",principalId));
  await repo.cancel(p.e.attempt.intentId,"1",p.e.attempt.fenceToken,principalId);
  const next=envelope(e=>{e.attempt.intentId=p.e.attempt.intentId;e.attempt.generation="2";});
  await assert.rejects(()=>repo.registerAttempt(next,fixture.recentBlockhash),/Replacement/);
});

test("requested, reserved, uncertain, consumed and released amounts are distinguishable",async()=>{
  await budget();const p=await prepared();
  const projection=async()=> (await pool.query("SELECT * FROM economic_exposure_projection WHERE intent_id=$1",[p.e.attempt.intentId])).rows[0];
  let row=await projection();assert.equal(row.exposure_state,"REQUESTED");assert.equal(row.base_reserved,"0");assert.equal(row.base_requested,"10000");
  await repo.claim(p.claim);row=await projection();assert.equal(row.exposure_state,"RESERVED");assert.equal(row.base_reserved,"10000");
  signer.loseResponse=true;await repo.recover(p.claim.sponsorFinalizationId);row=await projection();assert.equal(row.exposure_state,"UNCERTAIN");assert.equal(row.base_reserved,"10000");assert.equal(row.base_released,"0");
  await repo.recover(p.claim.sponsorFinalizationId);
  const accounting=new PostgresFinalizationRepository(pool,policy,signer,{async observe(op){return{state:"FINALIZED",finalizationId:op.sponsorFinalizationId,transactionId:op.finalTransactionId!,network:op.tuple.network,reference:"chain:test:projection",base:"8000",priority:"0",rent:"2000000"};}});
  await accounting.settleExposure(p.claim.sponsorFinalizationId);row=await projection();assert.equal(row.exposure_state,"CONSUMED");assert.equal(row.base_reserved,"0");assert.equal(row.base_consumed,"8000");assert.equal(row.base_released,"2000");
});

test("accounting overflow or inconsistent replay fails without releasing reserved capacity",async()=>{
  await budget();const p=await prepared();await repo.claim(p.claim);await repo.recover(p.claim.sponsorFinalizationId);
  let amount="10001";
  const observer:TrustedExposureObserver={async observe(op){return{state:"FINALIZED",finalizationId:op.sponsorFinalizationId,transactionId:op.finalTransactionId!,network:op.tuple.network,reference:"chain:accounting:test",base:amount,priority:"0",rent:"0"};}};
  const r=new PostgresFinalizationRepository(pool,policy,signer,observer);
  await assert.rejects(()=>r.settleExposure(p.claim.sponsorFinalizationId));assert.equal((await repo.find(p.claim.sponsorFinalizationId))?.exposureState,"UNCERTAIN");
  amount="10000";await r.settleExposure(p.claim.sponsorFinalizationId);
  amount="9999";await assert.rejects(()=>r.settleExposure(p.claim.sponsorFinalizationId),/Conflicting/);
});

test("constraint/index inventory covers canonical alternate key, immutable signer ID and deferred fences",async()=>{
  const names=(await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='economic_finalizations'::regclass")).rows.map(r=>r.conname);
  assert(names.includes("economic_finalizations_intent_id_generation_key"));assert(names.includes("economic_finalizations_signer_operation_id_key"));
  const triggers=(await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid='economic_finalizations'::regclass AND NOT tgisinternal")).rows.map(r=>r.tgname);
  assert(triggers.includes("economic_finalization_immutable"));assert(triggers.includes("economic_finalization_fence_guard"));assert(triggers.includes("economic_budget_capacity_guard"));
});
