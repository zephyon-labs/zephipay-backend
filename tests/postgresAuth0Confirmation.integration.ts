import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { parse } from "pg-connection-string";
import { createEconomicIntentEnvelopeV1 } from "zephyon-protocol";
import { Auth0ConfirmationBridge, confirmationRoutes } from "../src/economic/confirmation/confirmationBridge";
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
import { PostgresIdentityPersistence, revokeAccountSessionInTransaction } from "../src/storage/postgres/postgresIdentityPersistence";
import { confirmationPolicyFixture } from "./helpers/confirmationFixtures";
import { installSyntheticStore } from "./helpers/syntheticAuthorityAdapters";
import { accessFixture, endpointFixture, endpointKeys, headFixture, profileFixture, readyFixture, serviceKeys, snapshotFixture } from "./helpers/realProviderFixtures";

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL required; disposable fixtures only.");
const admin = new Pool({connectionString:url,max:8});
const db = Object.fromEntries(readinessRoles.map(role => [role,new Pool({...parse(url),user:`provider_fixture_${role}`,
  password:"disposable-provider-fixture-only",max:5} as PoolConfig)])) as Record<typeof readinessRoles[number],Pool>;
const identities = new PostgresIdentityPersistence(db.identity), registry = new TrustedRegistryAdministration(admin);
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json","utf8"));
let databaseName: string, identityOwner: string, accountId: string, sessionId: string, principalId: string, version: bigint;
let f: Awaited<ReturnType<typeof readyFixture>>, policy: VerifiedConfirmationPolicy, bridge: Auth0ConfirmationBridge, sender: ReadinessServiceTransport;
let receiver: ReadinessServiceTransport, authentication: Auth0Authentication, repo: PostgresFinalizationRepository;
let evidence: EvidencePolicy;
const pause = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
function expected(role: typeof readinessRoles[number]): DeploymentExpectation {
  return {deploymentId:profileFixture().deploymentId,environment:"offline-fixture",databaseName,login:`provider_fixture_${role}`,
    credentialGeneration:"1",schemaOwner:"pg_database_owner",identityOwner};
}
function volatileFixtureLedger() { const ids = new Set<string>(); return {async consume(id: string) {if(ids.has(id)) return false;ids.add(id);return true;}}; }
function rebuild() {
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
afterEach(async () => {
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
async function call(action: string, input: Record<string,unknown>, reauth?: Auth0Reauthentication, auth=authentication) {
  const path=`/confirmation/${action}`, body=JSON.stringify({accountSessionId:sessionId,authenticationDigest:auth.tokenDigest,...input});
  const request=sender.request("issuer","POST",path,body);
  const response=await bridge.execute(path,body,request,endpointFixture(f.configuration),"fixture-nonce",auth,reauth);
  await sender.verifyResponse(request,response.signature,response.body);
  return JSON.parse(response.body);
}
async function start(digest: string, requestId=randomUUID()) {return call("start",{envelopeDigest:digest,requestId});}
async function issued() {const p=await prepare(), c=await start(p.digest);return {...p,c};}
function ref(p: Awaited<ReturnType<typeof issued>>) {return {envelopeDigest:p.digest,challengeId:p.c.challenge_id,transactionId:p.c.transaction_id};}
async function callback(p: Awaited<ReturnType<typeof issued>>, changes: Record<string,unknown>={}) {
  const result=await call("roundtrip",ref(p)), challenge=result.reauthentication as ReauthenticationChallenge;
  await pause(Math.max(0,challenge.requestedAt*1000-Date.now()+5));
  const now=Math.floor(Date.now()/1000), raw=await accessFixture({aud:f.configuration.profile.clientId,iat:now,auth_time:now,
    nonce:challenge.nonce,acr:"fixture:mfa",...changes});
  return {proof:await f.auth.verifyReauthentication(raw,challenge),digest:sha256(raw),raw,challenge};
}
async function confirm(p: Awaited<ReturnType<typeof issued>>, cb: Awaited<ReturnType<typeof callback>>, changes: Record<string,unknown>={}) {
  return call("confirm",{...ref(p),action:"confirm-economic-intent",reauthenticationDigest:cb.digest,...changes},cb.proof);
}
async function count(table: string) {return Number((await admin.query(`SELECT count(*) FROM ${table}`)).rows[0].count);}
async function revoke() {return identities.revokeAccountSession({accountId,sessionId,expectedAccountVersion:version,revokedAt:new Date().toISOString()});}

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
  const p=await issued(),cb=await callback(p);await pause(Math.max(0,Date.parse(p.c.expires_at)-Date.now()+25));
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
test("database commit guard catches expiry during the final provider readiness wait",async()=>{
  policy=confirmationPolicyFixture(f.configuration,{revision:2,consentSeconds:1});await registerConfirmationPolicy(admin,policy);rebuild();
  const p=await issued(),cb=await callback(p),original=f.auth.assertCurrent.bind(f.auth);let checks=0;
  f.auth.assertCurrent=async proof=>{await original(proof);if(++checks===2)await pause(1200);};
  await assert.rejects(()=>confirm(p,cb),/expired before commit/);
  assert.equal(await count("economic_consent_evidence"),0);assert.equal(await count("economic_confirmation_consumptions"),0);
  f.auth.assertCurrent=original;assert.equal((await call("recover",ref(p))).state,"ISSUED");
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
for(const table of ["economic_consent_evidence","economic_confirmation_consumptions"]) test(`database failure at ${table} rolls back both records and permits safe retry`,async()=>{
  const p=await issued(),cb=await callback(p);
  await admin.query("CREATE FUNCTION fixture_reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected consent admission failure'; END $$");
  await admin.query(`CREATE TRIGGER fixture_confirmation_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fixture_reject_confirmation()`);
  try {await assert.rejects(()=>confirm(p,cb),/injected/);assert.equal(await count("economic_consent_evidence"),0);assert.equal(await count("economic_confirmation_consumptions"),0);}
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
