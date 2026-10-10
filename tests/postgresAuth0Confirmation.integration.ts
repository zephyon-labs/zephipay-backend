import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { parse } from "pg-connection-string";
import { createEconomicIntentEnvelopeV1, createSponsorFinalizationTupleV1, sponsorTupleDigestV1 } from "zephyon-protocol";
import { Auth0ConfirmationBridge, confirmationRoutes } from "../src/economic/confirmation/confirmationBridge";
import { Auth0SdkConfirmationAdapter } from "../src/economic/confirmation/auth0SdkConfirmationAdapter";
import { auth0SdkHostFixture } from "./helpers/auth0SdkHostFixture";
import { waitForPostgresPast } from "./helpers/postgresClock";
import { ConfirmationProofAuthority } from "../src/economic/confirmation/confirmationProofAuthority";
import { registerConfirmationPolicy, type VerifiedConfirmationPolicy } from "../src/economic/confirmation/confirmationPolicy";
import { verifyAuthorityLogin, type DeploymentExpectation } from "../src/economic/composition/verifyAuthorityLogin";
import { databaseTime, sha256, transaction } from "../src/economic/foundation/database";
import { loadAuthoritativeEvidence, type EvidencePolicy } from "../src/economic/foundation/evidenceIngestion";
import { PostgresFinalizationRepository } from "../src/economic/foundation/postgresFinalizationRepository";
import { lockEconomicSession } from "../src/economic/foundation/sessionAuthority";
import { TrustedRegistryAdministration, devnetUsdcConfiguration } from "../src/economic/foundation/trustedRegistry";
import { AuthorityProcess } from "../src/economic/provider/authorityProcess";
import { DeploymentReadiness, readinessRoles } from "../src/economic/readiness/deploymentProfile";
import { ProviderDeploymentReadiness } from "../src/economic/readiness/providerDeploymentReadiness";
import { ReadinessServiceTransport } from "../src/economic/readiness/serviceTransport";
import type { Auth0Authentication, Auth0Reauthentication, ReauthenticationChallenge } from "../src/economic/readiness/auth0Authentication";
import { PostgresIdentityPersistence, createAccountSessionInTransaction, revokeAccountSessionInTransaction } from "../src/storage/postgres/postgresIdentityPersistence";
import { confirmationPolicyFixture } from "./helpers/confirmationFixtures";
import { installSyntheticStore } from "./helpers/syntheticAuthorityAdapters";
import { accessFixture, endpointFixture, endpointKeys, headFixture, profileFixture, readyFixture, serviceKeys, signedFixture, snapshotFixture } from "./helpers/realProviderFixtures";

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL required; disposable fixtures only.");
const admin = new Pool({connectionString:url,max:8});
const db = Object.fromEntries(readinessRoles.map(role => [role,new Pool({...parse(url),user:`provider_fixture_${role}`,
  password:"disposable-provider-fixture-only",max:5} as PoolConfig)])) as Record<typeof readinessRoles[number],Pool>;
const identities = new PostgresIdentityPersistence(db.identity), registry = new TrustedRegistryAdministration(admin);
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json","utf8"));
let databaseName: string, identityOwner: string, accountId: string, sessionId: string, principalId: string, version: bigint;
let f: Awaited<ReturnType<typeof readyFixture>>, policy: VerifiedConfirmationPolicy, bridge: Auth0ConfirmationBridge, sender: ReadinessServiceTransport;
let proofAuthority: ConfirmationProofAuthority;
let receiver: ReadinessServiceTransport, authentication: Auth0Authentication, repo: PostgresFinalizationRepository;
let evidence: EvidencePolicy;
const pause = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
async function waitForDatabaseDeadline(deadline: string|Date) {
  const limit=process.hrtime.bigint()+15_000_000_000n;
  while(process.hrtime.bigint()<limit) {
    const row=(await admin.query("SELECT clock_timestamp()>$1::timestamptz+interval '100 milliseconds' AS elapsed, extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000 AS remaining",[deadline])).rows[0];
    if(row.elapsed)return;
    await pause(Math.max(10,Math.min(500,Number(row.remaining)+110)));
  }
  assert.fail("disposable database did not reach the bounded test deadline");
}
function confirmationEndpoint() {
  // Keep fixture issuance away from a wall-clock second boundary; production expiry checks stay unchanged.
  const now=Math.floor(Date.now()/1000);
  return endpointFixture(f.configuration,"fixture-nonce",{verifiedAt:now-1,expiresAt:now+59});
}
function expected(role: typeof readinessRoles[number]): DeploymentExpectation {
  return {deploymentId:profileFixture().deploymentId,environment:"offline-fixture",databaseName,login:`provider_fixture_${role}`,
    credentialGeneration:"1",schemaOwner:"pg_database_owner",identityOwner};
}
function volatileFixtureLedger() { const ids = new Set<string>(); return {async consume(id: string) {if(ids.has(id)) return false;ids.add(id);return true;}}; }
function rebuild() {
  proofAuthority=new ConfirmationProofAuthority(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("identity",db.identity,expected("identity")),f.configuration,endpointKeys.publicKey),f.auth),policy);
  const keys = Object.fromEntries(readinessRoles.map(r=>[r,serviceKeys[r].publicKey])) as any;
  sender = new ReadinessServiceTransport("identity",f.configuration,serviceKeys.identity.privateKey,keys,volatileFixtureLedger(),[]);
  receiver = new ReadinessServiceTransport("issuer",f.configuration,serviceKeys.issuer.privateKey,keys,volatileFixtureLedger(),confirmationRoutes);
  bridge = new Auth0ConfirmationBridge(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("issuer",db.issuer,expected("issuer")),f.configuration,endpointKeys.publicKey),f.auth),receiver,policy);
}
before(async () => {
  databaseName = (await admin.query("SELECT current_database() AS name")).rows[0].name;
  identityOwner = (await admin.query("SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid='accounts'::regclass")).rows[0].name;
  for (const role of readinessRoles) {
    const name = `provider_fixture_${role}`;
    if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[name])).rowCount)
      await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'disposable-provider-fixture-only'`);
    await admin.query(`GRANT zephipay_economic_${role} TO ${name}`);
  }
  await installSyntheticStore(admin); // Schema only for the existing six-role ACL contract; no synthetic service is invoked.
});
beforeEach(async () => {
  await admin.query("TRUNCATE economic_authority_events,economic_network_registry,economic_sponsor_budgets,accounts,economic_deployment_identity,economic_deployment_logins RESTART IDENTITY CASCADE");
  await admin.query("INSERT INTO economic_deployment_identity(deployment_id,environment,database_name,provider_key_revision) VALUES($1,'offline-fixture',$2,1)",
    [profileFixture().deploymentId,databaseName]);
  for(const role of readinessRoles) await admin.query("INSERT INTO economic_deployment_logins VALUES($1,$2,1)",[role,`provider_fixture_${role}`]);
  f = await readyFixture(profileFixture({databaseName})); policy = confirmationPolicyFixture(f.configuration);
  await registerConfirmationPolicy(admin,policy); rebuild();
  const result = await identities.provisionExternalIdentity({accountId:randomUUID(),identityId:randomUUID(),issuer:f.configuration.profile.issuer,
    subject:"subject:alice",occurredAt:new Date(Date.now()-60000).toISOString()});
  accountId=result.account.accountId; principalId=result.account.actorSubject; sessionId=randomUUID();
  version=(await identities.createAccountSession({accountId,sessionId,expectedAccountVersion:result.account.version,
    createdAt:new Date(Date.now()-30000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()})).account.version;
  authentication=await f.auth.verifyAccess(await accessFixture({scope:"confirm:economic"}),"confirm:economic");
  evidence={auth:{issuer:f.configuration.profile.issuer,audience:f.configuration.profile.audience,requiredScope:"confirm:economic"},
    runtimeIssuer:"runtime:independent",policyVersions:["policy-v1"],context:"devnet-test"};
  repo=new PostgresFinalizationRepository(db.app,evidence); // No signer or observer injected; no transaction is signed in this suite.
  await registry.install(devnetUsdcConfiguration(fixture.qualifiedAsset.network.genesisHash,"2026-01-01T00:00:00.000Z"));
});
const webServers: import("node:http").Server[]=[];
afterEach(async () => {
  for(const server of webServers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  for(const table of ["economic_runtime_evidence","economic_finalizations","economic_signer_contact_authority","economic_effect_evidence"])
    assert.equal(Number((await admin.query(`SELECT count(*) FROM ${table}`)).rows[0].count),0,`${table} must remain empty`);
});
after(async()=>{await Promise.all([...Object.values(db),admin].map(p=>p.end()));});
async function prepare(changes: Record<string,unknown>={}) {
  const e=structuredClone(fixture.envelope), now=Date.now();
  e.principal.id=principalId; e.attempt.intentId=randomUUID();e.attempt.attemptId=randomUUID();e.attempt.fenceToken=randomUUID();
  e.createdAt=new Date(now-60000).toISOString();e.expiresAt=new Date(now+600000).toISOString();
  e.runtime.decisionId=randomUUID();e.runtime.validFrom=e.createdAt;e.runtime.validUntil=e.expiresAt;
  Object.assign(e,changes);
  const envelope=createEconomicIntentEnvelopeV1(e,e.amount.asset), digest=await repo.registerAttempt(envelope,fixture.recentBlockhash);
  return {envelope,digest};
}
async function call(action: string, input: Record<string,unknown>, reauth?: Auth0Reauthentication, auth=authentication, proofId?: string) {
  const path=`/confirmation/${action}`, body=JSON.stringify({accountSessionId:sessionId,authenticationDigest:auth.tokenDigest,...input});
  const generated=JSON.parse(sender.request("issuer","POST",path,body).payload);
  // A valid past issuance avoids second-boundary jitter in this SQL-focused fixture; the accepted transport still verifies it normally.
  const request=signedFixture({...generated,issuedAt:generated.issuedAt-1,expiresAt:generated.expiresAt-1},serviceKeys.identity.privateKey);
  const response=await bridge.execute(path,body,request,confirmationEndpoint(),"fixture-nonce",auth,reauth,proofId);
  await sender.verifyResponse(request,response.signature,response.body);
  return JSON.parse(response.body);
}
async function start(digest: string, requestId=randomUUID()) {return call("start",{envelopeDigest:digest,requestId});}
async function issued() {const p=await prepare(), c=await start(p.digest);return {...p,c};}
function ref(p: Awaited<ReturnType<typeof issued>>) {return {envelopeDigest:p.digest,challengeId:p.c.challenge_id,transactionId:p.c.transaction_id};}
async function callback(p: Awaited<ReturnType<typeof issued>>, changes: Record<string,unknown>={}) {
  const result=await call("roundtrip",ref(p)), challenge=result.reauthentication as ReauthenticationChallenge;
  while(Date.now()<challenge.requestedAt*1000+200) await pause(Math.max(1,challenge.requestedAt*1000-Date.now()+200));
  await waitForDatabaseDeadline(new Date(challenge.requestedAt*1000));
  const raw=await accessFixture({aud:f.configuration.profile.clientId,iat:challenge.requestedAt,auth_time:challenge.requestedAt,
    nonce:challenge.nonce,acr:"fixture:mfa",...changes});
  const proof=await f.auth.verifyReauthentication(raw,challenge), digest=sha256(raw);
  const body=JSON.stringify({accountSessionId:sessionId,authenticationDigest:authentication.tokenDigest,...ref(p),action:"confirm-economic-intent",reauthenticationDigest:digest});
  const proofId=await proofAuthority.record(p.c.challenge_id,challenge,body,authentication,proof,confirmationEndpoint(),"fixture-nonce");
  return {proof,digest,raw,challenge,proofId,body};
}
async function confirm(p: Awaited<ReturnType<typeof issued>>, cb: Awaited<ReturnType<typeof callback>>, changes: Record<string,unknown>={}) {
  return call("confirm",{...ref(p),action:"confirm-economic-intent",reauthenticationDigest:cb.digest,...changes},cb.proof,authentication,cb.proofId);
}
async function count(table: string) {return Number((await admin.query(`SELECT count(*) FROM ${table}`)).rows[0].count);}
async function revoke() {return identities.revokeAccountSession({accountId,sessionId,expectedAccountVersion:version,revokedAt:new Date().toISOString()});}
function admitArgs(p: Awaited<ReturnType<typeof issued>>, cb: Awaited<ReturnType<typeof callback>>) {
  return [p.c.challenge_id,cb.proofId,sessionId,p.digest,p.c.transaction_id,sha256(cb.body)];
}
const admitSql="SELECT economic_admit_confirmation($1,$2,$3,$4,$5,$6) AS id";
async function directAdmit(p: Awaited<ReturnType<typeof issued>>, cb: Awaited<ReturnType<typeof callback>>) {
  return (await db.issuer.query(admitSql,admitArgs(p,cb))).rows[0].id as string;
}
async function evidenceFor(cb: Awaited<ReturnType<typeof callback>>) {
  const m=await f.auth.assertReauthentication(cb.proof,cb.challenge,Date.now()/1000);
  return {authenticationDigest:authentication.tokenDigest,authenticationIssuedAt:authentication.issuedAt,authenticationExpiresAt:authentication.expiresAt,
    providerEvidence:m.tokenDigest,issuedAt:m.issuedAt,expiresAt:m.expiresAt,authTime:cb.proof.authenticationTime,assurance:cb.proof.acr,
    nonce:cb.challenge.nonce,subject:authentication.subject,issuer:authentication.issuer,configuration:authentication.configuration,providerRevision:authentication.keyRevision,
    requestDigest:sha256(cb.body),transactionId:JSON.parse(cb.body).transactionId,accountSessionId:sessionId,envelopeDigest:cb.challenge.envelopeDigest,action:cb.challenge.action,
    policyFingerprint:policy.fingerprint,scope:policy.policy.requiredScope};
}

test("lost creation response recovers the same durable challenge and transaction without consent",async()=>{
  const p=await prepare(), requestId=randomUUID(), first=await start(p.digest,requestId), second=await start(p.digest,requestId);
  assert.deepEqual(second,first);assert.equal(await count("economic_confirmation_challenges"),1);assert.equal(await count("economic_consent_evidence"),0);
  const q=await prepare();await assert.rejects(()=>start(q.digest,requestId),/another envelope/);
});
test("authentication or a callback alone cannot admit consent; exact confirmation admits only bounded consent",async()=>{
  const p=await issued(), cb=await callback(p);assert.equal(await count("economic_consent_evidence"),0);
  await assert.rejects(()=>call("confirm",{...ref(p),action:"confirm-economic-intent",reauthenticationDigest:cb.digest}),/Explicit/);
  const result=await confirm(p,cb);assert.equal(result.state,"CONFIRMED");
  const c=(await admin.query("SELECT * FROM economic_consent_evidence")).rows[0], r=(await admin.query("SELECT * FROM economic_confirmation_consumptions")).rows[0];
  assert.equal(c.envelope_digest,p.digest);assert.equal(c.account_session_id,sessionId);assert.equal(r.consent_id,c.consent_id);
  assert.equal(r.database_actor,"provider_fixture_issuer");assert.equal(r.authentication_time.getTime()/1000,cb.proof.authenticationTime);
  assert.equal(c.session_reference,`zephipay:canonical:${sessionId}`);assert(c.expires_at<=new Date(p.c.expires_at));
  await transaction(db.issuer,client=>lockEconomicSession(client,{issuer:c.issuer,subject:c.provider_subject,providerSession:c.session_reference,
    principalId,requiredSessionId:sessionId,authenticatedAt:c.authenticated_at.toISOString()}));
  await assert.rejects(()=>transaction(db.app,async client=>loadAuthoritativeEvidence(client,p.envelope,c.consent_id,evidence,await databaseTime(client))),/Runtime/);
  assert(!JSON.stringify(r).includes(cb.raw));
});
for(let repetition=1;repetition<=3;repetition++) test(`two service instances, one durable consume, lost response and reconstructed replay ${repetition}`,async()=>{
  const p=await issued(),cb=await callback(p), oldBridge=bridge;
  rebuild();
  const one=confirm(p,cb);const secondBridge=bridge;bridge=oldBridge;const two=confirm(p,cb);bridge=secondBridge;
  const outcomes=await Promise.allSettled([one,two]);assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(await count("economic_consent_evidence"),1);assert.equal(await count("economic_confirmation_consumptions"),1);
  f=await readyFixture(profileFixture({databaseName}));authentication=await f.auth.verifyAccess(await accessFixture({scope:"confirm:economic"}),"confirm:economic");rebuild();
  const recovered=await call("recover",ref(p));assert.equal(recovered.state,"CONFIRMED");assert(recovered.consent_id);
  const reverified=await f.auth.verifyReauthentication(cb.raw,cb.challenge);
  await assert.rejects(()=>confirm(p,{...cb,proof:reverified}),/consumed/);
});
for(const [label,change] of [["another envelope",()=>({envelopeDigest:"00".repeat(32)})],["another session",()=>({accountSessionId:randomUUID()})],
  ["another transaction",()=>({transactionId:randomUUID()})],["another challenge",()=>({challengeId:randomUUID()})],
  ["another action",()=>({action:"approve-payment"})],["callback substitution",()=>({reauthenticationDigest:"00".repeat(32)})]] as const)
  test(`confirmation rejects ${label}`,async()=>{const p=await issued(),cb=await callback(p);await assert.rejects(()=>confirm(p,cb,change()));assert.equal(await count("economic_consent_evidence"),0);});
test("proof-shaped objects, wrong subject and another stored nonce cannot confirm",async()=>{
  const p=await issued(),cb=await callback(p),q=await issued();
  await assert.rejects(()=>confirm(p,{...cb,proof:{...cb.proof}}),/Unverified/);
  const bob=await f.auth.verifyAccess(await accessFixture({sub:"subject:bob",scope:"confirm:economic"}),"confirm:economic");
  await assert.rejects(()=>call("roundtrip",ref(p),undefined,bob),/identity/);
  await assert.rejects(()=>confirm(q,cb),/substituted/);
  const cq=await call("roundtrip",ref(q));await assert.rejects(()=>f.auth.verifyReauthentication(cb.raw,cq.reauthentication));
});
test("wrong environment, signed caller, or altered request body fails the service boundary",async()=>{
  const p=await prepare(),path="/confirmation/start",body=JSON.stringify({accountSessionId:sessionId,envelopeDigest:p.digest,requestId:randomUUID(),authenticationDigest:authentication.tokenDigest});
  const request=sender.request("issuer","POST",path,body);
  await assert.rejects(()=>bridge.execute(path,body+" ",request,endpointFixture(f.configuration),"fixture-nonce",authentication),/body/);
  const keys=Object.fromEntries(readinessRoles.map(r=>[r,serviceKeys[r].publicKey])) as any;
  const wrong=new ReadinessServiceTransport("app",f.configuration,serviceKeys.app.privateKey,keys,volatileFixtureLedger(),[]);
  await assert.rejects(()=>bridge.execute(path,body,wrong.request("issuer","POST",path,body),endpointFixture(f.configuration),"fixture-nonce",authentication),/caller/);
  const foreign=await readyFixture(profileFixture({databaseName,environment:"wrong"}));
  const other=new ReadinessServiceTransport("identity",foreign.configuration,serviceKeys.identity.privateKey,keys,volatileFixtureLedger(),[]);
  await assert.rejects(()=>bridge.execute(path,body,other.request("issuer","POST",path,body),endpointFixture(f.configuration),"fixture-nonce",authentication),/context/);
});
test("database-clock expiry is derived without mutation and never creates consent",async()=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,challengeSeconds:3});await registerConfirmationPolicy(admin,policy);rebuild();
  const p=await issued(),cb=await callback(p);await waitForDatabaseDeadline(p.c.expires_at);
  assert.equal((await call("recover",ref(p))).state,"EXPIRED");await assert.rejects(()=>confirm(p,cb),/expired/);
  assert.equal(await count("economic_consent_evidence"),0);
});
test("session revoked first blocks confirmation and recovery, without rewriting issued evidence",async()=>{
  const p=await issued(),cb=await callback(p),before=(await admin.query("SELECT * FROM economic_confirmation_challenges")).rows;
  await revoke();await assert.rejects(()=>confirm(p,cb),/session/);await assert.rejects(()=>call("recover",ref(p)),/session/);
  assert.equal((await db.reader.query("SELECT state FROM economic_confirmation_summary")).rows[0].state,"INVALIDATED");
  assert.deepEqual((await admin.query("SELECT * FROM economic_confirmation_challenges")).rows,before);
});
test("account version advancement and inactive status invalidate old challenges",async()=>{
  const p=await issued(),cb=await callback(p);
  const updated=await identities.createAccountSession({accountId,sessionId:randomUUID(),expectedAccountVersion:version,
    createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
  await assert.rejects(()=>confirm(p,cb),/Stale account/);
  await identities.updateAccountStatus({accountId,expectedVersion:updated.account.version,status:"SUSPENDED",occurredAt:new Date().toISOString()});
  await assert.rejects(()=>start(p.digest),/account/);
});
for(let repetition=1;repetition<=3;repetition++) test(`revocation wins while confirmation waits on the canonical account ${repetition}`,async()=>{
  const p=await issued(),cb=await callback(p),client=await db.identity.connect();let pending:Promise<any>|undefined;
  try {
    await client.query("BEGIN");await revokeAccountSessionInTransaction(client,{accountId,sessionId,expectedAccountVersion:version,revokedAt:new Date().toISOString()});
    pending=confirm(p,cb);const rejected=assert.rejects(pending,/session/);await pause(80);await client.query("COMMIT");await rejected;
  } finally {await client.query("ROLLBACK");client.release();if(pending)await pending.catch(()=>{});}
  assert.equal(await count("economic_consent_evidence"),0);
});
for(let repetition=1;repetition<=3;repetition++) test(`confirmation wins before revocation; immutable history survives ${repetition}`,async()=>{
  const p=await issued(),cb=await callback(p),original=f.auth.assertReauthentication.bind(f.auth);
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),resume=new Promise<void>(r=>release=r);let once=true;
  f.auth.assertReauthentication=async(...args)=>{const result=await original(...args);if(once){once=false;entered();await resume;}return result;};
  const pending=confirm(p,cb);await reached;let revoked=false;const revoking=revoke().then(()=>{revoked=true;});
  await pause(80);assert.equal(revoked,false);release();assert.equal((await pending).state,"CONFIRMED");await revoking;
  assert.equal((await db.reader.query("SELECT state FROM economic_confirmation_summary")).rows[0].state,"CONFIRMED");
  assert.equal(await count("economic_consent_evidence"),1);await assert.rejects(()=>confirm(p,cb),/session/);
});
test("provider revision retirement, policy retirement and configuration change fail closed",async()=>{
  const p=await issued(),cb=await callback(p);
  await admin.query("UPDATE economic_deployment_identity SET provider_key_revision=2");await assert.rejects(()=>confirm(p,cb),/revision/);
  const snapshot=snapshotFixture(f.configuration,2);f.state.head=headFixture(f.configuration,snapshot,2);await f.snapshots.install(snapshot);
  authentication=await f.auth.verifyAccess(await accessFixture({scope:"confirm:economic"}),"confirm:economic");
  await assert.rejects(()=>confirm(p,cb),/revision/);
  policy=confirmationPolicyFixture(f.configuration,{revision:2,acceptedAcr:["fixture:stronger"]});await registerConfirmationPolicy(admin,policy);rebuild();
  await assert.rejects(()=>confirm(p,cb),/revision/);
  f=await readyFixture(profileFixture({databaseName,revision:2}));policy=confirmationPolicyFixture(f.configuration,{revision:3});await registerConfirmationPolicy(admin,policy);rebuild();
  // Config change alone invalidates the old challenge even before new credentials can be admitted.
  assert.equal((await db.reader.query("SELECT state FROM economic_confirmation_summary")).rows[0].state,"INVALIDATED");
});
test("unknown or expired operator facts block challenge creation",async()=>{
  const p=await prepare();
  const now=Math.floor(Date.now()/1000);
  for(const [i,changes] of [{attestation:"UNATTESTED"},{reauthentication:"UNATTESTED"},{expiresAt:now-1,issuedAt:now-60}].entries()) {
    policy=confirmationPolicyFixture(f.configuration,{revision:i+2,...changes} as any);await registerConfirmationPolicy(admin,policy);rebuild();
    await assert.rejects(()=>start(p.digest),/Unattested or expired/);
  }
});
test("policy rotation blocks stale processes and a new configuration cannot reinterpret an issued challenge",async()=>{
  const p=await issued(),cb=await callback(p);
  const next=confirmationPolicyFixture(f.configuration,{revision:2});await registerConfirmationPolicy(admin,next);
  await assert.rejects(()=>confirm(p,cb),/Retired/); // Old process is pinned to the retired policy.
  policy=next;rebuild();await assert.rejects(()=>confirm(p,cb),/Stale/);
  f=await readyFixture(profileFixture({databaseName,revision:2}));policy=confirmationPolicyFixture(f.configuration,{revision:3});
  await registerConfirmationPolicy(admin,policy);rebuild();
  authentication=await f.auth.verifyAccess(await accessFixture({scope:"confirm:economic"}),"confirm:economic");
  await assert.rejects(()=>confirm(p,cb),/Stale/);
  const historical=await call("recover",ref(p));assert.equal(historical.state,"INVALIDATED");
});
for(let repetition=1;repetition<=3;repetition++) test(`key snapshot retirement during consent admission rolls back both records ${repetition}`,async()=>{
  const p=await issued(),cb=await callback(p),original=f.auth.assertReauthentication.bind(f.auth);let once=true;
  f.auth.assertReauthentication=async(...args)=>{
    const result=await original(...args);
    if(once){once=false;const next=snapshotFixture(f.configuration,2);f.state.head=headFixture(f.configuration,next,2);await f.snapshots.install(next);}
    return result;
  };
  await assert.rejects(()=>confirm(p,cb),/Retired|revision/);
  assert.equal(await count("economic_consent_evidence"),0);assert.equal(await count("economic_confirmation_consumptions"),0);
});
test("consent becoming visible after admission expiry is immediately downstream-ineligible",async()=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,consentSeconds:1});await registerConfirmationPolicy(admin,policy);rebuild();
  const p=await issued(),cb=await callback(p),original=f.auth.assertCurrent.bind(f.auth);let checks=0;
  f.auth.assertCurrent=async proof=>{await original(proof);if(++checks===2)await waitForDatabaseDeadline((await admin.query("SELECT clock_timestamp()+interval '1200 milliseconds' AS deadline")).rows[0].deadline);};
  const result=await confirm(p,cb);assert.equal(result.state,"CONFIRMED");
  const consent=(await admin.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[result.consent_id])).rows[0];
  assert((await admin.query("SELECT $1::timestamptz<clock_timestamp() AS expired",[consent.expires_at])).rows[0].expired);
  await assert.rejects(()=>transaction(db.app,async client=>loadAuthoritativeEvidence(client,p.envelope,result.consent_id,evidence,await databaseTime(client))),/consent/);
  f.auth.assertCurrent=original;assert.equal((await call("recover",ref(p))).state,"CONFIRMED");
});
test("durable provider rotation waits for an already admitted confirmation transaction",async()=>{
  const p=await issued(),cb=await callback(p),original=f.auth.assertReauthentication.bind(f.auth);
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),resume=new Promise<void>(r=>release=r);let once=true;
  f.auth.assertReauthentication=async(...args)=>{const result=await original(...args);if(once){once=false;entered();await resume;}return result;};
  const pending=confirm(p,cb);await reached;let rotated=false;
  const rotating=admin.query("UPDATE economic_deployment_identity SET provider_key_revision=2").then(()=>{rotated=true;});
  await pause(80);assert.equal(rotated,false);release();assert.equal((await pending).state,"CONFIRMED");await rotating;
  await assert.rejects(()=>confirm(p,cb),/revision/);assert.equal(await count("economic_consent_evidence"),1);
});
test("cancellation and replacement never preserve authority for the old envelope",async()=>{
  const p=await issued(),cb=await callback(p);await repo.cancel(p.envelope.attempt.intentId,"1",p.envelope.attempt.fenceToken,principalId);
  await assert.rejects(()=>confirm(p,cb),/terminal/);
  const next=structuredClone(p.envelope);Object.assign(next.attempt,{generation:"2",attemptId:randomUUID(),fenceToken:randomUUID()});
  const digest=await repo.registerAttempt(next,fixture.recentBlockhash);await assert.rejects(()=>confirm(p,cb),/replaced/);
  await assert.rejects(()=>confirm(p,cb,{envelopeDigest:digest}),/mismatch/);
});
for(const table of ["economic_consent_evidence","economic_confirmation_consumptions","economic_confirmation_admissions","economic_authority_events"]) test(`database failure at ${table} rolls back both records and permits safe retry`,async()=>{
  const p=await issued(),cb=await callback(p);
  await admin.query("CREATE FUNCTION fixture_reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected consent admission failure'; END $$");
  await admin.query(`CREATE TRIGGER fixture_confirmation_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fixture_reject_confirmation()`);
  try {
    await assert.rejects(()=>confirm(p,cb),/injected/);assert.equal(await count("economic_consent_evidence"),0);assert.equal(await count("economic_confirmation_consumptions"),0);
    assert.equal(await count("economic_confirmation_admissions"),0);
    assert.equal((await admin.query("SELECT count(*)::integer AS n FROM economic_authority_events WHERE actor='auth0-confirmation-bridge'")).rows[0].n,0);
  }
  finally {await admin.query(`DROP TRIGGER fixture_confirmation_failure ON ${table}`);await admin.query("DROP FUNCTION fixture_reject_confirmation()");}
  assert.equal((await call("recover",ref(p))).state,"ISSUED");rebuild();assert.equal((await confirm(p,cb)).state,"CONFIRMED");
});
test("all actual LOGINs preserve ACL separation, reader projection, append-only and database provenance",async()=>{
  const p=await issued();
  for(const role of readinessRoles) await verifyAuthorityLogin(db[role],role,{deployment:expected(role),syntheticFixtures:true});
  await assert.rejects(()=>db.issuer.query("UPDATE economic_confirmation_challenges SET expires_at=clock_timestamp()"),/permission denied/);
  await assert.rejects(()=>db.issuer.query("DELETE FROM economic_confirmation_consumptions"),/permission denied/);
  await assert.rejects(()=>db.issuer.query("UPDATE economic_confirmation_policy_heads SET deployment_id=deployment_id"),/must advance/);
  await assert.rejects(()=>db.issuer.query("UPDATE economic_deployment_identity SET provider_key_revision=2"),/permission denied/);
  await assert.rejects(()=>db.identity.query("SELECT * FROM economic_confirmation_challenges"),/permission denied/);
  await assert.rejects(()=>db.reader.query("SELECT nonce FROM economic_confirmation_challenges"),/permission denied/);
  await assert.rejects(()=>db.app.query("INSERT INTO economic_confirmation_consumptions(challenge_id) VALUES($1)",[p.c.challenge_id]),/permission denied/);
  const row=(await db.reader.query("SELECT * FROM economic_confirmation_summary")).rows[0];assert.equal(row.state,"ISSUED");assert(!("nonce" in row));
});

for(const role of readinessRoles) test(`AUD-CONF-01: ${role} LOGIN cannot manufacture terminal rows or bridge audit/consent`,async()=>{
  const p=await issued(),cb=await callback(p);
  for(const table of ["economic_confirmation_challenges","economic_confirmation_consumptions","economic_confirmation_proofs","economic_confirmation_admissions"]) {
    await assert.rejects(()=>db[role].query(`INSERT INTO ${table}(challenge_id) VALUES($1)`,[p.c.challenge_id]),/permission denied/);
    await assert.rejects(()=>db[role].query(`UPDATE ${table} SET challenge_id=challenge_id`),/permission denied/);
  }
  await assert.rejects(()=>db[role].query("INSERT INTO economic_authority_events(event_type,actor) VALUES('CONSENT_ACCEPTED','auth0-confirmation-bridge')"),/permission denied|guarded/);
  await assert.rejects(()=>db[role].query("INSERT INTO economic_consent_evidence(consent_id,session_reference) VALUES($1,$2)",
    [randomUUID(),`zephipay:canonical:${sessionId}`]),/permission denied|guarded/);
  if(role!=="identity") await assert.rejects(()=>db[role].query("SELECT economic_record_confirmation_proof($1,$2)",[p.c.challenge_id,{}]),/permission denied/);
  if(role!=="issuer") await assert.rejects(()=>db[role].query(admitSql,admitArgs(p,cb)),/permission denied/);
  // An issuer database credential cannot invent the missing independent identity attestation.
  await assert.rejects(()=>db.issuer.query(admitSql,[p.c.challenge_id,randomUUID(),sessionId,p.digest,p.c.transaction_id,sha256(cb.body)]),/no rows/);
  assert.equal(await count("economic_confirmation_consumptions"),0);
  assert.equal((await db.reader.query("SELECT state FROM economic_confirmation_summary")).rows[0].state,"ISSUED");
});
test("issuer guarded function succeeds only with separate identity evidence and cannot consume twice",async()=>{
  const p=await issued(),cb=await callback(p),id=await directAdmit(p,cb);
  assert(id);assert.equal(await count("economic_confirmation_admissions"),1);
  await assert.rejects(()=>directAdmit(p,cb),/consumed/);
  assert.equal((await call("recover",ref(p))).consent_id,id);
});
test("guarded admission binds the independent proof to the exact session, envelope, transaction and body",async()=>{
  const p=await issued(),cb=await callback(p);
  for(const [index,value] of [[2,randomUUID()],[3,"00".repeat(32)],[4,randomUUID()],[5,"00".repeat(32)]] as const) {
    const args=admitArgs(p,cb);args[index]=value;
    await assert.rejects(()=>db.issuer.query(admitSql,args),/mismatch/);
  }
  assert.equal(await count("economic_confirmation_admissions"),0);assert.equal(await count("economic_consent_evidence"),0);
});
test("identity proof registration rejects a different transaction in an otherwise verified confirmation body",async()=>{
  const p=await issued(),cb=await callback(p),body=JSON.stringify({...JSON.parse(cb.body),transactionId:randomUUID()}),prior=await count("economic_confirmation_proofs");
  await assert.rejects(()=>proofAuthority.record(p.c.challenge_id,cb.challenge,body,authentication,cb.proof,confirmationEndpoint(),"fixture-nonce"),/evidence rejected/);
  assert.equal(await count("economic_confirmation_proofs"),prior);assert.equal(await count("economic_confirmation_admissions"),0);
});
test("guarded admission rejects an attestation from a retired identity credential generation",async()=>{
  const p=await issued(),cb=await callback(p);
  await admin.query("UPDATE economic_deployment_logins SET credential_generation=2 WHERE authority_role='identity'");
  await assert.rejects(()=>directAdmit(p,cb),/retired proof verifier/);assert.equal(await count("economic_consent_evidence"),0);
});
for(const [name,change] of [
  ["empty JSON",()=>({})],
  ...["authTime","assurance","providerEvidence","nonce","requestDigest","authenticationDigest","policyFingerprint","transactionId"].flatMap(key=>[
    [`missing ${key}`,(v:any)=>{delete v[key];return v;}],
    [`null ${key}`,(v:any)=>({...v,[key]:null})]
  ]),
  ["unapproved assurance",(v:any)=>({...v,assurance:"caller-invented"})],
  ["wrong nonce",(v:any)=>({...v,nonce:"00".repeat(32)})],
  ["wrong transaction",(v:any)=>({...v,transactionId:randomUUID()})],
  ["wrong session",(v:any)=>({...v,accountSessionId:randomUUID()})],
  ["wrong envelope",(v:any)=>({...v,envelopeDigest:"00".repeat(32)})],
  ["stale provider revision",(v:any)=>({...v,providerRevision:999})],
  ["stale configuration",(v:any)=>({...v,configuration:"00".repeat(32)})],
  ["stale policy",(v:any)=>({...v,policyFingerprint:"00".repeat(32)})],
] as [string,(v:any)=>any][]) test(`guarded proof registration rejects ${name}`,async()=>{
  const p=await issued(),cb=await callback(p),before=await count("economic_confirmation_proofs");
  const candidate=change(await evidenceFor(cb));
  await assert.rejects(()=>db.identity.query("SELECT economic_record_confirmation_proof($1,$2)",[p.c.challenge_id,candidate]));
  assert.equal(await count("economic_confirmation_proofs"),before);assert.equal(await count("economic_confirmation_consumptions"),0);
});
// Deliberately malformed pre-existing rows model the audited 028 SQL reproduction; only the fixture administrator can create these after 029.
for(const [name,column,value] of [["empty reauthentication","reauthentication",{}],["wrong account","account_id",null],
  ["stale account version","account_version","999"],["stale provider revision","provider_revision","999"],
  ["stale configuration revision","configuration_revision","999"],["stale configuration fingerprint","configuration","00".repeat(32)],
  ["stale policy version","policy_revision","999"]] as const) test(`guarded terminal admission independently rejects ${name}`,async()=>{
  const p=await issued(),cb=await callback(p);
  const client=await admin.connect();
  try {
    await client.query("BEGIN");await client.query("ALTER TABLE economic_confirmation_challenges DISABLE TRIGGER economic_confirmation_challenges_immutable");
    if(column==="account_id") {
      // Existing CHECK ties principal/account: exercise the DB rejection without weakening it.
      await assert.rejects(()=>client.query("UPDATE economic_confirmation_challenges SET account_id=$1 WHERE challenge_id=$2",[randomUUID(),p.c.challenge_id]));
      await client.query("ROLLBACK");
      await assert.rejects(()=>db.issuer.query(admitSql,[p.c.challenge_id,cb.proofId,randomUUID(),p.digest,p.c.transaction_id,sha256(cb.body)]),/mismatch/);
      return;
    }
    await client.query(`UPDATE economic_confirmation_challenges SET ${column}=$1 WHERE challenge_id=$2`,[value,p.c.challenge_id]);
    await client.query("ALTER TABLE economic_confirmation_challenges ENABLE TRIGGER economic_confirmation_challenges_immutable");await client.query("COMMIT");
  } finally {await client.query("ROLLBACK");client.release();}
  await assert.rejects(()=>directAdmit(p,cb),/malformed|invalidated/);assert.equal(await count("economic_consent_evidence"),0);
});
test("guarded terminal operation rejects expired and invalidated challenges without service checks",async()=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,challengeSeconds:3});await registerConfirmationPolicy(admin,policy);rebuild();
  const p=await issued(),cb=await callback(p);await waitForDatabaseDeadline(p.c.expires_at);
  await assert.rejects(()=>directAdmit(p,cb),/expired/);
  policy=confirmationPolicyFixture(f.configuration,{revision:3});await registerConfirmationPolicy(admin,policy);rebuild();
  const q=await issued(),cq=await callback(q);await revoke();await assert.rejects(()=>directAdmit(q,cq),/ineligible/);
});
test("AUD-CONF-02: SET CONSTRAINTS early then late commit preserves admission history but grants no usable consent",async()=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,challengeSeconds:3});await registerConfirmationPolicy(admin,policy);rebuild();
  const p=await issued(),cb=await callback(p),client=await db.issuer.connect();let id!:string;
  try {
    await client.query("BEGIN");id=(await client.query(admitSql,admitArgs(p,cb))).rows[0].id;
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");await waitForDatabaseDeadline(p.c.expires_at);await client.query("COMMIT");
  } finally {await client.query("ROLLBACK");client.release();}
  const c=(await admin.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[id])).rows[0];
  assert(c.confirmed_at<new Date(p.c.expires_at));assert(c.expires_at<=new Date(p.c.expires_at));
  assert((await admin.query("SELECT $1::timestamptz<clock_timestamp() AS expired",[c.expires_at])).rows[0].expired);
  assert.equal((await call("recover",ref(p))).state,"CONFIRMED");
  // This exact authority loader is used by both repository claim/sponsor-finalization and first-contact paths before signer invocation.
  await assert.rejects(()=>transaction(db.app,async cl=>loadAuthoritativeEvidence(cl,p.envelope,id,evidence,await databaseTime(cl))),/consent/);
  await assert.rejects(()=>directAdmit(p,cb),/expired/);
  assert.equal(await count("economic_finalizations"),0);assert.equal(await count("economic_signer_contact_authority"),0);
});
for(let repetition=1;repetition<=3;repetition++) test(`guarded admission rejects account-version advancement while waiting ${repetition}`,async()=>{
  const p=await issued(),cb=await callback(p),client=await db.identity.connect();
  try {
    await client.query("BEGIN");await createAccountSessionInTransaction(client,{accountId,sessionId:randomUUID(),expectedAccountVersion:version,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
    const rejected=assert.rejects(()=>directAdmit(p,cb),/invalidated/);await pause(80);await client.query("COMMIT");await rejected;
  } finally {await client.query("ROLLBACK");client.release();}
  assert.equal(await count("economic_confirmation_admissions"),0);
});
test("expired bridge consent defeats fresh Runtime evidence and first-contact/signing authority independently",async()=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,consentSeconds:2});await registerConfirmationPolicy(admin,policy);rebuild();
  const p=await issued(),cb=await callback(p),consentId=await directAdmit(p,cb),id=randomUUID();
  let signerCalls=0;
  const stoppedSigner={async finalize(){signerCalls++;throw new Error("No signing permitted");},async query(){signerCalls++;throw new Error("No signer query permitted");}};
  const guardedRepo=new PostgresFinalizationRepository(db.app,evidence,stoppedSigner,undefined,{signerResults:db.signer});
  try {
    // Privileged fixture models an existing pre-contact operation. No customer/sponsor transaction is signed or inspected as valid.
    // Fresh Runtime evidence deliberately cannot substitute for the expired consent gate.
    const e=p.envelope;
    await db.issuer.query(`INSERT INTO economic_runtime_evidence(decision_id,envelope_digest,issuer,policy_version,evidence_digest,binding,network,scope,valid_from,valid_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[e.runtime.decisionId,p.digest,evidence.runtimeIssuer,e.runtime.policyVersion,e.runtime.evidenceDigest,
      {schema:"zephyon.runtime-binding/v1",reference:e.runtime,envelopeDigest:p.digest,result:"approved"},e.amount.asset.network,e.runtime.scope,e.runtime.validFrom,e.runtime.validUntil]);
    await registry.installBudget({id:"confirmation-expiry-fixture",network:e.amount.asset.network,sponsorPublicKey:e.fee.signer,sponsorKeyVersion:e.fee.keyVersion,
      base:"1000000",priority:"1000000",rent:"10000000",outstanding:2});
    const a=(await admin.query("SELECT * FROM economic_attempts WHERE envelope_digest=$1",[p.digest])).rows[0];
    const tuple=createSponsorFinalizationTupleV1({schema:"zephyon.sponsor-finalization/v1",attempt:e.attempt,network:e.amount.asset.network,messageDigest:a.message_digest,
      requiredSigners:[e.fee.signer,e.source.signer],userSigner:e.source.signer,customerSignatureDigest:"ab".repeat(32),sponsorPublicKey:e.fee.signer,sponsorKeyVersion:e.fee.keyVersion,
      envelopeDigest:p.digest,consentId,runtime:e.runtime,reservedExposureId:a.requested_exposure_id});
    const assets=(await admin.query("SELECT registry_id,use_role FROM economic_asset_registry")).rows;
    await transaction(admin,async client=>{
      await client.query(`INSERT INTO economic_finalizations(finalization_id,intent_id,generation,tuple,tuple_digest,consent_id,runtime_id,payment_registry_id,fee_registry_id,
        budget_id,budget_version,exposure_id,base_requested,priority_requested,rent_requested,signer_operation_id,customer_artifact)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmation-expiry-fixture',1,$10,$11,$12,$13,$14,$15)`,
        [id,e.attempt.intentId,e.attempt.generation,tuple,sponsorTupleDigestV1(tuple),consentId,e.runtime.decisionId,assets.find(v=>v.use_role==="PAYMENT").registry_id,
          assets.find(v=>v.use_role==="FEE").registry_id,a.requested_exposure_id,e.fee.maxBaseFee,e.fee.maxPriorityFee,e.fee.maxRent,randomUUID(),Buffer.from([1])]);
      await client.query("UPDATE economic_attempts SET state='FINALIZATION_COMMITTED',finalization_id=$1 WHERE envelope_digest=$2",[id,p.digest]);
    });
    const c=(await admin.query("SELECT expires_at FROM economic_consent_evidence WHERE consent_id=$1",[consentId])).rows[0];
    await waitForDatabaseDeadline(c.expires_at);
    await assert.rejects(()=>transaction(db.app,async client=>loadAuthoritativeEvidence(client,e,consentId,evidence,await databaseTime(client))),/consent/);
    await assert.rejects(()=>db.app.query("SELECT economic_commit_signer_contact($1)",[id]),/expired or revoked/);
    await assert.rejects(()=>guardedRepo.recover(id),/consent/);
    assert.equal(signerCalls,0);assert.equal(await count("economic_signer_contact_authority"),0);
    const state=(await admin.query("SELECT signer_state,result_artifact FROM economic_finalizations WHERE finalization_id=$1",[id])).rows[0];
    assert.equal(state.signer_state,"NOT_CONTACTED");assert.equal(state.result_artifact,null);
  } finally {await admin.query("TRUNCATE economic_runtime_evidence CASCADE");}
});
for(const isolation of ["READ COMMITTED","REPEATABLE READ"] as const) test(`guarded admission rechecks attempt state after a cancellation lock wait (${isolation})`,async()=>{
  const p=await issued(),cb=await callback(p),locker=await db.app.connect(),issuer=await db.issuer.connect();
  try {
    const pid=(await issuer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await locker.query("BEGIN");await locker.query("SELECT intent_id FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE",[p.envelope.attempt.intentId]);
    await locker.query("UPDATE economic_attempts SET state='CANCELLED' WHERE envelope_digest=$1",[p.digest]);
    await issuer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const denied=assert.rejects(()=>issuer.query(admitSql,admitArgs(p,cb)),/ineligible|could not serialize/);
    let waiting=false;
    for(let i=0;i<50;i++) {
      waiting=(await admin.query("SELECT cardinality(pg_blocking_pids($1))>0 AS waiting",[pid])).rows[0].waiting;
      if(waiting)break;await pause(10);
    }
    assert(waiting,"guarded admission must reach the canonical lock wait");await locker.query("COMMIT");await denied;
    assert.equal(await count("economic_confirmation_admissions"),0);assert.equal(await count("economic_consent_evidence"),0);
  } finally {await locker.query("ROLLBACK");await issuer.query("ROLLBACK");locker.release();issuer.release();}
});

function sdkAdapter(web: ReturnType<typeof auth0SdkHostFixture>) {
  return new Auth0SdkConfirmationAdapter(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("identity",db.identity,expected("identity")),f.configuration,endpointKeys.publicKey),f.auth),policy,web.host,web.callbackUrl);
}
async function sdkStart() {
  const web=auth0SdkHostFixture(), adapter=sdkAdapter(web);
  await web.login();const initial=web.readSession;
  await adapter.bindExistingSession(sessionId,initial,confirmationEndpoint(),"fixture-nonce");
  authentication=await f.auth.verifyAccess((await initial())!.tokenSet.accessToken,"confirm:economic");
  const p=await issued();
  const started=await adapter.start(p.c.challenge_id,initial,confirmationEndpoint(),"fixture-nonce");web.save(started.response);
  const challenge=(await call("roundtrip",ref(p))).reauthentication as ReauthenticationChallenge;
  const clock=await waitForPostgresPast(admin,new Date(challenge.requestedAt*1000).toISOString());
  return {p,web,adapter,initial,started,challenge,clock};
}
async function sdkCallback(s: Awaited<ReturnType<typeof sdkStart>>,claims:Record<string,unknown>={}) {
  return s.adapter.callback(s.web.request(claims),confirmationEndpoint(),"fixture-nonce");
}
async function sdkProof(s: Awaited<ReturnType<typeof sdkStart>>) {
  return s.adapter.prepareConfirmation(s.started.bindingId,s.web.readSession,confirmationEndpoint(),"fixture-nonce");
}
async function sdkAdmit(proof: Awaited<ReturnType<typeof sdkProof>>) {
  const path="/confirmation/confirm", generated=JSON.parse(sender.request("issuer","POST",path,proof.body).payload);
  const invocation=signedFixture({...generated,issuedAt:generated.issuedAt-1,expiresAt:generated.expiresAt-1},serviceKeys.identity.privateKey);
  return bridge.execute(path,proof.body,invocation,confirmationEndpoint(),"fixture-nonce",proof.authentication,proof.reauthentication,proof.proofId);
}

test("real SDK: distinct nonces, canonical binding, explicit guarded confirmation and reconstruction",async t=>{
  const s=await sdkStart();t.diagnostic(JSON.stringify(s.clock));
  const nonce=s.web.authorize().searchParams.get("nonce");assert.notEqual(nonce,s.challenge.nonce);
  const before=(await admin.query("SELECT * FROM economic_confirmation_challenges")).rows;
  assert.equal((await sdkCallback(s)).status,303);assert.equal(s.web.successfulHooks(),1);
  assert.equal(await count("economic_consent_evidence"),0);
  // Reconstruct both verifier and SDK host; only durable rows and the real encrypted SDK session survive.
  f=await readyFixture(profileFixture({databaseName}));authentication=await f.auth.verifyAccess(await accessFixture({scope:"confirm:economic"}),"confirm:economic");rebuild();s.adapter=sdkAdapter(s.web);
  const proof=await sdkProof(s), retry=await sdkProof(s);assert.equal(retry.proofId,proof.proofId);
  const result=await sdkAdmit(proof);assert.equal(JSON.parse(result.body).state,"CONFIRMED");
  assert.equal(await count("economic_confirmation_admissions"),1);assert.equal(await count("economic_consent_evidence"),1);
  const bound=(await admin.query("SELECT * FROM economic_confirmation_sdk_transactions")).rows[0];
  const dbProof=(await admin.query("SELECT * FROM economic_confirmation_proofs")).rows[0];
  assert.equal(bound.context.challenge.nonce,s.challenge.nonce);assert.equal(bound.sdk_nonce,nonce);
  assert.equal(bound.context.challenge.account_session_id,sessionId);assert.equal(bound.context.challenge.envelope_digest,s.p.digest);
  assert.equal(bound.context.challenge.environment,"offline-fixture");assert.equal(bound.context.clientId,f.configuration.profile.clientId);
  assert.equal(dbProof.nonce,s.challenge.nonce);assert.equal(dbProof.sdk_binding_id,s.started.bindingId);
  assert.deepEqual((await admin.query("SELECT * FROM economic_confirmation_challenges")).rows,before);
  await assert.rejects(()=>sdkAdmit(proof));
  assert.equal((await call("recover",ref(s.p))).state,"CONFIRMED"); // Lost issuer response recovery.
  for(const table of ["economic_confirmation_sdk_transactions","economic_confirmation_sdk_callbacks"])
    assert(!JSON.stringify((await admin.query(`SELECT * FROM ${table}`)).rows).includes(s.web.providerTokens().idToken));
});
for(const failure of ["state","cookie","nonce","PKCE","issuer","audience","expired token"] as const)
  test(`real SDK: rejects ${failure} before successful callback attestation`,async()=>{
    const s=await sdkStart();const claims:Record<string,unknown>={};let changes:{}={};
    if(failure==="state") changes={state:"wrong-state"};
    if(failure==="cookie") changes={cookie:""};
    if(failure==="nonce") claims.nonce="wrong-provider-nonce";
    if(failure==="PKCE") s.web.rejectPkce();
    if(failure==="issuer") claims.iss="https://foreign.example/";
    if(failure==="audience") claims.aud="wrong-client";
    if(failure==="expired token") claims.exp=Math.floor(Date.now()/1000)-120;
    await assert.rejects(()=>s.adapter.callback(s.web.request(claims,changes),confirmationEndpoint(),"fixture-nonce"));
    assert.equal(s.web.successfulHooks(),0);assert.equal(await count("economic_confirmation_sdk_callbacks"),0);
    assert.equal(await count("economic_confirmation_proofs"),0);
  });
for(const [label,claims] of [["wrong subject",{sub:"subject:bob"}],["missing auth_time",{auth_time:undefined}],
  ["silent old SSO",{auth_time:Math.floor(Date.now()/1000)-60}],["missing assurance",{acr:undefined}],["unapproved assurance",{acr:"password-only"}]] as const)
  test(`real SDK: no canonical callback for ${label}`,async()=>{
    const s=await sdkStart();await assert.rejects(()=>sdkCallback(s,claims));
    assert.equal(await count("economic_confirmation_sdk_callbacks"),0);assert.equal(await count("economic_consent_evidence"),0);
  });
test("real SDK: durable callback replay fails with the original encrypted transaction cookie",async()=>{
  const s=await sdkStart(), originalCookie=s.web.cookie();await sdkCallback(s);
  await assert.rejects(()=>s.adapter.callback(s.web.request({}, {cookie:originalCookie}),confirmationEndpoint(),"fixture-nonce"));
  assert.equal(await count("economic_confirmation_sdk_callbacks"),1);assert.equal(await count("economic_consent_evidence"),0);
});
test("real SDK: signed ID token alone cannot register a bound proof before a validated callback",async()=>{
  const s=await sdkStart(), raw=await accessFixture({aud:f.configuration.profile.clientId,iat:s.challenge.requestedAt,auth_time:s.challenge.requestedAt,
    nonce:s.web.authorize().searchParams.get("nonce"),acr:"fixture:mfa"});
  const proof=await f.auth.verifySdkReauthentication(raw,s.challenge,s.web.authorize().searchParams.get("nonce")!,s.started.bindingId);
  const body=JSON.stringify({accountSessionId:sessionId,authenticationDigest:authentication.tokenDigest,...ref(s.p),action:"confirm-economic-intent",reauthenticationDigest:sha256(raw)});
  await assert.rejects(()=>proofAuthority.record(s.p.c.challenge_id,s.challenge,body,authentication,proof,confirmationEndpoint(),"fixture-nonce"),/Durable SDK/);
  await assert.rejects(()=>callback(s.p)); // Legacy canonical-nonce path cannot bypass the callback requirement.
  assert.equal(await count("economic_confirmation_proofs"),0);
});
test("real SDK: another canonical challenge cannot reuse this callback or token",async()=>{
  const s=await sdkStart();await sdkCallback(s);const other=await issued();
  const proof=await sdkProof(s);
  await assert.rejects(()=>call("confirm",{...ref(other),action:"confirm-economic-intent",reauthenticationDigest:sha256(s.web.providerTokens().idToken)},
    proof.reauthentication),/substituted/);
  const otherWeb=auth0SdkHostFixture(), otherAdapter=sdkAdapter(otherWeb);
  const otherStart=await otherAdapter.start(other.c.challenge_id,s.web.readSession,confirmationEndpoint(),"fixture-nonce");
  await assert.rejects(()=>otherAdapter.prepareConfirmation(otherStart.bindingId,s.web.readSession,confirmationEndpoint(),"fixture-nonce"),/Durable SDK/);
});
for(const phase of ["callback","confirmation"] as const) for(const invalidation of ["session revocation","account version","policy","provider revision"] as const)
  test(`real SDK: ${invalidation} invalidates ${phase}`,async()=>{
    const s=await sdkStart();if(phase==="confirmation") await sdkCallback(s);
    if(invalidation==="session revocation") await revoke();
    if(invalidation==="account version") await identities.createAccountSession({accountId,sessionId:randomUUID(),expectedAccountVersion:version,
      createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
    if(invalidation==="policy") await registerConfirmationPolicy(admin,confirmationPolicyFixture(f.configuration,{revision:2}));
    if(invalidation==="provider revision") await admin.query("UPDATE economic_deployment_identity SET provider_key_revision=2");
    await assert.rejects(()=>phase==="callback" ? sdkCallback(s) : sdkProof(s));
    assert.equal(await count("economic_consent_evidence"),0);
  });
test("real SDK: database-observed expired challenge cannot accept a late callback",async t=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,challengeSeconds:8});await registerConfirmationPolicy(admin,policy);rebuild();
  const s=await sdkStart();t.diagnostic(JSON.stringify(await waitForPostgresPast(admin,s.p.c.expires_at)));
  await assert.rejects(()=>sdkCallback(s));assert.equal(await count("economic_confirmation_sdk_callbacks"),0);
});
test("SDK durable tables are append-only and excluded from operational direct privileges",async()=>{
  const s=await sdkStart();await sdkCallback(s);
  for(const pool of Object.values(db)) for(const table of ["economic_confirmation_sdk_transactions","economic_confirmation_sdk_callbacks"])
    await assert.rejects(()=>pool.query(`SELECT * FROM ${table}`),/permission/);
  for(const table of ["economic_confirmation_sdk_transactions","economic_confirmation_sdk_callbacks"])
    await assert.rejects(()=>admin.query(`DELETE FROM ${table}`),/append.only/i);
  for(const role of readinessRoles) if(role!=="identity") await assert.rejects(()=>db[role].query(
    "SELECT economic_read_confirmation_sdk($1,$2)",[s.started.bindingId,authentication]),/permission/);
});

test("real SDK: an authenticated session cannot select an unbound or different canonical session",async()=>{
  const secondId=randomUUID();version=(await identities.createAccountSession({accountId,sessionId:secondId,expectedAccountVersion:version,
    createdAt:new Date(Date.now()-5000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()})).account.version;
  const p=await issued(),web=auth0SdkHostFixture(),adapter=sdkAdapter(web);await web.login();
  await assert.rejects(()=>adapter.start(p.c.challenge_id,web.readSession,confirmationEndpoint(),"fixture-nonce"),/SDK transaction binding rejected/);
  await adapter.bindExistingSession(secondId,web.readSession,confirmationEndpoint(),"fixture-nonce");
  await assert.rejects(()=>adapter.start(p.c.challenge_id,web.readSession,confirmationEndpoint(),"fixture-nonce"),/SDK transaction binding rejected/);
  await assert.rejects(()=>adapter.bindExistingSession(sessionId,web.readSession,confirmationEndpoint(),"fixture-nonce"),/rebound/);
  assert.equal(await count("economic_confirmation_sdk_transactions"),0);
});

test("real SDK: encrypted returnTo for another transaction cannot select its challenge",async()=>{
  const s=await sdkStart(), other=await issued(), web=auth0SdkHostFixture();await web.login();
  const originalHost=web.host;
  const adapter=sdkAdapter({...web,host:onCallback=>{
    const sdk=originalHost(onCallback);
    return {...sdk,start:()=>sdk.start(`/confirmation/auth0/result?binding=${s.started.bindingId}`)};
  }});
  await adapter.bindExistingSession(sessionId,web.readSession,confirmationEndpoint(),"fixture-nonce");
  const started=await adapter.start(other.c.challenge_id,web.readSession,confirmationEndpoint(),"fixture-nonce");web.save(started.response);
  await assert.rejects(()=>adapter.callback(web.request(),confirmationEndpoint(),"fixture-nonce"),/transaction substitution/);
  assert.equal(await count("economic_confirmation_sdk_callbacks"),0);
});
test("real SDK: exact canonical body survives neither session, envelope, challenge nor action substitution",async()=>{
  const s=await sdkStart();await sdkCallback(s);const proof=await sdkProof(s);
  for(const change of [{accountSessionId:randomUUID()},{envelopeDigest:"ff".repeat(32)},{challengeId:randomUUID()},
    {transactionId:randomUUID()},{action:"approve-payment"}])
    await assert.rejects(()=>sdkAdmit({...proof,body:JSON.stringify({...JSON.parse(proof.body),...change})}));
  assert.equal(await count("economic_consent_evidence"),0);
  assert.equal(JSON.parse((await sdkAdmit(proof)).body).state,"CONFIRMED");
});

// Metadata-only preparation reuses actual payment persistence and the accepted SDK/guarded issuer.
async function paymentPreparationFixture(runtime?: import("../src/economic/preparation/paymentEnvelopePreparation").PaymentPreparationProfile["runtime"]) {
  const { PostgresPaymentPersistence } = await import("../src/storage/postgres/postgresPaymentPersistence");
  const { devnetPreparationPolicy } = await import("../src/devnet/devnetPreparationPolicy");
  const { PaymentEnvelopePreparation } = await import("../src/economic/preparation/paymentEnvelopePreparation");
  const { bindEconomicSession } = await import("../src/economic/foundation/sessionAuthority");
  const devnet=fixture.devnetEnvelope, now=Date.now();
  await admin.query("INSERT INTO beta_allowlist(actor_subject) VALUES($1) ON CONFLICT DO NOTHING",[principalId]);
  const payments=new PostgresPaymentPersistence(admin);
  const created=await payments.claimIdempotencyKey({id:randomUUID(),actorSubject:principalId,idempotencyKey:randomUUID(),requestHash:"ab".repeat(32),
    network:"solana-devnet",rail:"solana",asset:"USDC",mintAddress:fixture.qualifiedAsset.mint,recipientAddress:devnet.recipient.wallet,
    amountRaw:1000000n,purpose:"Controlled preparation",recipientType:"DIRECT_WALLET"});
  await admin.query("INSERT INTO economic_payment_preparation_profiles(principal_id,profile) VALUES($1,$2) ON CONFLICT DO NOTHING",[principalId,{
    mode:"controlled-non-value",attestation:"TEST",asset:fixture.qualifiedAsset,lifetimeSeconds:300,
    devnetPolicy:devnetPreparationPolicy({mint:fixture.qualifiedAsset.mint,decimals:6,sourceTokenAccount:devnet.source.account,
      signerKeyId:devnet.source.bindingId,signerKeyVersion:devnet.fee.keyVersion,signerPublicKey:devnet.source.signer,
      submissionProviderId:"TEST:submission",reconciliationProviderId:"TEST:reconciliation"}),fee:devnet.fee,
    runtime:runtime??{policyVersion:"policy-v1",evidenceDigest:devnet.runtime.evidenceDigest,scope:"devnet-test-only",
      validFrom:new Date(now-60000).toISOString(),validUntil:new Date(now+600000).toISOString()}}]);
  await transaction(db.identity,client=>bindEconomicSession(client,{issuer:authentication.issuer,providerSubject:authentication.subject,
    providerSessionReference:"TEST:prepared-session",accountSessionId:sessionId}));
  const make=()=>new PaymentEnvelopePreparation(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("app",db.app,expected("app")),f.configuration,endpointKeys.publicKey),f.auth));
  const run=(service=make(),reference="TEST:prepared-session")=>service.prepare(created.payment.id,authentication,reference,confirmationEndpoint(),"fixture-nonce");
  return {payment:created.payment,make,run};
}

test("payment preparation: durable duplicate, concurrent and lost-response recovery use one envelope without a transaction",async()=>{
  const p=await paymentPreparationFixture();
  const rows=await Promise.all([p.run(),p.run(),p.run()]);
  assert.deepEqual(rows[1],rows[0]);assert.deepEqual(rows[2],rows[0]);
  assert.deepEqual(await p.run(p.make()),rows[0],"fresh service recovers committed response");
  assert.equal(await count("economic_payment_preparations"),1);
  assert.equal(await count("economic_envelopes"),1);
  assert.equal(await count("economic_attempts"),0,"no message, blockhash or exposure record");
  assert.equal(rows[0].envelope.amount.atomicUnits,"1000000");
  assert.equal(rows[0].envelope.purpose.reference,p.payment.id);
  assert.equal(rows[0].envelope.source.mode,"devnet-server");
  assert.equal((await admin.query("SELECT status FROM payments WHERE id=$1",[p.payment.id])).rows[0].status,"AWAITING_CONFIRMATION");
});
for(const column of ["recipient_address","amount_raw","purpose","mint_address"] as const) {
  test(`payment preparation: immutable ${column} and direct binding substitution rejected`,async()=>{
    const p=await paymentPreparationFixture(), prepared=await p.run();
    const replacement=column==="amount_raw"?"2":column==="recipient_address"?fixture.envelope.source.signer:"conflicting-value";
    await assert.rejects(()=>admin.query(`UPDATE payments SET ${column}=$2 WHERE id=$1`,[p.payment.id,replacement]),/prepared payment/);
    await assert.rejects(()=>db.app.query("UPDATE economic_envelopes SET envelope=envelope||'{}'::jsonb WHERE envelope_digest=$1",[prepared.envelopeDigest]));
    assert.deepEqual(await p.run(),prepared);
  });
}
test("payment preparation: another account, unknown session and stale payment are rejected",async()=>{
  const p=await paymentPreparationFixture();
  await assert.rejects(()=>p.run(p.make(),"TEST:unknown-session"),/session binding/);
  const stranger=await f.auth.verifyAccess(await accessFixture({sub:"subject:stranger",scope:"confirm:economic"}),"confirm:economic");
  await assert.rejects(()=>p.make().prepare(p.payment.id,stranger,"TEST:prepared-session",confirmationEndpoint(),"fixture-nonce"),/identity/);
  await admin.query("UPDATE payments SET user_confirmed_at=clock_timestamp(),version=version+1 WHERE id=$1",[p.payment.id]);
  await assert.rejects(()=>p.run(),/no longer eligible/);
  assert.equal(await count("economic_payment_preparations"),0);
});
test("payment preparation: another canonical session cannot claim or confirm the existing binding",async()=>{
  const p=await paymentPreparationFixture(), prepared=await p.run(), other=randomUUID();
  await identities.createAccountSession({accountId,sessionId:other,expectedAccountVersion:version,
    createdAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString()});
  const {bindEconomicSession}=await import("../src/economic/foundation/sessionAuthority");
  await transaction(db.identity,client=>bindEconomicSession(client,{issuer:authentication.issuer,providerSubject:authentication.subject,
    providerSessionReference:"TEST:other-session",accountSessionId:other}));
  await assert.rejects(()=>p.run(p.make(),"TEST:other-session"),/session conflict/);
  await assert.rejects(()=>call("start",{accountSessionId:other,envelopeDigest:prepared.envelopeDigest,requestId:randomUUID()}),/session mismatch/);
});
test("payment preparation: exact prepared envelope reaches real SDK and guarded confirmation without transaction registration",async()=>{
  const p=await paymentPreparationFixture(), prepared=await p.run();
  const web=auth0SdkHostFixture(), adapter=sdkAdapter(web);await web.login();
  await adapter.bindExistingSession(sessionId,web.readSession,confirmationEndpoint(),"fixture-nonce");
  authentication=await f.auth.verifyAccess((await web.readSession())!.tokenSet.accessToken,"confirm:economic");
  const c=await start(prepared.envelopeDigest), started=await adapter.start(c.challenge_id,web.readSession,confirmationEndpoint(),"fixture-nonce");
  web.save(started.response);
  const challenge=(await call("roundtrip",{envelopeDigest:prepared.envelopeDigest,challengeId:c.challenge_id,transactionId:c.transaction_id})).reauthentication;
  await waitForPostgresPast(admin,new Date(challenge.requestedAt*1000).toISOString());
  assert.equal((await adapter.callback(web.request(),confirmationEndpoint(),"fixture-nonce")).status,303);
  assert.equal(await count("economic_consent_evidence"),0,"callback is not consent");
  const proof=await adapter.prepareConfirmation(started.bindingId,web.readSession,confirmationEndpoint(),"fixture-nonce");
  assert.equal(JSON.parse((await sdkAdmit(proof)).body).state,"CONFIRMED");
  assert.equal((await call("recover",{envelopeDigest:prepared.envelopeDigest,challengeId:c.challenge_id,transactionId:c.transaction_id},undefined,proof.authentication)).state,"CONFIRMED");
  assert.equal(await count("economic_attempts"),0);
  assert.equal((await admin.query("SELECT envelope_digest FROM economic_consent_evidence")).rows[0].envelope_digest,prepared.envelopeDigest);
  assert.deepEqual(await transaction(db.issuer,client=>import("../src/economic/foundation/evidenceIngestion").then(m=>m.loadEnvelope(client,prepared.envelopeDigest))),prepared.envelope,
    "future Runtime consumer loads the identical Protocol object");
});
for(const field of ["amount","recipient","purpose"] as const) test(`payment preparation: future transaction registration cannot change confirmed ${field}`,async()=>{
  const p=await paymentPreparationFixture(), prepared=await p.run();
  const candidate=structuredClone(prepared.envelope) as any;
  if(field==="amount") candidate.amount.atomicUnits="2000000";
  if(field==="recipient") candidate.recipient.wallet=fixture.envelope.source.signer;
  if(field==="purpose") candidate.purpose.reference="different-payment";
  const {authorizationBindingDigestV1}=await import("zephyon-protocol");
  const changed=createEconomicIntentEnvelopeV1(candidate,candidate.amount.asset);
  // Deliberately rejected SQL input only. Never construct or persist an execution transaction.
  await assert.rejects(()=>db.app.query(`INSERT INTO economic_attempts(intent_id,generation,attempt_id,fence_token,envelope_digest,envelope,
    message_digest,recent_blockhash,requested_exposure_id) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8)`,
    [changed.attempt.intentId,changed.attempt.attemptId,changed.attempt.fenceToken,authorizationBindingDigestV1(changed,changed.amount.asset),changed,
      "ee".repeat(32),fixture.recentBlockhash,randomUUID()]),/conflicts with prepared envelope/);
  assert.equal(await count("economic_attempts"),0);
  assert.deepEqual(await p.run(),prepared);
});
test("payment preparation: a second payment cannot reuse an existing envelope",async()=>{
  const first=await paymentPreparationFixture(), prepared=await first.run(), second=await paymentPreparationFixture();
  const snapshot=(await admin.query("SELECT economic_payment_snapshot(p) AS snapshot FROM payments p WHERE id=$1",[second.payment.id])).rows[0].snapshot;
  await assert.rejects(()=>db.app.query(`INSERT INTO economic_payment_preparations(payment_id,account_session_id,envelope_digest,payment_snapshot)
    VALUES($1,$2,$3,$4)`,[second.payment.id,sessionId,prepared.envelopeDigest,snapshot]),/binding mismatch/);
  assert.equal(await count("economic_payment_preparations"),1);
});
test("payment preparation: no operational role gains configuration, terminal or canonical state authority",async()=>{
  const p=await paymentPreparationFixture();await p.run();
  for(const role of readinessRoles) {
    await verifyAuthorityLogin(db[role],role,{deployment:expected(role),syntheticFixtures:true});
    await assert.rejects(()=>db[role].query("UPDATE economic_payment_preparation_profiles SET profile=profile"));
    await assert.rejects(()=>db[role].query("UPDATE economic_envelopes SET state='FINALIZATION_COMMITTED'"));
    if(role!=="app") await assert.rejects(()=>db[role].query("INSERT INTO economic_payment_preparations DEFAULT VALUES"));
  }
  await assert.rejects(()=>db.app.query("INSERT INTO economic_confirmation_consumptions DEFAULT VALUES"));
  await assert.rejects(()=>db.app.query("INSERT INTO economic_confirmation_admissions DEFAULT VALUES"));
  await assert.rejects(()=>db.app.query("INSERT INTO economic_signer_contact_authority DEFAULT VALUES"));
});

// Cross-repository vertical slice deliberately imports the candidate Site implementation.
// Set CONTROLLED_SITE_SOURCE to its checkout; no copied SDK validation or mocked callback success.
async function controlledWebFixture(http=false,withRuntime=false) {
  const source=process.env.CONTROLLED_SITE_SOURCE;
  assert(source,"CONTROLLED_SITE_SOURCE must identify the reviewed Site checkout for the cross-repository non-value regression");
  const site=await import(`${source}/src/lib/controlledConfirmation/sdkFlow.ts`);
  const sessions=await import(`${source}/src/lib/controlledConfirmation/session.ts`);
  const {NextRequest}=await import("next/server.js");
  const {ControlledWebConfirmation}=await import("../src/economic/web/controlledWebConfirmation");
  const contract=await import("../src/economic/web/handoffContract");
  const {generateKeyPairSync}=await import("node:crypto");
  const siteKeys=generateKeyPairSync("ed25519"),responseKeys=generateKeyPairSync("ed25519");
  let runtime:import("../src/economic/preparation/paymentEnvelopePreparation").PaymentPreparationProfile["runtime"]|undefined;
  if(withRuntime) {
    const {registerRuntimeTestProfile}=await import("../src/economic/runtime/runtimeTestProfile");
    const now=(await admin.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime(),effectiveFrom=new Date(now-60000).toISOString(),expiresAt=new Date(now+600000).toISOString();
    const registered=await registerRuntimeTestProfile(admin,f.configuration,{qualifiedAsset:fixture.qualifiedAsset,policyVersion:"controlled-web-runtime-1",effectiveFrom,expiresAt,maxAtomicUnits:"2000000"});
    runtime={policyVersion:registered.profile.policyVersion,evidenceDigest:registered.profileDigest,scope:"devnet-test-only",validFrom:effectiveFrom,validUntil:expiresAt};
  }
  const p=await paymentPreparationFixture(runtime),web=auth0SdkHostFixture(sessions.withWebSessionReference);await web.login();
  const {RuntimePolicyAdapter}=await import("../src/economic/runtime/runtimePolicyAdapter");
  const context={environment:f.configuration.profile.environment,configuration:f.configuration.fingerprint,siteOrigin:"http://localhost:3000",backendOrigin:"http://localhost:3001",clientId:policy.policy.clientId,issuer:policy.policy.issuer};
  const make=()=>new ControlledWebConfirmation(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("identity",db.identity,expected("identity")),f.configuration,endpointKeys.publicKey),f.auth),policy,context,siteKeys.publicKey,responseKeys.privateKey,
    ()=>({artifact:confirmationEndpoint(),nonce:"fixture-nonce"}),{
      prepare:(id,auth,reference)=>p.make().prepare(id,auth,reference,confirmationEndpoint(),"fixture-nonce"),
      challenge:(prepared,auth,requestId)=>call("start",{accountSessionId:prepared.accountSessionId,envelopeDigest:prepared.envelopeDigest,requestId},undefined,auth),
      admit:async proof=>{await sdkAdmit(proof);},
      ...(withRuntime?{runtime:(action:import("../src/economic/runtime/controlledRuntimeResult").ControlledRuntimeAction,ref:{paymentId:string;challengeId:string},auth:Auth0Authentication,reference:string)=>
        new RuntimePolicyAdapter(new ProviderDeploymentReadiness(new DeploymentReadiness(new AuthorityProcess("issuer",db.issuer,expected("issuer")),f.configuration,endpointKeys.publicKey),f.auth))
          .controlled(action,ref,auth,reference,confirmationEndpoint(),"fixture-nonce")}:{})
    },"controlled-non-value");
  let service=make();
  if(http) {
    const {createControlledWebApplication}=await import("../src/economic/web/application");
    const app=createControlledWebApplication({handle:(action,request)=>service.handle(action,request)});
    const server=app.listen(0,"localhost");webServers.push(server);
    await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
    context.backendOrigin=`http://localhost:${(server.address() as import("node:net").AddressInfo).port}`;
    service=make();
  }
  const packet=(action:import("../src/economic/web/handoffContract").ControlledAction,body:import("../src/economic/web/handoffContract").HandoffBody)=>{
    const generated=contract.signWebRequest(context,action,body,siteKeys.privateKey),m=JSON.parse(generated.payload);
    // Backward clock evidence belongs to existing host; keep issue time one second behind DB without changing any guard.
    return signedFixture({...m,issuedAt:m.issuedAt-1,expiresAt:m.expiresAt-1},siteKeys.privateKey);
  };
  const backendFetch=globalThis.fetch;
  const callWeb=async(action:import("../src/economic/web/handoffContract").WebAction,body:import("../src/economic/web/handoffContract").HandoffBody)=>{
    const request=packet(action,body);
    let response: import("../src/economic/web/handoffContract").Handoff;
    if(http) {
      const result=await backendFetch(`${context.backendOrigin}/internal/controlled-confirmation/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});
      assert.equal(result.status,200);response=await result.json() as typeof response;
    } else response=await service.handle(action,request);
    return contract.verifyWebResponse(request,response,responseKeys.publicKey);
  };
  const body=async()=>({paymentId:p.payment.id,session:sessions.toWebSession(await web.readSession())});
  const callRuntime=async(action:import("../src/economic/runtime/controlledRuntimeResult").ControlledRuntimeAction)=>{
    const request=packet(action,await body());
    const response=await backendFetch(`${context.backendOrigin}/internal/controlled-confirmation/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});
    assert.equal(response.status,200);
    return contract.verifyRuntimeResponse(request,await response.json() as import("../src/economic/web/handoffContract").Handoff,responseKeys.publicKey);
  };
  async function startWeb() {
    const request=new NextRequest("http://localhost:3000/api/payment-intents/test/controlled-confirmation/start",{method:"POST",headers:{cookie:web.cookie(),origin:context.siteOrigin}});
    const sdk=web.makeSdk();
    const middleware=sdk.middleware.bind(sdk);sdk.middleware=async req=>{const response=await middleware(req);web.observeAuthorization(response);return response;};
    const response=await site.startControlledSdk(request,p.payment.id,await web.readSession(),sdk,callWeb);web.save(response);return response;
  }
  async function callbackWeb() {
    const challenge=(await admin.query("SELECT c.reauthentication FROM economic_confirmation_challenges c JOIN economic_web_ceremonies w USING(challenge_id) WHERE w.payment_id=$1",[p.payment.id])).rows[0].reauthentication;
    await waitForPostgresPast(admin,new Date(challenge.requestedAt*1000).toISOString());
    const request=new NextRequest(web.request()),previous=await web.readSession();
    const hook=site.controlledCallback(request,previous,callWeb),sdk=web.makeSdk(hook);
    const response=await sdk.middleware(request);web.save(response);return {response,request};
  }
  return {p,web,body,callWeb,callRuntime,packet,contract,context,siteKeys,responseKeys,make,get service(){return service;},rebuild:()=>{service=make();},startWeb,callbackWeb,sessions,site,NextRequest};
}

// The separate cross-repository target requires CONTROLLED_SITE_SOURCE; ordinary standalone
// Backend regression remains runnable without a sibling checkout. Validation for this package sets it.
if(process.env.CONTROLLED_SITE_SOURCE) {
test("controlled Runtime: actual unchanged Site SDK confirmation to private policy evaluation and reconstructed recovery",async()=>{
  const w=await controlledWebFixture(true,true);await w.callWeb("prepare",await w.body());await w.startWeb();await w.callbackWeb();
  await assert.rejects(()=>w.callRuntime("runtime-evaluate"),"callback alone cannot evaluate without explicit consent");
  assert.equal(await count("economic_policy_decisions"),0);
  assert.equal((await w.callWeb("confirm",await w.body())).state,"CONFIRMED");
  assert.equal((await w.callRuntime("runtime-recover")).state,"NOT_EVALUATED");
  const result=await w.callRuntime("runtime-evaluate");assert.equal(result.state,"APPROVED");assert.equal(result.executionAuthorized,false);
  w.rebuild();assert.deepEqual(await w.callRuntime("runtime-recover"),result);assert.equal(await count("economic_policy_decisions"),1);
});
test("web handoff: actual Site SDK to canonical session, preparation, callback and guarded consent; reconstruction and duplicates",async t=>{
  const w=await controlledWebFixture(true),body=await w.body();
  const starts=await Promise.all([w.callWeb("prepare",body),w.callWeb("prepare",body)]);
  assert.deepEqual(starts[0],starts[1]);assert.equal(starts[0].state,"READY");
  assert.equal(await count("economic_web_sessions"),1);assert.equal(await count("economic_web_ceremonies"),1);
  const mapped=(await admin.query("SELECT account_session_id FROM economic_web_sessions")).rows[0].account_session_id;
  assert.notEqual(mapped,sessionId,"a distinct web session is durably established");
  assert.equal((await w.startWeb()).status,303);
  const cb=await w.callbackWeb();assert.match(cb.response.headers.get("location")!,/controlled=1&intent=/);
  assert.equal(await count("economic_consent_evidence"),0,"callback alone does not confirm");
  assert.equal((await w.callWeb("recover",await w.body())).state,"CONFIRMABLE");
  const sdk=w.web.makeSdk(w.site.controlledCallback(cb.request,await w.web.readSession(),w.callWeb));
  await assert.rejects(()=>sdk.middleware(cb.request),/callback rejected|invalid|transaction/i);
  const source=process.env.CONTROLLED_SITE_SOURCE!;
  const product=await import(`${source}/tests/helpers/controlledWebProductFixture.tsx`);
  const bff=await import(`${source}/src/lib/controlledConfirmation/routeAction.ts`);
  const displayed=await product.exerciseControlledProduct(w.p.payment.id,async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(new URL(String(input),w.context.siteOrigin),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),origin:w.context.siteOrigin}});
    return bff.controlledRouteAction(request,w.p.payment.id,{enabled:true,trustedOrigin:(r:Request)=>r.headers.get("origin")===w.context.siteOrigin,session:w.web.readSession,call:w.callWeb});
  });
  assert.equal(displayed.state,"Payment confirmed");
  w.rebuild();
  const confirmed=await Promise.all([w.callWeb("confirm",await w.body()),w.callWeb("confirm",await w.body())]);
  assert(confirmed.every(r=>r.state==="CONFIRMED"));
  w.rebuild();assert.equal((await w.callWeb("recover",await w.body())).state,"CONFIRMED");
  assert.equal((await w.callWeb("confirm",await w.body())).state,"CONFIRMED","lost response retry recovers admission");
  assert.equal(await count("economic_consent_evidence"),1);assert.equal(await count("economic_confirmation_admissions"),1);
  assert.equal(await count("economic_attempts"),0);assert.equal(await count("economic_runtime_evidence"),0);
  for(const role of readinessRoles)await verifyAuthorityLogin(db[role],role,{deployment:expected(role),syntheticFixtures:true});
  const persisted=JSON.stringify((await admin.query("SELECT row_to_json(w) FROM economic_web_ceremonies w")).rows);
  assert(!persisted.includes(body.session.accessToken));assert(!persisted.includes(body.session.idToken));
  t.diagnostic("Actual candidate Site SDK hooks + signed private handoff + restricted PostgreSQL authorities: CONFIRMED, one consent, no execution");
});
test("web handoff: signature, context, body substitution and replay rejected across instances",async()=>{
  const w=await controlledWebFixture(),body=await w.body(),packet=w.packet("prepare",body);
  const altered=JSON.parse(packet.payload);altered.body.paymentId=randomUUID();
  await assert.rejects(()=>w.service.handle("prepare",{...packet,payload:JSON.stringify(altered)}));
  await assert.rejects(()=>w.service.handle("confirm",packet));
  await w.service.handle("prepare",packet);w.rebuild();
  await assert.rejects(()=>w.service.handle("prepare",packet),/replay/);
  const foreign=w.contract.signWebRequest({...w.context,environment:"production"},"recover",body,w.siteKeys.privateKey);
  await assert.rejects(()=>w.service.handle("recover",foreign));
  assert.equal(await count("economic_consent_evidence"),0);
});
test("web handoff: logout before first preparation and during SDK ceremony cannot regain authority",async()=>{
  const w=await controlledWebFixture(),body=await w.body();
  await w.callWeb("revoke",{session:{...body.session,accessToken:"",idToken:""}});w.rebuild();
  await assert.rejects(()=>w.callWeb("prepare",body),/revoked/);
  const second=await controlledWebFixture();await second.callWeb("prepare",await second.body());await second.startWeb();
  await second.callWeb("revoke",{session:{...(await second.body()).session,accessToken:"",idToken:""}});
  await assert.rejects(()=>second.callbackWeb(),/revoked|invalid/);
  assert.equal(await count("economic_consent_evidence"),0);
});
test("web handoff: another device cannot claim a prepared payment or rebind its opaque reference",async()=>{
  const w=await controlledWebFixture(),body=await w.body();await w.callWeb("prepare",body);
  await assert.rejects(()=>w.callWeb("prepare",{...body,session:{...body.session,reference:randomUUID()}}),/another session|conflict/);
  await assert.rejects(()=>w.callWeb("recover",{...body,session:{...body.session,subject:"subject:bob"}}),/subject/);
  assert.equal(await count("economic_web_sessions"),2,"distinct device receives distinct canonical session, no rebinding");
  assert.equal(await count("economic_consent_evidence"),0);
});
test("web handoff: fabricated SDK callback without SDK token/state binding is rejected",async()=>{
  const w=await controlledWebFixture(),body=await w.body(),prepared=await w.callWeb("prepare",body);await w.startWeb();
  await assert.rejects(()=>w.callWeb("callback",{bindingId:prepared.bindingId,stateDigest:"ff".repeat(32),session:body.session}),/substitution/);
  await assert.rejects(()=>w.callWeb("confirm",body),/validated callback/);
  assert.equal(await count("economic_confirmation_sdk_callbacks"),0);assert.equal(await count("economic_consent_evidence"),0);
});
test("web handoff: registration time never backdates account mutation; missing renewed SDK cookie cannot confirm",async()=>{
  const w=await controlledWebFixture(),oldBody=await w.body();
  // Simulate canonical account hydration after the provider login event, as real Site onboarding does.
  const a=await identities.findAccount(accountId);assert(a);
  await identities.createAccountSession({accountId,sessionId:randomUUID(),expectedAccountVersion:a.version,expiresAt:new Date(Date.now()+3600000).toISOString()});
  await w.callWeb("prepare",oldBody);await w.startWeb();await w.callbackWeb();
  assert.equal((await w.callWeb("recover",oldBody)).state,"SESSION_CHANGED","committed callback without delivered session cookie grants no confirmation authority");
  await assert.rejects(()=>w.callWeb("confirm",oldBody),/validated callback/);
  assert.equal(await count("economic_consent_evidence"),0);
  const s=(await admin.query("SELECT w.recorded_at,a.updated_at,s.created_at FROM economic_web_sessions w JOIN account_sessions s ON s.session_id=w.account_session_id JOIN accounts a USING(account_id)")).rows[0];
  assert(s.updated_at>=s.created_at);assert(s.recorded_at>=s.created_at);
});

}

// Real v0.5.0 integration: actual preparation, installed Auth0 SDK, guarded SQL consent,
// restricted issuer LOGIN and authoritative database evidence. No legacy Runtime stub.
async function runtimeFixture(options:{maxAtomicUnits?:string;consentSeconds?:number;substituteDestination?:boolean;webSession?:boolean;registerProfile?:boolean}={}) {
  const {registerRuntimeTestProfile}=await import("../src/economic/runtime/runtimeTestProfile");
  const {RuntimePolicyAdapter}=await import("../src/economic/runtime/runtimePolicyAdapter");
  if(options.webSession) {
    sessionId=randomUUID();
    version=(await identities.createAccountSession({accountId,sessionId,expectedAccountVersion:version,
      createdAt:new Date(Date.now()-30000).toISOString(),expiresAt:new Date(Math.floor(Date.now()/1000)*1000+3600000).toISOString()})).account.version;
  }
  if(options.consentSeconds) {
    policy=confirmationPolicyFixture(f.configuration,{revision:2,consentSeconds:options.consentSeconds});
    await registerConfirmationPolicy(admin,policy);rebuild();
  }
  const now=(await admin.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
  const input={qualifiedAsset:fixture.qualifiedAsset,policyVersion:"runtime-test-1",effectiveFrom:new Date(now-60000).toISOString(),
    expiresAt:new Date(now+600000).toISOString(),maxAtomicUnits:options.maxAtomicUnits??"2000000"};
  const {runtimeTestProfile}=await import("../src/economic/runtime/runtimeTestProfile");
  const {runtimePolicyProfileDigestV1}=await import("zephyon-protocol");
  const profile=runtimeTestProfile(f.configuration,input);
  const registered=options.registerProfile===false?{profile,profileDigest:runtimePolicyProfileDigestV1(profile)}:await registerRuntimeTestProfile(admin,f.configuration,input);
  const reference={policyVersion:input.policyVersion,evidenceDigest:registered.profileDigest,
    scope:"devnet-test-only" as const,validFrom:input.effectiveFrom,validUntil:input.expiresAt};
  let p=await paymentPreparationFixture(reference),prepared=await p.run();
  if(options.substituteDestination) {
    // Deliberately adversarial app-side envelope: guarded preparation binds the wallet, while
    // the independent Runtime destination source must detect a substituted token account.
    p=await paymentPreparationFixture(reference);
    const e=structuredClone(prepared.envelope) as any;
    e.attempt.intentId=`zephipay:payment:${p.payment.id}`;e.attempt.attemptId=randomUUID();e.attempt.fenceToken=randomUUID();
    e.purpose.reference=p.payment.id;e.runtime.decisionId=randomUUID();e.recipient.account=e.source.account;
    const {authorizationBindingDigestV1}=await import("zephyon-protocol");
    const envelope=createEconomicIntentEnvelopeV1(e,e.amount.asset),digest=authorizationBindingDigestV1(envelope,e.amount.asset);
    await transaction(db.app,async client=>{
      await client.query("INSERT INTO economic_attempt_heads(intent_id,principal_id,current_generation) VALUES($1,$2,1)",[e.attempt.intentId,principalId]);
      await client.query("INSERT INTO economic_envelopes(intent_id,generation,attempt_id,fence_token,envelope_digest,envelope) VALUES($1,1,$2,$3,$4,$5)",
        [e.attempt.intentId,e.attempt.attemptId,e.attempt.fenceToken,digest,envelope]);
      const snapshot=(await client.query("SELECT economic_payment_snapshot(p) AS s FROM payments p WHERE id=$1",[p.payment.id])).rows[0].s;
      await client.query("INSERT INTO economic_payment_preparations(payment_id,account_session_id,envelope_digest,payment_snapshot) VALUES($1,$2,$3,$4)",
        [p.payment.id,sessionId,digest,snapshot]);
    });
    prepared=await p.run();
  }
  const web=auth0SdkHostFixture(),adapter=sdkAdapter(web);await web.login();
  await adapter.bindExistingSession(sessionId,web.readSession,confirmationEndpoint(),"fixture-nonce");
  authentication=await f.auth.verifyAccess((await web.readSession())!.tokenSet.accessToken,"confirm:economic");
  const c=await start(prepared.envelopeDigest);
  const diagnosticBefore=await runtimeClockDiagnostic(prepared.envelopeDigest);
  let started:Awaited<ReturnType<typeof adapter.start>>;
  try {started=await adapter.start(c.challenge_id,web.readSession,confirmationEndpoint(),"fixture-nonce");}
  catch(error) {console.error("Runtime fixture SDK-start clock/context",JSON.stringify({before:diagnosticBefore,after:await runtimeClockDiagnostic(prepared.envelopeDigest)}));throw error;}
  web.save(started.response);
  const challenge=(await call("roundtrip",{envelopeDigest:prepared.envelopeDigest,challengeId:c.challenge_id,transactionId:c.transaction_id})).reauthentication;
  await waitForPostgresPast(admin,new Date(challenge.requestedAt*1000).toISOString());
  assert.equal((await adapter.callback(web.request(),confirmationEndpoint(),"fixture-nonce")).status,303);
  assert.equal(await count("economic_consent_evidence"),0,"callback alone supplies no consent");
  const proof=await adapter.prepareConfirmation(started.bindingId,web.readSession,confirmationEndpoint(),"fixture-nonce");
  const admitted=JSON.parse((await sdkAdmit(proof)).body);assert.equal(admitted.state,"CONFIRMED");
  const request={paymentId:p.payment.id,accountSessionId:sessionId,envelopeDigest:prepared.envelopeDigest,consentId:admitted.consent_id};
  const make=()=>new RuntimePolicyAdapter(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("issuer",db.issuer,expected("issuer")),f.configuration,endpointKeys.publicKey),f.auth));
  const run=(service=make(),r=request)=>service.evaluate(r,proof.authentication,"TEST:prepared-session",confirmationEndpoint(),"fixture-nonce");
  return {p,prepared,request,make,run,input,proof,registered,web,challenge:c,bindingId:started.bindingId};
}

// RUNTIME-OBS-01 diagnostic only. No credentials/provider artifacts, waiting, retries or changed assertions.
async function runtimeClockDiagnostic(envelopeDigest:string) {
  const row=(await admin.query(`SELECT clock_timestamp()::text AS database_time,a.status AS account_status,s.revoked_at AS session_revoked_at,
    s.created_at AS session_created_at,s.expires_at AS session_expires_at,e.state AS envelope_state,e.envelope->>'createdAt' AS envelope_created_at,
    e.envelope->>'expiresAt' AS envelope_expires_at,pol.payload::jsonb->>'issuedAt' AS policy_issued_at,
    d.decision->>'status' AS decision_status,d.decision->>'issuedAt' AS decision_issued_at,d.decision->>'expiresAt' AS decision_expires_at,
    d.decision->'rejectionCodes' AS rejection_codes
    FROM economic_payment_preparations p JOIN economic_envelopes e USING(envelope_digest)
    JOIN account_sessions s ON s.session_id=p.account_session_id JOIN accounts a USING(account_id)
    LEFT JOIN economic_confirmation_challenges c ON c.envelope_digest=p.envelope_digest
    LEFT JOIN economic_confirmation_policies pol ON pol.fingerprint=c.policy_fingerprint
    LEFT JOIN economic_policy_decisions d ON d.payment_id=p.payment_id WHERE p.envelope_digest=$1`,[envelopeDigest])).rows[0];
  return row;
}

test("Runtime v1: exact consent to real SDK APPROVED; concurrency, reconstruction and immutable non-value decision",async()=>{
  const r=await runtimeFixture(),results=await Promise.all([r.run(),r.run(),r.run()]);
  assert.deepEqual(results[1],results[0]);assert.deepEqual(results[2],results[0]);
  const result=results[0];assert.equal(result.decision.status,"APPROVED");assert.equal(result.currentApproval,true);assert.equal(result.executionAuthorized,false);
  assert.equal(result.decision.envelopeDigest,r.prepared.envelopeDigest);assert.equal(result.decision.decisionId,r.prepared.envelope.runtime.decisionId);
  assert.equal(result.decision.profileDigest,r.registered.profileDigest);assert.equal(result.decision.evidenceReferences.length,3);
  assert.deepEqual(await r.run(r.make()),result);assert.equal(await count("economic_policy_decisions"),1);
  const row=(await admin.query("SELECT * FROM economic_policy_decisions")).rows[0];
  assert.equal(row.evaluation_context.evaluatedAt,result.decision.issuedAt);
  assert.equal(row.evidence.find((v:any)=>v.evidenceClass==="economic-consent").fact.consent.consentId,r.request.consentId);
  await assert.rejects(()=>admin.query("UPDATE economic_policy_decisions SET decision=decision||'{\"status\":\"REJECTED\"}'"),/append.only|immutable/i);
  for(const role of ["identity","app","signer","observer","reader"] as const) {
    await assert.rejects(()=>db[role].query("INSERT INTO economic_policy_decisions SELECT * FROM economic_policy_decisions"),/permission denied/);
    await assert.rejects(()=>db[role].query("UPDATE economic_runtime_policy_heads SET profile_digest=profile_digest"),/permission denied/);
  }
  await assert.rejects(()=>db.issuer.query("UPDATE economic_runtime_policy_heads SET profile_digest=profile_digest"),/permission denied/);
  assert.equal(await count("economic_attempts"),0);assert.equal((await admin.query("SELECT status FROM payments WHERE id=$1",[r.p.payment.id])).rows[0].status,"AWAITING_CONFIRMATION");
});

test("Runtime v1: real policy cap REJECTED stays identical across retry and cannot acquire execution authority",async()=>{
  const r=await runtimeFixture({maxAtomicUnits:"999999"}),first=await r.run();
  assert.equal(first.decision.status,"REJECTED");assert.deepEqual(first.decision.rejectionCodes,["AMOUNT_NOT_PERMITTED"]);
  assert.equal(first.currentApproval,false);assert.equal(first.executionAuthorized,false);assert.deepEqual(await r.run(),first);
  assert.equal(await count("economic_attempts"),0);
});

test("Runtime v1: missing consent, envelope, session and caller-shaped evidence fail closed",async()=>{
  const r=await runtimeFixture();
  for(const change of [{consentId:randomUUID()},{accountSessionId:randomUUID()},{paymentId:randomUUID()},{envelopeDigest:"ff".repeat(32)},
    {evidence:[{status:"satisfied"}]},{decision:{status:"APPROVED"}},{evaluatedAt:"2026-01-01T00:00:00.000Z"}])
    await assert.rejects(async()=>r.run(r.make(),{...r.request,...change}));
  await assert.rejects(()=>r.make().evaluate(r.request,r.proof.authentication,"unbound-session",confirmationEndpoint(),"fixture-nonce"),/binding/);
  assert.equal(await count("economic_policy_decisions"),0);
});

for(const source of ["consent","session"] as const) test(`Runtime v1: revoked ${source} before evaluation is SDK REJECTED`,async()=>{
  const r=await runtimeFixture();
  if(source==="consent") await db.issuer.query("UPDATE economic_consent_evidence SET revoked_at=clock_timestamp() WHERE consent_id=$1",[r.request.consentId]);
  else await revoke();
  const result=await r.run();assert.equal(result.decision.status,"REJECTED");assert(result.decision.rejectionCodes.includes("EVIDENCE_REVOKED"));
  assert.equal(result.currentApproval,false);assert.equal(await count("economic_attempts"),0);
});

for(const source of ["consent","session","policy"] as const) test(`Runtime v1: ${source} change invalidates current approval without rewriting history`,async()=>{
  const r=await runtimeFixture(),first=await r.run();assert.equal(first.currentApproval,true);
  if(source==="consent") await db.issuer.query("UPDATE economic_consent_evidence SET revoked_at=clock_timestamp() WHERE consent_id=$1",[r.request.consentId]);
  else if(source==="session") await revoke();
  else {
    const {registerRuntimeTestProfile}=await import("../src/economic/runtime/runtimeTestProfile");
    await registerRuntimeTestProfile(admin,f.configuration,{...r.input,policyVersion:"runtime-test-2"});
  }
  const recovered=await r.run();assert.deepEqual(recovered.decision,first.decision);assert.equal(recovered.currentApproval,false);assert.equal(recovered.executionAuthorized,false);
  assert.equal(await count("economic_policy_decisions"),1);
});

for(let repetition=1;repetition<=2;repetition++) test(`Runtime v1: database-observed expiry never widens to Runtime reference ${repetition}`,async t=>{
  const r=await runtimeFixture({consentSeconds:5}),first=await r.run();assert.equal(first.currentApproval,true);
  assert(first.decision.expiresAt<r.prepared.envelope.runtime.validUntil);
  t.diagnostic(JSON.stringify(await waitForPostgresPast(admin,first.decision.expiresAt)));
  const recovered=await r.run();assert.deepEqual(recovered.decision,first.decision);assert.equal(recovered.currentApproval,false);
  assert.equal(await count("economic_policy_decisions"),1);
});

test("Runtime v1: expiry while waiting for authoritative lock is rejected by real SDK",async t=>{
  const r=await runtimeFixture({consentSeconds:5}),lock=await admin.connect();
  try {
    await lock.query("BEGIN");await lock.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE",[r.prepared.envelope.attempt.intentId]);
    const pending=r.run();
    const deadline=(await admin.query("SELECT expires_at FROM economic_consent_evidence WHERE consent_id=$1",[r.request.consentId])).rows[0].expires_at.toISOString();
    t.diagnostic(JSON.stringify(await waitForPostgresPast(admin,deadline)));
    await lock.query("COMMIT");const result=await pending;
    assert.equal(result.decision.status,"REJECTED");assert(result.decision.rejectionCodes.includes("EVIDENCE_EXPIRED"));assert.equal(result.currentApproval,false);
  } finally {await lock.query("ROLLBACK");lock.release();}
});

test("Runtime v1: registry revocation fails closed and cannot reinterpret prior decision",async()=>{
  const r=await runtimeFixture(),first=await r.run();
  await registry.revoke("asset","devnet-usdc-v1");await assert.rejects(()=>r.run(),/revoked|qualified|asset/i);
  assert.deepEqual((await admin.query("SELECT decision FROM economic_policy_decisions")).rows[0].decision,first.decision);
});


test("Runtime v1: independently derived destination rejects substituted token account even with exact consent",async()=>{
  const r=await runtimeFixture({substituteDestination:true}),result=await r.run();
  assert.equal(result.decision.status,"REJECTED");assert(result.decision.rejectionCodes.includes("DESTINATION_NOT_QUALIFIED"));
  assert.equal(result.currentApproval,false);assert.equal(await count("economic_attempts"),0);
});

// Backend-only private product boundary: actual SDK-validated consent and guarded web mappings,
// actual HTTP/signed handoff, issuer LOGIN and installed Protocol. No caller-supplied authority.
async function runtimeHandoffFixture(options:Parameters<typeof runtimeFixture>[0]={}) {
  const r=await runtimeFixture({...options,webSession:true});
  const {ControlledWebConfirmation}=await import("../src/economic/web/controlledWebConfirmation");
  const {createControlledWebApplication}=await import("../src/economic/web/application");
  const contract=await import("../src/economic/web/handoffContract");
  const {bindEconomicSession}=await import("../src/economic/foundation/sessionAuthority");
  const {generateKeyPairSync}=await import("node:crypto");
  const siteKeys=generateKeyPairSync("ed25519"),responseKeys=generateKeyPairSync("ed25519"),reference=randomUUID();
  const expires=(await admin.query("SELECT expires_at FROM account_sessions WHERE session_id=$1",[sessionId])).rows[0].expires_at;
  await transaction(db.identity,async client=>{
    await bindEconomicSession(client,{issuer:authentication.issuer,providerSubject:authentication.subject,providerSessionReference:`zephipay:web:${reference}`,accountSessionId:sessionId});
    await client.query("INSERT INTO economic_web_sessions(reference,issuer,subject,account_session_id,expires_at) VALUES($1,$2,$3,$4,$5)",
      [reference,authentication.issuer,authentication.subject,sessionId,expires]);
    await client.query("INSERT INTO economic_web_ceremonies(payment_id,reference,envelope_digest,challenge_id,transaction_id,binding_id) VALUES($1,$2,$3,$4,$5,$6)",
      [r.p.payment.id,reference,r.prepared.envelopeDigest,r.challenge.challenge_id,r.challenge.transaction_id,r.bindingId]);
  });
  const context={environment:f.configuration.profile.environment,configuration:f.configuration.fingerprint,siteOrigin:"http://localhost:3000",backendOrigin:"http://localhost:3001",clientId:policy.policy.clientId,issuer:policy.policy.issuer};
  const make=(enabled=true)=>new ControlledWebConfirmation(new ProviderDeploymentReadiness(new DeploymentReadiness(
    new AuthorityProcess("identity",db.identity,expected("identity")),f.configuration,endpointKeys.publicKey),f.auth),policy,context,siteKeys.publicKey,responseKeys.privateKey,
    ()=>({artifact:confirmationEndpoint(),nonce:"fixture-nonce"}),{
      prepare:async()=>{throw new Error("Fixture ceremony already prepared.");},challenge:async()=>{throw new Error("Fixture challenge already issued.");},
      admit:async()=>{throw new Error("Fixture consent already admitted.");},
      ...(enabled?{runtime:(action:import("../src/economic/runtime/controlledRuntimeResult").ControlledRuntimeAction,ref:{paymentId:string;challengeId:string},auth:Auth0Authentication,providerReference:string)=>
        r.make().controlled(action,ref,auth,providerReference,confirmationEndpoint(),"fixture-nonce")}:{})
    },"controlled-non-value");
  let service=make();
  const app=createControlledWebApplication({handle:(action,packet)=>service.handle(action,packet)}),server=app.listen(0,"localhost");webServers.push(server);
  await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
  context.backendOrigin=`http://localhost:${(server.address() as import("node:net").AddressInfo).port}`;service=make();
  const raw=r.web.providerTokens();
  const body={paymentId:r.p.payment.id,session:{reference,expiresAt:expires.getTime()/1000,subject:authentication.subject,accessToken:raw.accessToken,idToken:raw.idToken}};
  type Action=import("../src/economic/runtime/controlledRuntimeResult").ControlledRuntimeAction;
  const packet=(action:Action,input:unknown=body)=>{
    const generated=contract.signWebRequest(context,action,input as typeof body,siteKeys.privateKey),m=JSON.parse(generated.payload);
    return signedFixture({...m,issuedAt:m.issuedAt-1,expiresAt:m.expiresAt-1},siteKeys.privateKey);
  };
  const post=(action:Action,p:unknown)=>fetch(`${context.backendOrigin}/internal/controlled-confirmation/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(p)});
  const invoke=async(action:Action,input:unknown=body)=>{
    const request=packet(action,input),response=await post(action,request);assert.equal(response.status,200);
    return contract.verifyRuntimeResponse(request,await response.json() as import("../src/economic/web/handoffContract").Handoff,responseKeys.publicKey);
  };
  return {r,body,packet,post,invoke,context,siteKeys,responseKeys,contract,make,get service(){return service;},rebuild:(enabled=true)=>{service=make(enabled);}};
}

test("controlled Runtime: read-only empty recovery, concurrent evaluate, lost response and reconstructed private HTTP recovery",async t=>{
  const w=await runtimeHandoffFixture();
  const empty=await w.invoke("runtime-recover");assert.equal(empty.state,"NOT_EVALUATED");assert.equal(empty.historicalStatus,"NONE");
  assert.equal(await count("economic_policy_decisions"),0,"status must never trigger first evaluation");
  const results=await Promise.all([w.invoke("runtime-evaluate"),w.invoke("runtime-evaluate"),w.invoke("runtime-evaluate")]);
  const first=results[0];for(const r of results)assert.deepEqual(r,first);
  assert.equal(first.state,"APPROVED");assert.equal(first.historicalStatus,"APPROVED");assert.equal(first.currentApproval,true);
  assert.equal(first.mode,"non-value");assert.equal(first.productionReady,false);assert.equal(first.executionAuthorized,false);
  assert.equal(first.decisionId,w.r.prepared.envelope.runtime.decisionId);
  // The historical decision is immutable; current approval is time-sensitive. Establish
  // the original decision's issued-at boundary using PostgreSQL before asserting that
  // immediate reconstructed reads are all currently approved. Keep every equality/expiry
  // assertion: a backward DB correction must still make the product fail closed.
  const issuedAt=(await admin.query("SELECT decision->>'issuedAt' AS issued_at FROM economic_policy_decisions WHERE payment_id=$1",[w.r.p.payment.id])).rows[0].issued_at;
  t.diagnostic(JSON.stringify(await waitForPostgresPast(admin,issuedAt)));
  const lost=await w.post("runtime-evaluate",w.packet("runtime-evaluate"));assert.equal(lost.status,200);await lost.body?.cancel();
  w.rebuild();for(let i=0;i<3;i++)assert.deepEqual(await w.invoke("runtime-recover",structuredClone(w.body)),first);
  assert.equal(await count("economic_policy_decisions"),1);assert.equal(await count("economic_attempts"),0);
  assert.equal((await admin.query("SELECT status FROM payments WHERE id=$1",[w.r.p.payment.id])).rows[0].status,"AWAITING_CONFIRMATION");
  assert.deepEqual(Object.keys(first).sort(),["paymentId","mode","productionReady","executionAuthorized","state","historicalStatus","currentApproval","decisionId","expiresAt"].sort());
  for(const role of ["identity","app","signer","observer","reader"] as const)
    await assert.rejects(()=>db[role].query("SELECT * FROM economic_policy_decisions"),/permission denied/);
});

test("controlled Runtime: exact signed references, access authentication, session ownership and durable replay boundary",async()=>{
  const w=await runtimeHandoffFixture();
  for(const field of ["envelopeDigest","asset","amount","recipient","destination","policy","evidence","status","limits","evaluatedAt","challengeId","accountSessionId"])
    assert.equal((await w.post("runtime-evaluate",w.packet("runtime-evaluate",{...w.body,[field]:"caller-value"}))).status,409,field);
  for(const input of [{...w.body,paymentId:randomUUID()}, {...w.body,session:{...w.body.session,reference:randomUUID()}},
    {...w.body,session:{...w.body.session,subject:"subject:bob"}}, {...w.body,session:{...w.body.session,accessToken:"forged"}},
    {...w.body,session:{...w.body.session,expiresAt:w.body.session.expiresAt+1}}])
    assert.equal((await w.post("runtime-recover",w.packet("runtime-recover",input))).status,409);
  const bob=await accessFixture({sub:"subject:bob",scope:"confirm:economic"});
  assert.equal((await w.post("runtime-recover",w.packet("runtime-recover",{...w.body,session:{...w.body.session,subject:"subject:bob",accessToken:bob}}))).status,409,
    "independently valid access token for another owner cannot inspect this payment");
  assert.equal((await w.post("runtime-evaluate",w.body)).status,409,"browser-shaped body has no pinned Site signature");
  const packet=w.packet("runtime-recover"),m=JSON.parse(packet.payload);
  assert.equal((await w.post("runtime-evaluate",packet)).status,409,"action substitution");
  for(const change of [{context:{...m.context,environment:"production"}},{context:{...m.context,clientId:"other"}},
    {context:{...m.context,issuer:"https://other.invalid/"}},{context:{...m.context,backendOrigin:"https://other.invalid"}},
    {expiresAt:m.issuedAt-1}])assert.equal((await w.post("runtime-recover",signedFixture({...m,...change},w.siteKeys.privateKey))).status,409);
  assert.equal((await w.post("runtime-recover",{...packet,signature:"A".repeat(86)})).status,409);
  const original=await w.post("runtime-recover",packet);assert.equal(original.status,200);
  const response=await original.json() as import("../src/economic/web/handoffContract").Handoff;
  assert.throws(()=>w.contract.verifyRuntimeResponse(w.packet("runtime-recover"),response,w.responseKeys.publicKey));
  w.rebuild();assert.equal((await w.post("runtime-recover",packet)).status,409,"replay survives reconstruction");
  assert.equal(await count("economic_policy_decisions"),0);
  w.rebuild(false);assert.equal((await w.post("runtime-evaluate",w.packet("runtime-evaluate"))).status,409,"Runtime port must be explicitly composed");
});

test("controlled Runtime: first decision commits despite lost response and a fresh caller recovers only that decision",async()=>{
  const w=await runtimeHandoffFixture(),request=w.packet("runtime-evaluate");
  const response=await w.post("runtime-evaluate",request);assert.equal(response.status,200);await response.body?.cancel();
  const stored=(await admin.query("SELECT decision FROM economic_policy_decisions")).rows[0].decision;
  assert.equal(stored.status,"APPROVED");
  w.rebuild();const recovered=await w.invoke("runtime-recover",structuredClone(w.body));
  assert.equal(recovered.decisionId,stored.decisionId);assert.equal(recovered.state,"APPROVED");
  assert.deepEqual(await w.invoke("runtime-evaluate"),recovered);assert.equal(await count("economic_policy_decisions"),1);
});

test("controlled Runtime: unconfirmed or different ceremony cannot select consent",async()=>{
  const w=await runtimeHandoffFixture(),p=await paymentPreparationFixture(),prepared=await p.run(),c=await start(prepared.envelopeDigest);
  await db.identity.query("INSERT INTO economic_web_ceremonies(payment_id,reference,envelope_digest,challenge_id,transaction_id,binding_id) VALUES($1,$2,$3,$4,$5,$6)",
    [p.payment.id,w.body.session.reference,prepared.envelopeDigest,c.challenge_id,c.transaction_id,randomUUID()]);
  assert.equal((await w.post("runtime-evaluate",w.packet("runtime-evaluate",{...w.body,paymentId:p.payment.id}))).status,409);
  await assert.rejects(()=>w.r.make().controlled("runtime-evaluate",{paymentId:w.r.p.payment.id,challengeId:c.challenge_id},w.r.proof.authentication,
    `zephipay:web:${w.body.session.reference}`,confirmationEndpoint(),"fixture-nonce"),/Exact confirmed/);
  assert.equal(await count("economic_policy_decisions"),0);
});

test("controlled Runtime: explicit TEST inventory registration is required before evaluation",async()=>{
  const w=await runtimeHandoffFixture({registerProfile:false});
  assert.equal((await w.post("runtime-evaluate",w.packet("runtime-evaluate"))).status,409);
  assert.equal(await count("economic_runtime_test_profiles"),0);assert.equal(await count("economic_policy_decisions"),0);
  await assert.rejects(()=>w.r.run(),/Unregistered Runtime TEST profile/);
});

test("controlled Runtime: cap rejection is terminal across evaluation/recovery, policy replacement and registry loss",async()=>{
  const w=await runtimeHandoffFixture({maxAtomicUnits:"999999"}),first=await w.invoke("runtime-evaluate");
  assert.equal(first.state,"REJECTED");assert.equal(first.historicalStatus,"REJECTED");assert.equal(first.currentApproval,false);
  const {registerRuntimeTestProfile}=await import("../src/economic/runtime/runtimeTestProfile");
  await registerRuntimeTestProfile(admin,f.configuration,{...w.r.input,policyVersion:"runtime-replacement",maxAtomicUnits:"9000000"});
  await registry.revoke("asset","devnet-usdc-v1");
  assert.deepEqual(await w.invoke("runtime-evaluate"),first);w.rebuild();assert.deepEqual(await w.invoke("runtime-recover"),first);
  assert.equal(await count("economic_policy_decisions"),1);assert.equal(await count("economic_attempts"),0);
});

for(const change of ["session","account","consent","policy","logout"] as const)
test(`controlled Runtime: ${change} change preserves historical approval and denies current approval`,async()=>{
  const w=await runtimeHandoffFixture(),first=await w.invoke("runtime-evaluate");assert.equal(first.currentApproval,true);
  const historical=(await admin.query("SELECT decision FROM economic_policy_decisions")).rows[0].decision;
  if(change==="session")await revoke();
  else if(change==="account")await identities.createAccountSession({accountId,sessionId:randomUUID(),expectedAccountVersion:version,
    expiresAt:new Date(Date.now()+60000).toISOString()});
  else if(change==="consent")await db.issuer.query("UPDATE economic_consent_evidence SET revoked_at=clock_timestamp() WHERE consent_id=$1",[w.r.request.consentId]);
  else if(change==="logout")await w.service.handle("revoke",w.contract.signWebRequest(w.context,"revoke",{session:{...w.body.session,accessToken:"",idToken:""}},w.siteKeys.privateKey));
  else {
    const {registerRuntimeTestProfile}=await import("../src/economic/runtime/runtimeTestProfile");
    await registerRuntimeTestProfile(admin,f.configuration,{...w.r.input,policyVersion:"runtime-replacement"});
  }
  w.rebuild();const recovered=await w.invoke("runtime-recover");
  assert.equal(recovered.state,"NO_LONGER_CURRENT");assert.equal(recovered.historicalStatus,"APPROVED");assert.equal(recovered.currentApproval,false);
  assert.equal(recovered.decisionId,first.decisionId);assert.equal(recovered.executionAuthorized,false);
  assert.deepEqual((await admin.query("SELECT decision FROM economic_policy_decisions")).rows[0].decision,historical);
  assert.deepEqual(await w.invoke("runtime-evaluate"),recovered);assert.equal(await count("economic_policy_decisions"),1);
});

for(let repeat=1;repeat<=2;repeat++)test(`controlled Runtime: PostgreSQL-observed consent expiry remains historical only ${repeat}`,async t=>{
  const w=await runtimeHandoffFixture({consentSeconds:8}),first=await w.invoke("runtime-evaluate");
  assert.equal(first.currentApproval,true,JSON.stringify({result:first,clock:await runtimeClockDiagnostic(w.r.prepared.envelopeDigest)}));
  t.diagnostic(JSON.stringify(await waitForPostgresPast(admin,first.expiresAt!)));
  w.rebuild();const recovered=await w.invoke("runtime-recover");
  assert.equal(recovered.state,"EXPIRED");assert.equal(recovered.historicalStatus,"APPROVED");assert.equal(recovered.currentApproval,false);
  assert.equal(recovered.decisionId,first.decisionId);assert.equal(recovered.expiresAt,first.expiresAt);assert.equal(await count("economic_policy_decisions"),1);
});

test("controlled Runtime: qualification loss reports unavailable verification without fabricating rejection or changing history",async()=>{
  const w=await runtimeHandoffFixture(),first=await w.invoke("runtime-evaluate");
  await registry.revoke("asset","devnet-usdc-v1");
  const recovered=await w.invoke("runtime-recover");
  assert.equal(recovered.state,"UNAVAILABLE");assert.equal(recovered.historicalStatus,"APPROVED");assert.equal(recovered.currentApproval,false);
  assert.equal(recovered.executionAuthorized,false);assert.equal(recovered.decisionId,first.decisionId);
  assert.equal((await admin.query("SELECT decision->>'status' AS status FROM economic_policy_decisions")).rows[0].status,"APPROVED");
});

test("controlled Runtime: prepared destination substitution remains a real Protocol rejection",async()=>{
  const w=await runtimeHandoffFixture({substituteDestination:true}),result=await w.invoke("runtime-evaluate");
  assert.equal(result.state,"REJECTED");assert.equal(result.currentApproval,false);
  assert((await admin.query("SELECT decision FROM economic_policy_decisions")).rows[0].decision.rejectionCodes.includes("DESTINATION_NOT_QUALIFIED"));
});
