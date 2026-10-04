import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test, mock } from "node:test";
import { sha256 } from "../src/economic/foundation/database";
import { loadDeploymentProfile, readinessRoles } from "../src/economic/readiness/deploymentProfile";
import { Auth0Snapshots } from "../src/economic/readiness/auth0Snapshots";
import { Auth0AuthenticationVerifier } from "../src/economic/readiness/auth0Authentication";
import { ReadinessServiceTransport, type TransportReplayLedger } from "../src/economic/readiness/serviceTransport";
import { configurationKeys, distributionKeys, deploymentFixture, profileFixture, readyFixture, snapshotFixture, headFixture, signedFixture, serviceKeys, accessFixture } from "./helpers/realProviderFixtures";
import { providerJwks, providerKeys, providerContract } from "./helpers/providerTokens";
import { ProviderTokenVerifier } from "../src/economic/provider/providerTokenVerifier";
import { invalidProviderKeySets, strongerProviderJwks, strongerProviderKeys } from "./helpers/providerKeyFixtures";

for(const [field,value] of Object.entries({issuer:"https://other.example/",audience:"other-api",clientId:"other-client",environment:"production",keySource:"https://evil.example/jwks",databaseHost:"clone.example",revision:2}))
 test(`authenticated configuration rejects unapproved ${field}`,()=>{
  const d=deploymentFixture();assert.throws(()=>loadDeploymentProfile(signedFixture({...d.configuration.profile,[field]:value}),configurationKeys.publicKey,d.expected),/provenance/);
 });
test("configuration rejects forged signature, unsigned shapes, wrong dialect and source",()=>{
 const d=deploymentFixture();assert.throws(()=>loadDeploymentProfile({...d.artifact,signature:"A".repeat(86)},configurationKeys.publicKey,d.expected));
 for(const change of [{issuer:"http://economic-auth.example/"},{dialect:"rfc9068"},{keySource:"https://other.example/jwks"},{mode:"production"}])assert.throws(()=>deploymentFixture(profileFixture(change as any)));
});
for(const {name,jwks} of invalidProviderKeySets)test(`Auth0 source rejects ${name} before readiness`,async()=>{
 const d=deploymentFixture(),s=snapshotFixture(d.configuration,1,JSON.parse(JSON.stringify(jwks,(_key,value)=>value===undefined?null:value))),head=headFixture(d.configuration,s);
 const snapshots=new Auth0Snapshots(d.configuration,distributionKeys.publicKey,async()=>head);
 await assert.rejects(async()=>snapshots.install(s));await assert.rejects(async()=>snapshots.current(),/not initialized/);
});
test("Auth0 x5c/thumbprints are explicit public metadata projection; generic key profile remains strict",async()=>{
 const d=deploymentFixture(),jwks=structuredClone(providerJwks);Object.assign(jwks.keys[0],{x5c:[Buffer.from('fixture-public-certificate-metadata').toString('base64')],x5t:Buffer.alloc(20,1).toString('base64url')});
 const s=snapshotFixture(d.configuration,1,jwks),head=headFixture(d.configuration,s),snapshots=new Auth0Snapshots(d.configuration,distributionKeys.publicKey,async()=>head);
 const provenance=await snapshots.install(s);assert.equal(provenance.fingerprint,sha256(s.payload));assert.equal(provenance.normalizedKeysFingerprint,sha256(JSON.stringify(providerJwks)));
 await assert.rejects(async()=>ProviderTokenVerifier.create(providerContract,{revision:1,jwks}));
});
for(const change of [{issuer:"https://evil.example/"},{source:"https://evil.example/jwks"},{environment:"other"},{adapter:"other"},{obtainedAt:Math.floor(Date.now()/1000)+100},{validUntil:1},{previousRevision:1}])
 test(`snapshot rejects provenance/lifetime ${Object.keys(change)[0]}`,async()=>{const f=await readyFixture();await assert.rejects(async()=>f.snapshots.install(snapshotFixture(f.configuration,1,providerJwks,change)));assert.equal((await f.snapshots.current()).provenance.revision,1);});
test("outage retains bounded accepted keys; startup cache needs authenticated current registration",async()=>{
 const f=await readyFixture();await assert.rejects(async()=>f.snapshots.refresh({acquire:async()=>{throw new Error('fixture outage');}}),/outage/);
 await f.auth.verifyAccess(await accessFixture(),"read:account");
 const reconstructed=new Auth0Snapshots(f.configuration,distributionKeys.publicKey,async()=>f.state.head);await reconstructed.install(JSON.parse(JSON.stringify(f.snapshot)));await reconstructed.current();
 f.state.unavailable=true;await assert.rejects(async()=>f.auth.verifyAccess('invalid',"read:account"));await assert.rejects(async()=>f.snapshots.current(),/unavailable/);
});
test("stronger key cutover rejects old reconstructed snapshots and old proofs",async()=>{
 const f=await readyFixture(),proof=await f.auth.verifyAccess(await accessFixture(),"read:account"),next=snapshotFixture(f.configuration,2,strongerProviderJwks);
 f.state.head=headFixture(f.configuration,next,2);await assert.rejects(async()=>f.snapshots.current(),/mismatch/);await f.snapshots.install(next);
 await assert.rejects(async()=>f.auth.assertCurrent(proof),/Retired/);await assert.rejects(async()=>f.auth.verifyAccess(await accessFixture(),"read:account"));
 // Fixture key identity is taken from the generated stronger JWKS, not inferred from a provider.
 const valid=await accessFixture({}, {kid:strongerProviderJwks.keys[0].kid},strongerProviderKeys.privateKey);assert.equal((await f.auth.verifyAccess(valid,"read:account")).keyRevision,2);
 await assert.rejects(async()=>new Auth0Snapshots(f.configuration,distributionKeys.publicKey,async()=>f.state.head).install(f.snapshot));
 await assert.rejects(async()=>f.snapshots.install(f.snapshot));
});
test("default Auth0 access profile verifies without sid/jti or fabricated recent authentication",async()=>{
 const f=await readyFixture(),raw=await accessFixture({auth_time:Math.floor(Date.now()/1000),acr:"untrusted-for-this-flow",iat:Math.floor(Date.now()/1000)}),proof=await f.auth.verifyAccess(raw,"read:account");
 assert.equal(proof.kind,"authentication-only");assert(!('session' in proof));assert(!('authenticationTime' in proof));assert(!('tokenId' in proof));await assert.rejects(async()=>f.auth.assertCurrent({...proof}));
 await assert.rejects(async()=>ProviderTokenVerifier.create(providerContract,{revision:1,jwks:providerJwks}).then(v=>v.verify(raw,"consent")));
});
for(const [name,claims,header] of [
 ['issuer',{iss:'https://other.example/'},{}],['API audience',{aud:'fixture-browser'},{}],['extra audience',{aud:[profileFixture().audience,'other']},{}],['duplicate audience',{aud:[profileFixture().audience,profileFixture().audience]},{}],['client',{azp:'other'},{}],['scope',{scope:'other'},{}],['future iat',{iat:Math.floor(Date.now()/1000)+60},{}],['M2M',{gty:'client-credentials'},{}],['delegation',{act:{sub:'other'}},{}],['organization',{org_id:'other'},{}],['expired',{exp:1},{}],['RFC9068',{}, {typ:'at+jwt'}],['jku',{}, {jku:'https://evil.example/jwks'}],['embedded key',{}, {jwk:providerJwks.keys[0]}],['x5u',{}, {x5u:'https://evil.example/cert'}],
] as const)test(`Auth0 verification rejects ${name}`,async()=>{const f=await readyFixture();await assert.rejects(async()=>f.auth.verifyAccess(await accessFixture(claims,header),"read:account"));});
test("wrong signature, modified payload and duplicate claims rejected",async()=>{
 const f=await readyFixture(),other=generateKeyPairSync('rsa',{modulusLength:2048});await assert.rejects(async()=>f.auth.verifyAccess(await accessFixture({}, {},other.privateKey),'read:account'));
 const token=await accessFixture(),parts=token.split('.');parts[1]=Buffer.from(JSON.stringify({iss:'tampered'})).toString('base64url');await assert.rejects(async()=>f.auth.verifyAccess(parts.join('.'),'read:account'));
 const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'fixture-v1'})).toString('base64url'),payload=Buffer.from('{"sub":"a","sub":"b"}').toString('base64url'),input=header+'.'+payload;
 await assert.rejects(async()=>f.auth.verifyAccess(input+'.'+sign('RSA-SHA256',Buffer.from(input),providerKeys.privateKey).toString('base64url'),'read:account'),/Duplicate/);
});
test("reauthentication binds server nonce, subject, exact intent challenge, and explicit freshness/assurance",async()=>{
 const f=await readyFixture(),now=Math.floor(Date.now()/1000),challenge={nonce:'server-random-nonce',subject:'subject:alice',accountSessionId:'canonical-session-a',envelopeDigest:'ab'.repeat(32),action:'confirm-economic-intent' as const,requestedAt:now-1,expiresAt:now+30,maxAuthenticationAgeSeconds:30,acceptedAcr:['urn:fixture:assurance']};
 const claims={aud:profileFixture().clientId,nonce:challenge.nonce,auth_time:now,iat:now,acr:'urn:fixture:assurance'};
 const proof=await f.auth.verifyReauthentication(await accessFixture(claims),challenge);assert.equal(proof.kind,'reauthentication-only');assert.equal(proof.challengeDigest,sha256(JSON.stringify(challenge)));
 for(const change of [{auth_time:undefined},{auth_time:now-100},{nonce:'wrong'},{sub:'other'},{acr:undefined},{iat:now+50}])await assert.rejects(async()=>f.auth.verifyReauthentication(await accessFixture({...claims,...change}),challenge));
 await assert.rejects(async()=>f.auth.verifyReauthentication(await accessFixture(claims),{...challenge,acceptedAcr:[]}));
});

function ledger():TransportReplayLedger {const seen=new Set<string>();return {consume:async id=>{if(seen.has(id))return false;seen.add(id);return true;}};}
const keys=Object.fromEntries(readinessRoles.map(r=>[r,serviceKeys[r].publicKey])) as any;
function transports(replay=ledger(),configuration=deploymentFixture().configuration){return {client:new ReadinessServiceTransport('app',configuration,serviceKeys.app.privateKey,keys,replay,[]),server:new ReadinessServiceTransport('identity',configuration,serviceKeys.identity.privateKey,keys,replay,[{caller:'app',method:'POST',path:'/session/check'}])};}
test("authenticated caller and server bind exact body, endpoint, role and response",async()=>{
 const {client,server}=transports(),request=client.request('identity','POST','/session/check','body'),accepted=await server.receive(request,'POST','/session/check','body'),response=server.respond(accepted,'result');
 await client.verifyResponse(request,response,'result');await assert.rejects(async()=>client.verifyResponse(request,response,'result'),/replay/);await assert.rejects(async()=>server.receive(request,'POST','/session/check','body'),/replay/);
});
test("transport refuses shared workload keys and a response signed by the wrong service",async()=>{
 const configuration=deploymentFixture().configuration;
 assert.throws(()=>new ReadinessServiceTransport('app',configuration,serviceKeys.app.privateKey,{...keys,identity:keys.app},ledger(),[]),/Distinct workload keys/);
 const {client,server}=transports(),request=client.request('identity','POST','/session/check','body');
 const accepted=await server.receive(request,'POST','/session/check','body'),response=server.respond(accepted,'result');
 const forged=signedFixture(JSON.parse(response.payload),serviceKeys.observer.privateKey);
 await assert.rejects(()=>client.verifyResponse(request,forged,'result'),/authentication rejected/);
 await assert.rejects(()=>client.verifyResponse(request,response,'changed result'),/binding/);
 await assert.rejects(()=>client.verifyResponse(request,response,'x'.repeat(65537)),/Bounded response/);
 await client.verifyResponse(request,response,'result');
});
for(const [name,mutate] of [['body', (x:any)=>({...x,bodyDigest:'0'.repeat(64)})],['environment',(x:any)=>({...x,environment:'other'})],['caller generation',(x:any)=>({...x,callerGeneration:'2'})],['server endpoint',(x:any)=>({...x,serverEndpoint:'https://evil.example/'})],['expiry',(x:any)=>({...x,expiresAt:1})]] as const)
 test(`transport rejects authenticated but mismatched ${name}`,async()=>{const {client,server}=transports();const request=client.request('identity','POST','/session/check','body');const changed=signedFixture(mutate(JSON.parse(request.payload)),serviceKeys.app.privateKey);await assert.rejects(async()=>server.receive(changed,'POST','/session/check','body'));});
test("transport rejects unauthorized caller, tampering, wrong server and ledger outage",async()=>{
 const {client,server}=transports(),request=client.request('identity','POST','/session/check','body');
 await assert.rejects(async()=>server.receive({...request,payload:request.payload+' '},'POST','/session/check','body'));
 await assert.rejects(async()=>server.receive(client.request('issuer','POST','/session/check','body'),'POST','/session/check','body'));
 const observer=new ReadinessServiceTransport('observer',client.configuration,serviceKeys.observer.privateKey,keys,ledger(),[]);await assert.rejects(async()=>server.receive(observer.request('identity','POST','/session/check','body'),'POST','/session/check','body'));
 const broken=transports({consume:async()=>{throw new Error('ledger unavailable');}});await assert.rejects(async()=>broken.server.receive(broken.client.request('identity','POST','/session/check','body'),'POST','/session/check','body'),/unavailable/);
});
for(let repetition=0;repetition<3;repetition++)test(`transport concurrent replay and reconstructed server reject duplicates ${repetition+1}`,async()=>{
 const shared=ledger(),{client,server}=transports(shared),request=client.request('identity','POST','/session/check','body');
 const outcomes=await Promise.allSettled([server.receive(request,'POST','/session/check','body'),server.receive(request,'POST','/session/check','body')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(async()=>transports(shared).server.receive(request,'POST','/session/check','body'),/replay/);
});
test("transport generation/configuration cutover rejects stale requests",async()=>{
 const old=transports(),request=old.client.request('identity','POST','/session/check','body'),p=profileFixture();
 const changed=deploymentFixture({...p,revision:2,services:{...p.services,app:{...p.services.app,generation:'2'}}}).configuration;
 await assert.rejects(async()=>transports(ledger(),changed).server.receive(request,'POST','/session/check','body'),/context/);
});

for(let repetition=0;repetition<3;repetition++)test(`Auth0 key rotation during verification fails closed ${repetition+1}`,async()=>{
 const f=await readyFixture(),raw=await accessFixture(),next=snapshotFixture(f.configuration,2,strongerProviderJwks);
 let arrived!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>arrived=r),resume=new Promise<void>(r=>release=r);let held=false;
 const verify=crypto.subtle.verify.bind(crypto.subtle);
 const hook=mock.method(crypto.subtle,'verify',async(...args:Parameters<typeof crypto.subtle.verify>)=>{if(!held&&args[3].byteLength>0){held=true;arrived();await resume;}return verify(...args);});
 try {const result=assert.rejects(async()=>f.auth.verifyAccess(raw,'read:account'),/Retired|changed|mismatch/);await waiting;
  f.state.head=headFixture(f.configuration,next,2);await f.snapshots.install(next);release();await result;
 } finally {release();hook.mock.restore();}
});
test("invalid higher revision cannot publish or displace valid keys",async()=>{
 const f=await readyFixture(),bad=snapshotFixture(f.configuration,3,{keys:[{kty:'RSA',kid:'broken',alg:'RS256'}]}),good=snapshotFixture(f.configuration,2,strongerProviderJwks);
 f.state.head=headFixture(f.configuration,good,2);
 const outcomes=await Promise.allSettled([f.snapshots.install(bad),f.snapshots.install(good)]);assert.equal(outcomes[0].status,'rejected');assert.equal(outcomes[1].status,'fulfilled');assert.equal((await f.snapshots.current()).provenance.revision,2);
});
test("interrupted provider verification cannot return an authentication proof",async()=>{
 const f=await readyFixture(),raw=await accessFixture(),hook=mock.method(crypto.subtle,'verify',async()=>{throw new Error('fixture verification interrupted');});
 try {await assert.rejects(async()=>f.auth.verifyAccess(raw,'read:account'),/signature verification failed/);}finally{hook.mock.restore();}
});

test("durable provenance contains only public audit metadata and cannot replace an authenticated snapshot",async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'provider-provenance-fixture-'));
 try {const f=await readyFixture(),path=await f.snapshots.persistProvenance(dir),record=JSON.parse(await readFile(path,'utf8'));
  assert.equal(record.provider,'auth0');assert.equal(record.fingerprint,sha256(f.snapshot.payload));assert(!('jwks' in record));assert(!('signature' in record));assert(!('privateKey' in record));
  assert.equal(await f.snapshots.persistProvenance(dir),path);await assert.rejects(()=>f.snapshots.install(record));
 }finally{await rm(dir,{recursive:true});}
});
