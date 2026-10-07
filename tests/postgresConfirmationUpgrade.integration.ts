import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Pool, type PoolConfig } from "pg";
import { parse } from "pg-connection-string";
import { createEconomicIntentEnvelopeV1 } from "zephyon-protocol";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { PostgresFinalizationRepository } from "../src/economic/foundation/postgresFinalizationRepository";
import { TrustedRegistryAdministration, devnetUsdcConfiguration } from "../src/economic/foundation/trustedRegistry";
import { profileFixture } from "./helpers/realProviderFixtures";

test("028 through 031 preserves historical evidence, quarantines legacy bridge authority, closes old grants and repeats safely",async()=>{
  const url=process.env.TEST_DATABASE_URL?.trim();assert(url,"Disposable TEST_DATABASE_URL required");
  const root=new Pool({connectionString:url}), name=`confirmation_upgrade_${randomUUID().replaceAll("-","").slice(0,12)}`;
  const folder=await mkdtemp(join(tmpdir(),"confirmation-upgrade-"));const project=process.cwd();let pool:Pool|undefined;
  const run=promisify(execFile), targetUrl=new URL(url);targetUrl.pathname=`/${name}`;
  const migrate=()=>run(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("scripts/run-migrations.ts")],
    {cwd:folder,env:{...process.env,DATABASE_URL:targetUrl.toString()}});
  try {
    await root.query(`CREATE DATABASE ${name}`);pool=new Pool({...parse(url),database:name} as PoolConfig);
    await mkdir(join(folder,"migrations"));
    for(const file of (await readdir("migrations")).filter(v=>/^0(?:0|1|2[0-8])/.test(v)&&v.endsWith(".sql")))
      await writeFile(join(folder,"migrations",file),await readFile(join("migrations",file)));
    await migrate();assert.equal((await pool.query("SELECT count(*)::integer AS n FROM payment_schema_migrations")).rows[0].n,28);
    const f=JSON.parse(await readFile("tests/fixtures/economic-intent-v1.json","utf8")), profile=profileFixture({databaseName:name});
    await pool.query("INSERT INTO economic_deployment_identity(deployment_id,environment,database_name,provider_key_revision) VALUES($1,$2,$3,1)",
      [profile.deploymentId,profile.environment,name]);
    const identities=new PostgresIdentityPersistence(pool), identity=await identities.provisionExternalIdentity({accountId:randomUUID(),identityId:randomUUID(),
      issuer:profile.issuer,subject:"upgrade:alice",occurredAt:new Date(Date.now()-60000).toISOString()});
    const session=randomUUID();await identities.createAccountSession({accountId:identity.account.accountId,sessionId:session,expectedAccountVersion:identity.account.version,
      createdAt:new Date(Date.now()-30000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString()});
    await new TrustedRegistryAdministration(pool).install(devnetUsdcConfiguration(f.qualifiedAsset.network.genesisHash,"2026-01-01T00:00:00.000Z"));
    const e=structuredClone(f.envelope);e.principal.id=identity.account.actorSubject;e.createdAt=new Date(Date.now()-10000).toISOString();e.expiresAt=new Date(Date.now()+300000).toISOString();
    e.runtime.validFrom=e.createdAt;e.runtime.validUntil=e.expiresAt;
    const envelope=createEconomicIntentEnvelopeV1(e,e.amount.asset),repo=new PostgresFinalizationRepository(pool,{auth:{issuer:profile.issuer,audience:profile.audience,
      requiredScope:"confirm:economic"},runtimeIssuer:"runtime:upgrade",policyVersions:["policy-v1"],context:"devnet-test"});
    const digest=await repo.registerAttempt(envelope,f.recentBlockhash),payload="{}",fingerprint=createHash("sha256").update(payload).digest("hex");
    await pool.query("INSERT INTO economic_confirmation_policies(fingerprint,deployment_id,revision,payload,signature) VALUES($1,$2,1,$3,$4)",[fingerprint,profile.deploymentId,payload,"a".repeat(86)]);
    await pool.query("INSERT INTO economic_confirmation_policy_heads VALUES($1,$2,1)",[profile.deploymentId,fingerprint]);
    const challenge=randomUUID(),consent=randomUUID(),generic=randomUUID(),requested=new Date(Date.now()-2000),at=new Date(Date.now()-1000),expires=new Date(Date.now()+60000);
    await pool.query(`INSERT INTO economic_confirmation_challenges(challenge_id,request_id,account_id,principal_id,account_session_id,account_version,envelope_digest,intent_id,generation,
      action,environment,issuer,provider_subject,configuration,configuration_revision,policy_fingerprint,policy_revision,provider_revision,authentication_digest,transaction_id,nonce,requested_at,expires_at,reauthentication)
      VALUES($1,$2,$3,$4,$5,999,$6,$7,1,'confirm-economic-intent',$8,$9,'upgrade:alice',$10,999,$11,999,999,$10,$12,$10,$13,$14,'{}')`,
      [challenge,randomUUID(),identity.account.accountId,identity.account.actorSubject,session,digest,e.attempt.intentId,profile.environment,profile.issuer,"00".repeat(32),fingerprint,randomUUID(),requested,expires]);
    for(const [id,reference] of [[consent,`zephipay:canonical:${session}`],[generic,"generic-existing-provider-session"]]) {
      await pool.query("INSERT INTO economic_session_bindings(issuer,provider_subject,provider_session_reference,account_session_id) VALUES($1,'upgrade:alice',$2,$3)",
        [profile.issuer,reference,session]);
      await pool.query(`INSERT INTO economic_consent_evidence(consent_id,envelope_digest,principal_id,issuer,audience,context,provider_subject,authentication_reference,
        session_reference,authenticated_at,confirmed_at,expires_at,account_session_id) VALUES($1,$2,$3,$4,$5,'zephipay-economic-consent-v1','upgrade:alice',$6,$7,$8,$8,$9,$10)`,
      [id,digest,identity.account.actorSubject,profile.issuer,profile.audience,"00".repeat(32),reference,at,expires,session]);
    }
    await pool.query(`INSERT INTO economic_confirmation_consumptions(challenge_id,consent_id,authentication_digest,reauthentication_digest,confirmation_request_digest,
      authentication_time,assurance,confirmed_at,expires_at) VALUES($1,$2,$3,$3,$3,$4,'unapproved',$4,$5)`,[challenge,consent,"00".repeat(32),at,expires]);
    assert.equal((await pool.query("SELECT state FROM economic_confirmation_summary")).rows[0].state,"CONFIRMED");
    const before={challenges:(await pool.query("SELECT * FROM economic_confirmation_challenges")).rows,consumptions:(await pool.query("SELECT * FROM economic_confirmation_consumptions")).rows,
      generic:(await pool.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[generic])).rows};
    // Reproduce 028 column-level grants; REVOKE at table level alone would not close them.
    await pool.query("GRANT INSERT(challenge_id),UPDATE(challenge_id) ON economic_confirmation_challenges,economic_confirmation_consumptions TO zephipay_economic_issuer");
    await writeFile(join(folder,"migrations/029_confirmation_database_authority.sql"),await readFile("migrations/029_confirmation_database_authority.sql"));
    await migrate();
    assert.equal((await pool.query("SELECT has_column_privilege('zephipay_economic_issuer','economic_confirmation_consumptions','challenge_id','INSERT') AS allowed")).rows[0].allowed,false);
    assert.deepEqual((await pool.query("SELECT * FROM economic_confirmation_challenges")).rows,before.challenges);
    assert.deepEqual((await pool.query("SELECT * FROM economic_confirmation_consumptions")).rows,before.consumptions);
    assert.deepEqual((await pool.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1",[generic])).rows,before.generic);
    assert((await pool.query("SELECT revoked_at FROM economic_consent_evidence WHERE consent_id=$1",[consent])).rows[0].revoked_at);
    assert.equal((await pool.query("SELECT state FROM economic_confirmation_summary")).rows[0].state,"LEGACY_UNVERIFIED");
    const repeat=await migrate();assert(!repeat.stdout.includes("Applied"));
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM payment_schema_migrations")).rows[0].n,29);
    await writeFile(join(folder,"migrations/030_confirmation_sdk_transactions.sql"),await readFile("migrations/030_confirmation_sdk_transactions.sql"));
    await migrate();
    assert.deepEqual((await pool.query("SELECT * FROM economic_confirmation_challenges")).rows,before.challenges);
    assert.deepEqual((await pool.query("SELECT * FROM economic_confirmation_consumptions")).rows,before.consumptions);
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM economic_confirmation_sdk_transactions")).rows[0].n,0);
    await writeFile(join(folder,"migrations/031_payment_economic_preparation.sql"),await readFile("migrations/031_payment_economic_preparation.sql"));
    await migrate();
    assert.deepEqual((await pool.query("SELECT envelope FROM economic_envelopes WHERE envelope_digest=$1",[digest])).rows[0].envelope,createEconomicIntentEnvelopeV1(e,e.amount.asset));
    assert.deepEqual((await pool.query("SELECT * FROM economic_confirmation_challenges")).rows,before.challenges);
    assert.deepEqual((await pool.query("SELECT * FROM economic_confirmation_consumptions")).rows,before.consumptions);
    await pool.query(await readFile(join(project,"sql/economic-database-roles-v1.sql"),"utf8"));
    await pool.query(await readFile(join(project,"sql/economic-database-roles-v1.sql"),"utf8"));
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM payment_schema_migrations")).rows[0].n,31);
    assert(!(await migrate()).stdout.includes("Applied"));
    assert.equal((await pool.query("SELECT has_function_privilege('zephipay_economic_issuer','economic_admit_confirmation(uuid,uuid,uuid,text,uuid,text)','EXECUTE') AS admitted")).rows[0].admitted,true);
    assert.equal((await pool.query("SELECT has_function_privilege('zephipay_economic_issuer','economic_record_confirmation_proof(uuid,jsonb)','EXECUTE') AS allowed")).rows[0].allowed,false);
  } finally {
    await pool?.end();await root.query(`DROP DATABASE IF EXISTS ${name}`);await root.end();await rm(folder,{recursive:true,force:true});
  }
});
