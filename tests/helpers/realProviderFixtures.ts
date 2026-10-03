import { generateKeyPairSync, sign } from "node:crypto";
import { SignJWT, type JSONWebKeySet } from "jose";
import { sha256 } from "../../src/economic/foundation/database";
import { loadDeploymentProfile, readinessRoles, type DeploymentProfile } from "../../src/economic/readiness/deploymentProfile";
import { Auth0Snapshots } from "../../src/economic/readiness/auth0Snapshots";
import { Auth0AuthenticationVerifier } from "../../src/economic/readiness/auth0Authentication";
import type { SignedArtifact } from "../../src/economic/readiness/signedArtifact";
import { providerJwks, providerKeys } from "./providerTokens";

export const configurationKeys=generateKeyPairSync("ed25519"), distributionKeys=generateKeyPairSync("ed25519"), endpointKeys=generateKeyPairSync("ed25519");
export const serviceKeys=Object.fromEntries(readinessRoles.map(role=>[role,generateKeyPairSync("ed25519")])) as Record<typeof readinessRoles[number],ReturnType<typeof generateKeyPairSync>>;
export function signedFixture(data: unknown, key=configurationKeys.privateKey): SignedArtifact {
  const payload=JSON.stringify(data);return {payload,signature:sign(null,Buffer.from(payload),key).toString("base64url")};
}
export function profileFixture(changes: Partial<DeploymentProfile>={}): DeploymentProfile {
  return {type:"zephipay-deployment-readiness-v1",mode:"non-value-readiness",provider:"auth0",dialect:"auth0",deploymentId:"15bf00ae-094e-4ca9-881d-1f08b4c7d4aa",environment:"offline-fixture",revision:1,
    issuer:"https://economic-auth.example/",audience:"https://economic-api.example/",clientId:"fixture-browser",keySource:"https://economic-auth.example/.well-known/jwks.json",snapshotAdapter:"fixture-authenticated-source-v1",
    maxSnapshotAgeSeconds:600,maxTokenLifetimeSeconds:600,databaseName:"fixture_database",databaseHost:"database.fixture.example",databasePeerSha256:"ab".repeat(32),endpointAttestor:"fixture-endpoint-observer",
    services:Object.fromEntries(readinessRoles.map(role=>[role,{login:`provider_fixture_${role}`,generation:"1",endpoint:`https://${role}.fixture.example/`}])) as DeploymentProfile['services'],...changes};
}
export function deploymentFixture(profile=profileFixture()) {
  const artifact=signedFixture(profile),expected={fingerprint:sha256(artifact.payload),revision:profile.revision,deploymentId:profile.deploymentId,environment:profile.environment};
  return {artifact,expected,configuration:loadDeploymentProfile(artifact,configurationKeys.publicKey,expected)};
}
export function snapshotFixture(configuration: ReturnType<typeof deploymentFixture>['configuration'], revision=1, jwks:JSONWebKeySet=providerJwks, changes:Record<string,unknown>={}) {
  const p=configuration.profile,now=Math.floor(Date.now()/1000);
  return signedFixture({type:"zephipay-auth0-snapshot-v1",provider:"auth0",deploymentId:p.deploymentId,environment:p.environment,issuer:p.issuer,configuration:configuration.fingerprint,source:p.keySource,adapter:p.snapshotAdapter,
    obtainedAt:now-1,validUntil:now+300,revision,previousRevision:revision-1,jwks,...changes},distributionKeys.privateKey);
}
export function headFixture(configuration: ReturnType<typeof deploymentFixture>['configuration'], snapshot:SignedArtifact, revision=1) {
  return signedFixture({type:"zephipay-auth0-head-v1",configuration:configuration.fingerprint,revision,fingerprint:sha256(snapshot.payload),expiresAt:Math.floor(Date.now()/1000)+600},distributionKeys.privateKey);
}
export async function readyFixture(profile=profileFixture()) {
  const {configuration}=deploymentFixture(profile),snapshot=snapshotFixture(configuration);
  const state={head:headFixture(configuration,snapshot),unavailable:false};
  const snapshots=new Auth0Snapshots(configuration,distributionKeys.publicKey,async()=>{if(state.unavailable)throw new Error("Registration unavailable");return state.head;});
  await snapshots.install(snapshot);
  return {configuration,snapshot,state,snapshots,auth:new Auth0AuthenticationVerifier(snapshots)};
}
export function endpointFixture(configuration:ReturnType<typeof deploymentFixture>['configuration'], nonce="fixture-nonce",changes:Record<string,unknown>={}) {
  const p=configuration.profile,now=Math.floor(Date.now()/1000);
  return signedFixture({type:"zephipay-database-endpoint-v1",attestor:p.endpointAttestor,nonce,deploymentId:p.deploymentId,environment:p.environment,configuration:configuration.fingerprint,
    host:p.databaseHost,peerSha256:p.databasePeerSha256,verifiedAt:now,expiresAt:now+60,...changes},endpointKeys.privateKey);
}
export function accessFixture(changes:Record<string,unknown>={},header:Record<string,unknown>={},key=providerKeys.privateKey) {
  const p=profileFixture(),now=Math.floor(Date.now()/1000);
  return new SignJWT({iss:p.issuer,aud:[p.audience,`${p.issuer}userinfo`],sub:"subject:alice",azp:p.clientId,scope:"openid read:account",iat:now-1,exp:now+240,...changes})
    .setProtectedHeader({alg:"RS256",typ:"JWT",kid:"fixture-v1",...header}).sign(key);
}
