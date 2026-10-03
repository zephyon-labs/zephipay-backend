import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { Pool, type PoolConfig } from "pg";
import { parse } from "pg-connection-string";
import { Keypair, Message, Transaction } from "@solana/web3.js";
import { createEconomicIntentEnvelopeV1, offlineSponsoredMessageV1 } from "zephyon-protocol";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { createTrustedAuthorityComposition } from "../src/economic/composition/trustedAuthorityComposition";
import { verifyAuthorityLogin, type DeploymentExpectation } from "../src/economic/composition/verifyAuthorityLogin";
import { createEconomicEvidenceIngestion, type EvidencePolicy } from "../src/economic/foundation/evidenceIngestion";
import { TrustedRegistryAdministration, devnetUsdcConfiguration } from "../src/economic/foundation/trustedRegistry";
import { AuthorityProcess } from "../src/economic/provider/authorityProcess";
import { ProviderSessionAuthority, ProviderConsentGate } from "../src/economic/provider/providerSessionAuthority";
import { ProviderTokenVerifier } from "../src/economic/provider/providerTokenVerifier";
import { DurableSyntheticSigner, DurableSyntheticObserver, SyntheticRuntimeIssuer, installSyntheticStore } from "./helpers/syntheticAuthorityAdapters";
import { providerContract, providerJwks, providerToken, providerKeys } from "./helpers/providerTokens";
import { invalidProviderKeySets, strongerProviderJwks, strongerProviderKeys } from "./helpers/providerKeyFixtures";

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL required; disposable fixtures only.");
const adminPool = new Pool({ connectionString: url, max: 8 });
const roles = ["identity", "app", "issuer", "signer", "observer", "reader"] as const;
type Role = typeof roles[number];
const loginPool = (role: string) => new Pool({ ...parse(url!), user: `provider_fixture_${role}`, password: "disposable-provider-fixture-only", max: 4 } as PoolConfig);
const db = Object.fromEntries(roles.map(role => [role, loginPool(role)])) as Record<Role, Pool>;
const deploymentId = "15bf00ae-094e-4ca9-881d-1f08b4c7d4aa";
let databaseName: string, identityOwner: string;
function expected(role: Role): DeploymentExpectation { return { deploymentId, environment: providerContract.environment, databaseName, login: `provider_fixture_${role}`, credentialGeneration: "1", schemaOwner: "pg_database_owner", identityOwner }; }
const identities = new PostgresIdentityPersistence(db.identity);
let verifier: ProviderTokenVerifier, sessionService: ProviderSessionAuthority, gate: ProviderConsentGate;
let accountId: string, sessionId: string, version: string, principalId: string;
let router: ReturnType<typeof createEconomicEvidenceIngestion>["consentRouter"];
let composition: Awaited<ReturnType<typeof createTrustedAuthorityComposition>>;
let server: ReturnType<ReturnType<typeof express>["listen"]>, baseUrl: string;
const fixture = JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json", "utf8"));
const config = devnetUsdcConfiguration(fixture.qualifiedAsset.network.genesisHash, "2026-01-01T00:00:00.000Z");
const registry = new TrustedRegistryAdministration(adminPool);
const user = Keypair.fromSeed(new Uint8Array(32).fill(1)), sponsor = Keypair.fromSeed(new Uint8Array(32).fill(2));
const policy: EvidencePolicy = { auth: { issuer: providerContract.issuer, audience: providerContract.audience, requiredScope: "confirm:economic", publicKey: providerKeys.publicKey.export({ type: "spki", format: "pem" }) }, runtimeIssuer: "runtime:test-authority", policyVersions: ["policy-v1"], context: "production" };
const runtime = new SyntheticRuntimeIssuer(policy.runtimeIssuer);
function identityService() { return new ProviderSessionAuthority(new AuthorityProcess("identity", db.identity, expected("identity")), verifier, 3600); }
function rebuildGate() { gate = new ProviderConsentGate(new AuthorityProcess("issuer", db.issuer, expected("issuer")), verifier); router = createEconomicEvidenceIngestion(db.issuer, policy, runtime, gate).consentRouter; }

before(async () => {
  databaseName = (await adminPool.query("SELECT current_database() AS name")).rows[0].name;
  identityOwner = (await adminPool.query("SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid='accounts'::regclass")).rows[0].name;
  for (const role of roles) {
    const name = `provider_fixture_${role}`;
    if (!(await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rowCount)
      await adminPool.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'disposable-provider-fixture-only'`);
    await adminPool.query(`GRANT zephipay_economic_${role} TO ${name}`);
  }
  await installSyntheticStore(adminPool);
  const app = express();
  app.use("/fixture-consent", (req, res, next) => router(req, res, next));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}/fixture-consent`;
});
beforeEach(async () => {
  await adminPool.query("TRUNCATE economic_synthetic.signer_plans,economic_synthetic.signer_operations,economic_synthetic.observer_plans");
  await adminPool.query("TRUNCATE economic_authority_events,economic_network_registry,economic_sponsor_budgets,accounts,economic_deployment_identity,economic_deployment_logins RESTART IDENTITY CASCADE");
  await adminPool.query("INSERT INTO economic_deployment_identity(deployment_id,environment,database_name,provider_key_revision) VALUES($1,$2,$3,1)", [deploymentId, providerContract.environment, databaseName]);
  for (const role of roles) await adminPool.query("INSERT INTO economic_deployment_logins VALUES($1,$2,1)", [role, `provider_fixture_${role}`]);
  verifier = await ProviderTokenVerifier.create(providerContract, { revision: 1, jwks: providerJwks }); sessionService = identityService(); rebuildGate();
  const provisioned = await identities.provisionExternalIdentity({ accountId: randomUUID(), identityId: randomUUID(), issuer: providerContract.issuer, subject: "subject:alice", occurredAt: new Date(Date.now() - 60000).toISOString() });
  accountId = provisioned.account.accountId; principalId = provisioned.account.actorSubject; sessionId = randomUUID();
  const created = await identities.createAccountSession({ accountId, sessionId, expectedAccountVersion: provisioned.account.version, createdAt: new Date(Date.now() - 30000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  version = created.account.version.toString();
  await sessionService.bind(await providerToken(), sessionId, version);
  await registry.install(config);
  composition = await createTrustedAuthorityComposition({ mode: "synthetic-internal", connections: {app:db.app,issuer:db.issuer,signer:db.signer,observer:db.observer,reader:db.reader}, identities, policy, runtime,
    signer: new DurableSyntheticSigner(db.signer), observer: new DurableSyntheticObserver(db.observer), expectedSignerSource: "synthetic-signer-v1", expectedObserverSource: "synthetic-observer-v1" });
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await Promise.all([...Object.values(db), adminPool].map(p => p.end())); });
function envelope() {
  const e = JSON.parse(JSON.stringify(fixture.envelope));
  e.principal.id = principalId; e.attempt.intentId = randomUUID(); e.attempt.attemptId = randomUUID(); e.attempt.fenceToken = randomUUID();
  e.createdAt = new Date(Date.now() - 60000).toISOString(); e.expiresAt = new Date(Date.now() + 3600000).toISOString();
  e.runtime.decisionId = randomUUID(); e.runtime.validFrom = e.createdAt; e.runtime.validUntil = e.expiresAt; e.runtime.scope = "production";
  return createEconomicIntentEnvelopeV1(e, e.amount.asset);
}
async function prepare() { const e = envelope(), digest = await composition.prepare(e, fixture.recentBlockhash); return { e, digest }; }
async function confirm(digest: string, raw?: string, accountVersion = version) {
  const token = raw ?? await providerToken();
  return fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ envelopeDigest: digest, accountVersion }) });
}
async function prepared() {
  const p = await prepare(), res = await confirm(p.digest); assert.equal(res.status, 201, await res.clone().text());
  const { consentId } = await res.json() as { consentId: string };
  await composition.issueRuntime(p.digest);
  const tx = Transaction.populate(Message.from(offlineSponsoredMessageV1(p.e, fixture.recentBlockhash))); tx.partialSign(user);
  const claim = { sponsorFinalizationId: randomUUID(), envelopeDigest: p.digest, consentId, customerArtifact: tx.serialize({ requireAllSignatures: false }) };
  await registry.installBudget({ id: "test-budget", network: config.network.identity, sponsorPublicKey: sponsor.publicKey.toBase58(), sponsorKeyVersion: "key-v1", base: "1000000", priority: "200000", rent: "300000000", outstanding: 100 });
  return { ...p, claim };
}
async function revoke() { const a = (await identities.findAccount(accountId))!; return sessionService.revoke(await providerToken(), sessionId, a.version.toString()); }
async function count(table: string) { return Number((await adminPool.query(`SELECT count(*) FROM ${table}`)).rows[0].count); }

for (const role of roles) test(`deployment verifies actual ${role} LOGIN, membership and exact database identity`, async () => {
  const result = await verifyAuthorityLogin(db[role], role, { deployment: expected(role), syntheticFixtures: true });
  assert.equal(result.login, `provider_fixture_${role}`);
});

test("verified provider creates canonical session atomically, refreshed token binds it, consent reaches restricted claim/contact", async () => {
  const bootstrap = await providerToken({ sid: "new-provider-session" });
  const created = await sessionService.create(bootstrap, version); sessionId = created.session.sessionId; version = created.account.version.toString();
  await assert.rejects(() => sessionService.bind(bootstrap, sessionId, version), /predates/);
  await assert.rejects(() => sessionService.create(bootstrap, version), /REPLAY/);
  assert.equal((await identities.listAccountSessions(accountId)).length, 2);
  await new Promise(resolve => setTimeout(resolve, 1100)); // Exact NumericDate second must follow millisecond session creation.
  const now = Math.floor(Date.now() / 1000);
  await sessionService.bind(await providerToken({ sid: "new-provider-session", iat: now }), sessionId, version);
  const p = await prepare(), res = await confirm(p.digest, await providerToken({ sid: "new-provider-session", iat: now }));
  assert.equal(res.status, 201, await res.clone().text());
  const consentId = (await res.json() as any).consentId;
  await composition.issueRuntime(p.digest);
  const tx = Transaction.populate(Message.from(offlineSponsoredMessageV1(p.e, fixture.recentBlockhash))); tx.partialSign(user);
  await registry.installBudget({ id: "test-budget", network: config.network.identity, sponsorPublicKey: sponsor.publicKey.toBase58(), sponsorKeyVersion: "key-v1", base: "1000000", priority: "200000", rent: "300000000", outstanding: 100 });
  const id = randomUUID(); await composition.claim({ sponsorFinalizationId: id, envelopeDigest: p.digest, consentId, customerArtifact: tx.serialize({ requireAllSignatures: false }) });
  await composition.recover(id); // Synthetic UNKNOWN response; no live signer exists.
  assert.equal(await count("economic_signer_contact_authority"), 1);
  assert.equal((await composition.trace(id)).state.account_session_id, sessionId);
  assert.equal((await composition.observe(id)).disposition, "PENDING");
  const use = (await adminPool.query("SELECT * FROM economic_provider_token_uses WHERE action='consent'")).rows[0];
  assert(use.authentication_time < use.issued_at); assert.equal(use.account_version, version);
  assert.equal(use.database_actor, "provider_fixture_issuer");
});

for (const [label, claims] of [
  ["wrong subject", { sub: "subject:bob" }], ["provider binding mismatch", { sid: "other-session" }],
  ["token predates session", { iat: Math.floor(Date.now() / 1000) - 90, auth_time: Math.floor(Date.now() / 1000) - 100 }],
  ["wrong environment", { zep_environment: "wrong" }], ["wrong issuer", { iss: "https://wrong.example/" }],
  ["wrong audience", { aud: "wrong" }], ["stale reauthentication", { auth_time: 1 }],
] as const) test(`consent rejects ${label}`, async () => {
  const p = await prepare(); assert.equal((await confirm(p.digest, await providerToken(claims))).status, 400); assert.equal(await count("economic_consent_evidence"), 0);
});

test("stale account version rejects consent and session mutation", async () => {
  const p = await prepare(); assert.equal((await confirm(p.digest, undefined, "0")).status, 400);
  await assert.rejects(() => sessionService.create("shaped-principal", version), /REJECTED/);
  await assert.rejects(async () => sessionService.create(await providerToken(), "0"), /version/);
});

test("session cannot be rebound; token for another account cannot bind or revoke", async () => {
  const other = await identities.provisionExternalIdentity({ accountId: randomUUID(), identityId: randomUUID(), issuer: providerContract.issuer, subject: "subject:bob", occurredAt: new Date(Date.now()-60000).toISOString() });
  const s = await identities.createAccountSession({ accountId: other.account.accountId, sessionId: randomUUID(), expectedAccountVersion: other.account.version, createdAt: new Date(Date.now() - 5000).toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() });
  await assert.rejects(async () => sessionService.bind(await providerToken(), s.session.sessionId, version), /mismatch/);
  await assert.rejects(async () => sessionService.revoke(await providerToken({ sub: "subject:bob" }), sessionId, s.account.version.toString()), /binding/);
  const own = await identities.createAccountSession({ accountId, sessionId: randomUUID(), expectedAccountVersion: BigInt(version), createdAt: new Date(Date.now() - 5000).toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() });
  await assert.rejects(async () => sessionService.bind(await providerToken(), own.session.sessionId, own.account.version.toString()), /rebound/);
});

for (const stage of ["claim", "contact"] as const) test(`revocation denies future ${stage}; consent history stays immutable`, async () => {
  const p = await prepared(), rows = (await adminPool.query("SELECT * FROM economic_consent_evidence")).rows;
  if (stage === "contact") await composition.claim(p.claim);
  await revoke();
  assert.equal((await confirm(p.digest)).status, 400);
  if (stage === "claim") await assert.rejects(() => composition.claim(p.claim), /session/i);
  else await assert.rejects(() => composition.recover(p.claim.sponsorFinalizationId), /session|eligible|authority/i);
  assert.equal(await count("economic_signer_contact_authority"), 0);
  assert.deepEqual((await adminPool.query("SELECT * FROM economic_consent_evidence")).rows, rows);
  await assert.rejects(() => db.issuer.query("UPDATE economic_provider_token_uses SET action='consent'"), /permission denied/);
});

for (let repetition = 0; repetition < 3; repetition++) test(`durable replay race and reconstruction ${repetition + 1}`, async () => {
  const p = await prepare(), raw = await providerToken();
  const responses = await Promise.all([confirm(p.digest, raw), confirm(p.digest, raw)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]); assert.equal(await count("economic_consent_evidence"), 1);
  rebuildGate(); assert.equal((await confirm(p.digest, raw)).status, 400);
  const q = await prepare(); assert.equal((await confirm(q.digest, raw)).status, 400);
});

for (let repetition = 0; repetition < 3; repetition++) test(`revocation while token verification awaits is authoritative ${repetition + 1}`, async () => {
  const p = await prepare(), original = verifier.verify.bind(verifier);
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => reached = resolve), resumed = new Promise<void>(resolve => release = resolve);
  verifier.verify = async (raw, action) => { const proof = await original(raw, action); if (action === "consent") { reached(); await resumed; } return proof; };
  const request = confirm(p.digest); await entered;
  try { await revoke(); } finally { release(); }
  assert.equal((await request).status, 400); assert.equal(await count("economic_consent_evidence"), 0);
});

for (const field of ["deploymentId", "environment", "databaseName", "login", "credentialGeneration"] as const) test(`deployment rejects wrong ${field}`, async () => {
  await assert.rejects(() => verifyAuthorityLogin(db.app, "app", { deployment: { ...expected("app"), [field]: "wrong" } }), /mismatch/);
});

test("missing deployment registration and administrator fallback fail closed", async () => {
  await adminPool.query("DELETE FROM economic_deployment_identity");
  await assert.rejects(() => gate.readiness(), /mismatch/);
  await assert.rejects(() => verifyAuthorityLogin(adminPool, "issuer"), /ACL readiness/);
});

test("credential rotation rejects stale established pools; replacement LOGIN passes", async () => {
  const name = "provider_fixture_issuer_rotated";
  if (!(await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rowCount)
    await adminPool.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'disposable-provider-fixture-only'`);
  await adminPool.query(`GRANT zephipay_economic_issuer TO ${name}`);
  const next = loginPool("issuer_rotated");
  try {
    await db.issuer.query("SELECT 1");
    await adminPool.query("UPDATE economic_deployment_logins SET login_name=$1,credential_generation=2 WHERE authority_role='issuer'", [name]);
    await assert.rejects(() => gate.readiness(), /mismatch/);
    assert.equal((await confirm((await prepare()).digest)).status, 400);
    const process = new AuthorityProcess("issuer", next, { ...expected("issuer"), login: name, credentialGeneration: "2" });
    await process.readiness();
    await assert.rejects(() => new AuthorityProcess("issuer", next, { ...expected("issuer"), login: name }).readiness(), /generation/);
  } finally { await next.end(); }
});

test("startup unexpected grant, PUBLIC leakage and cross-role inheritance are rejected", async () => {
  await adminPool.query("GRANT SELECT ON economic_provider_token_uses TO provider_fixture_reader");
  try { await assert.rejects(() => verifyAuthorityLogin(db.reader, "reader", { deployment: expected("reader") }), /grant mismatch/); }
  finally { await adminPool.query("REVOKE SELECT ON economic_provider_token_uses FROM provider_fixture_reader"); }
  await adminPool.query("GRANT SELECT ON economic_deployment_identity TO PUBLIC");
  try { await assert.rejects(() => gate.readiness(), /PUBLIC/); }
  finally { await adminPool.query("REVOKE SELECT ON economic_deployment_identity FROM PUBLIC"); }
  await adminPool.query("GRANT zephipay_economic_identity TO provider_fixture_issuer");
  try { await assert.rejects(() => gate.readiness(), /inherited/); }
  finally { await adminPool.query("REVOKE zephipay_economic_identity FROM provider_fixture_issuer"); }
});

for (const role of roles) test(`compromised ${role} credential cannot own the full authority chain`, async () => {
  const capabilities = (await db[role].query(`SELECT
    has_table_privilege(current_user,'account_sessions','INSERT') AS session,
    has_column_privilege(current_user,'economic_consent_evidence','consent_id','INSERT') AS consent,
    has_column_privilege(current_user,'economic_finalizations','finalization_id','INSERT') AS claim,
    has_column_privilege(current_user,'economic_finalizations','result_artifact','UPDATE') AS signer,
    has_function_privilege(current_user,'economic_ingest_observation(uuid,text,jsonb)','EXECUTE') AS observer`)).rows[0];
  assert.equal(Object.values(capabilities).every(Boolean), false);
  assert.equal(capabilities.session, role === "identity"); assert.equal(capabilities.consent, role === "issuer");
  assert.equal(capabilities.claim, role === "app"); assert.equal(capabilities.signer, role === "signer"); assert.equal(capabilities.observer, role === "observer");
  const denied = role === "identity" ? "INSERT INTO economic_consent_evidence(consent_id) VALUES(gen_random_uuid())" :
    role === "issuer" ? "UPDATE account_sessions SET revoked_at=clock_timestamp()" :
    role === "app" ? "UPDATE economic_finalizations SET result_artifact='\\x00'" :
    role === "signer" ? "SELECT economic_ingest_observation(gen_random_uuid(),'forged','{}')" :
    "INSERT INTO economic_consent_evidence(consent_id) VALUES(gen_random_uuid())";
  await assert.rejects(() => db[role].query(denied), /permission denied/);
  await assert.rejects(() => db[role].query("UPDATE economic_deployment_logins SET credential_generation=99"), /permission denied/);
});

test("canonical expiry and disabled account block provider binding and consent", async () => {
  const expired = await identities.createAccountSession({ accountId, sessionId: randomUUID(), expectedAccountVersion: BigInt(version),
    createdAt: new Date(Date.now()-10000).toISOString(), expiresAt: new Date(Date.now()-5000).toISOString() });
  version = expired.account.version.toString();
  await assert.rejects(async () => sessionService.bind(await providerToken({sid:"expired"}), expired.session.sessionId, version), /expired/);
  const p=await prepare();
  const disabled=await identities.updateAccountStatus({accountId,expectedVersion:BigInt(version),status:"SUSPENDED"});version=disabled.version.toString();
  assert.equal((await confirm(p.digest)).status,400);
});

test("provider key revision changed during token validation rejects stale proof without consuming it", async () => {
  const p=await prepare(),original=verifier.verify.bind(verifier);
  verifier.verify=async(raw,action)=>{const proof=await original(raw,action);await verifier.replaceKeys({revision:2,jwks:providerJwks});return proof;};
  assert.equal((await confirm(p.digest)).status,400);
  assert.equal(await count("economic_consent_evidence"),0);
  assert.equal((await adminPool.query("SELECT count(*) FROM economic_provider_token_uses WHERE action='consent'")).rows[0].count,"0");
});

test("recent-auth deadline bounds consent, independently of token expiration", async () => {
  const p=await prepare(),now=Math.floor(Date.now()/1000);
  assert.equal((await confirm(p.digest,await providerToken({auth_time:now-100,exp:now+240}))).status,201);
  const row=(await adminPool.query("SELECT expires_at,authenticated_at FROM economic_consent_evidence")).rows[0];
  assert.equal(row.expires_at.getTime(),(now+20)*1000);
  assert(row.authenticated_at.getTime()>(now-100)*1000); // Historical authenticated_at still means token iat.
});

test("same provider jti signed for another action cannot be substituted after use", async () => {
  const p=await prepare(),jti="shared-jti";
  await sessionService.bind(await providerToken({jti}),sessionId,version);
  assert.equal((await confirm(p.digest,await providerToken({jti}))).status,400);
});

test("ownership drift and admin-option membership fail deployment readiness", async () => {
  await adminPool.query("ALTER TABLE economic_deployment_identity OWNER TO CURRENT_USER");
  try {await assert.rejects(()=>gate.readiness(),/ownership mismatch/);}
  finally {await adminPool.query("ALTER TABLE economic_deployment_identity OWNER TO zephipay_economic_admin");}
  await adminPool.query("GRANT zephipay_economic_issuer TO provider_fixture_issuer WITH ADMIN OPTION");
  try {await assert.rejects(()=>gate.readiness(),/administration/);}
  finally {await adminPool.query("REVOKE ADMIN OPTION FOR zephipay_economic_issuer FROM provider_fixture_issuer");}
});

test("NOLOGIN retirement rejects a still-connected process", async () => {
  await db.issuer.query("SELECT 1");await adminPool.query("ALTER ROLE provider_fixture_issuer NOLOGIN");
  try {await assert.rejects(()=>gate.readiness(),/unsafe login/);}
  finally {await adminPool.query("ALTER ROLE provider_fixture_issuer LOGIN");}
});

test("reconstructed service with retired provider key snapshot fails until current snapshot is installed", async () => {
  await adminPool.query("UPDATE economic_deployment_identity SET provider_key_revision=2");
  verifier=await ProviderTokenVerifier.create(providerContract,{revision:1,jwks:providerJwks});sessionService=identityService();rebuildGate();
  await assert.rejects(()=>sessionService.readiness(),/snapshot/);await assert.rejects(()=>gate.readiness(),/snapshot/);
  verifier=await ProviderTokenVerifier.create(providerContract,{revision:2,jwks:providerJwks});sessionService=identityService();rebuildGate();
  await sessionService.readiness();await gate.readiness();
  assert.equal((await confirm((await prepare()).digest)).status,201);
});

test("credential generation changed while work awaits rolls back the operation", async () => {
  const process=new AuthorityProcess("identity",db.identity,expected("identity"));
  const old=(await identities.findAccount(accountId))!;
  await assert.rejects(()=>process.run(async client=>{
    await client.query("INSERT INTO economic_provider_token_uses(token_id,token_digest,account_session_id,account_version,action,resource_reference,issued_at,key_revision) VALUES($1,$2,$3::uuid,$4,'bind-session',$3::text,clock_timestamp(),1)",['ac'.repeat(32),'bd'.repeat(32),sessionId,version]);
    await adminPool.query("UPDATE economic_deployment_logins SET credential_generation=2 WHERE authority_role='identity'");
  }),/generation/);
  assert.equal((await adminPool.query("SELECT count(*) FROM economic_provider_token_uses WHERE token_id=$1",['ac'.repeat(32)])).rows[0].count,'0');
  assert.equal((await identities.findAccount(accountId))!.version,old.version);
});

test("standalone deployment verifier runs under the actual LOGIN and fails missing/wrong configuration", async () => {
  const connection=new URL(url!);connection.searchParams.set("user","provider_fixture_issuer");connection.searchParams.set("password","disposable-provider-fixture-only");
  const env={...process.env,DATABASE_URL:connection.toString(),ECONOMIC_DEPLOYMENT_ID:deploymentId,ECONOMIC_DEPLOYMENT_ENVIRONMENT:providerContract.environment,
    ECONOMIC_DATABASE_NAME:databaseName,ECONOMIC_LOGIN_NAME:"provider_fixture_issuer",ECONOMIC_CREDENTIAL_GENERATION:"1",ECONOMIC_SCHEMA_OWNER:"pg_database_owner",ECONOMIC_IDENTITY_OWNER:identityOwner};
  const command=["run","db:economic:verify","--","issuer","--deployment"];
  const result=await promisify(execFile)("npm",command,{env});assert.match(result.stdout,/deployment login readiness passed/);
  for(const wrong of [{ECONOMIC_DEPLOYMENT_ENVIRONMENT:"wrong"},{ECONOMIC_LOGIN_NAME:""}])
    await assert.rejects(()=>promisify(execFile)("npm",command,{env:{...env,...wrong}}));
});

for(const column of [false,true])test(`deployment rejects ${column?'column':'table'} grant option on an otherwise allowed privilege`,async()=>{
  const grant=column?'SELECT(deployment_id)':'SELECT';
  await adminPool.query(`GRANT ${grant} ON economic_deployment_identity TO provider_fixture_issuer WITH GRANT OPTION`);
  try {await assert.rejects(()=>gate.readiness(),/grant option/);}
  finally {await adminPool.query(`REVOKE ${grant} ON economic_deployment_identity FROM provider_fixture_issuer`);}
});

for (const {name,jwks} of invalidProviderKeySets) test(`AUD-PSCI-01: both readiness surfaces reject ${name} without a JWT`,async()=>{
  verifier=new ProviderTokenVerifier(providerContract);sessionService=identityService();rebuildGate();
  let presentedTokens=0;
  verifier.verify=async()=>{presentedTokens++;throw new Error("No token may be needed for readiness");};
  await assert.rejects(()=>verifier.replaceKeys({revision:1,jwks}),/INITIALIZATION_REJECTED/);
  await assert.rejects(()=>sessionService.readiness(),/NOT_INITIALIZED/);
  await assert.rejects(()=>gate.readiness(),/NOT_INITIALIZED/);
  assert.equal(presentedTokens,0);
});

test("AUD-PSCI-01: cryptographic import failure cannot make either surface ready",async t=>{
  const original=crypto.subtle.importKey.bind(crypto.subtle);let imports=0;
  t.mock.method(crypto.subtle,"importKey",async(...args:any[])=>{
    if(args[0]==="jwk"&&args[1].kid==="fixture-stronger"){imports++;throw new Error("synthetic cryptographic import failure");}
    return (original as any)(...args);
  });
  verifier=new ProviderTokenVerifier(providerContract);sessionService=identityService();rebuildGate();
  await assert.rejects(()=>verifier.replaceKeys({revision:1,jwks:strongerProviderJwks}),/INITIALIZATION_REJECTED/);
  assert.equal(imports,1);
  await assert.rejects(()=>sessionService.readiness(),/NOT_INITIALIZED/);
  await assert.rejects(()=>gate.readiness(),/NOT_INITIALIZED/);
});

test("AUD-PSCI-01: neither surface is ready during initialization; both require ACL and durable revision afterward",async t=>{
  const original=crypto.subtle.importKey.bind(crypto.subtle);let release!:()=>void;
  const waiting=new Promise<void>(resolve=>release=resolve);
  t.mock.method(crypto.subtle,"importKey",async(...args:any[])=>{
    if(args[0]==="jwk"&&args[1].kid==="fixture-stronger")await waiting;
    return (original as any)(...args);
  });
  verifier=new ProviderTokenVerifier(providerContract);sessionService=identityService();rebuildGate();
  const initializing=verifier.replaceKeys({revision:1,jwks:strongerProviderJwks});
  try {
    await assert.rejects(()=>sessionService.readiness(),/NOT_INITIALIZED/);
    await assert.rejects(()=>gate.readiness(),/NOT_INITIALIZED/);
  } finally {release();}
  await initializing;
  await sessionService.readiness();await gate.readiness();
  await adminPool.query("GRANT SELECT ON economic_finalizations TO provider_fixture_identity,provider_fixture_issuer");
  try {await assert.rejects(()=>sessionService.readiness(),/ACL readiness/);await assert.rejects(()=>gate.readiness(),/ACL readiness/);}
  finally {await adminPool.query("REVOKE SELECT ON economic_finalizations FROM provider_fixture_identity,provider_fixture_issuer");}
  await adminPool.query("UPDATE economic_deployment_identity SET provider_key_revision=2");
  await assert.rejects(()=>sessionService.readiness(),/snapshot/);await assert.rejects(()=>gate.readiness(),/snapshot/);
  await adminPool.query("UPDATE economic_deployment_identity SET provider_key_revision=1,environment='wrong'");
  await assert.rejects(()=>sessionService.readiness(),/mismatch/);await assert.rejects(()=>gate.readiness(),/mismatch/);
});

test("AUD-PSCI-01: failed replacement retains accepted snapshot; valid 3072-bit replacement restores revision-matched readiness",async()=>{
  await assert.rejects(()=>verifier.replaceKeys({revision:2,jwks:invalidProviderKeySets[0].jwks}),/INITIALIZATION_REJECTED/);
  assert.equal(verifier.keyRevision,1);await sessionService.readiness();await gate.readiness();
  await adminPool.query("UPDATE economic_deployment_identity SET provider_key_revision=2");
  await assert.rejects(()=>sessionService.readiness(),/snapshot/);await assert.rejects(()=>gate.readiness(),/snapshot/);
  await verifier.replaceKeys({revision:2,jwks:strongerProviderJwks});
  assert.equal(verifier.keyRevision,2);await sessionService.readiness();await gate.readiness();
  const stale=await ProviderTokenVerifier.create(providerContract,{revision:1,jwks:providerJwks});
  await assert.rejects(()=>new ProviderSessionAuthority(new AuthorityProcess("identity",db.identity,expected("identity")),stale,3600).readiness(),/snapshot/);
  await assert.rejects(()=>new ProviderConsentGate(new AuthorityProcess("issuer",db.issuer,expected("issuer")),stale).readiness(),/snapshot/);
  await assert.rejects(()=>verifier.replaceKeys({revision:1,jwks:providerJwks}),/increase/);
  assert.equal((await confirm((await prepare()).digest,await providerToken({}, {kid:"fixture-stronger"},strongerProviderKeys.privateKey))).status,201);
});

for(let iteration=0;iteration<3;iteration++)test(`AUD-PSCI-01: invalid replacement loses rotation race and replay remains durable ${iteration+1}`,async()=>{
  const p=await prepare(),jti="spent-before-rotation";
  assert.equal((await confirm(p.digest,await providerToken({jti}))).status,201);
  const results=await Promise.allSettled([
    verifier.replaceKeys({revision:2,jwks:strongerProviderJwks}),
    verifier.replaceKeys({revision:3,jwks:invalidProviderKeySets[0].jwks}),
  ]);
  assert.deepEqual(results.map(r=>r.status),["fulfilled","rejected"]);assert.equal(verifier.keyRevision,2);
  await adminPool.query("UPDATE economic_deployment_identity SET provider_key_revision=2");
  await sessionService.readiness();await gate.readiness();
  const q=await prepare();
  const substituted=await providerToken({jti},{kid:"fixture-stronger"},strongerProviderKeys.privateKey);
  assert.equal((await confirm(q.digest,substituted)).status,400);
  const fresh=await providerToken({}, {kid:"fixture-stronger"},strongerProviderKeys.privateKey);
  const responses=await Promise.all([confirm(q.digest,fresh),confirm(q.digest,fresh)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,400]);
  assert.equal(await count("economic_consent_evidence"),2);
});
