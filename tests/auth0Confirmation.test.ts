import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../src/economic/foundation/database";
import { assertConfirmationPolicy, confirmationProductionGate, loadConfirmationPolicy } from "../src/economic/confirmation/confirmationPolicy";
import { type ReauthenticationChallenge } from "../src/economic/readiness/auth0Authentication";
import { confirmationPolicyFixture } from "./helpers/confirmationFixtures";
import { accessFixture, configurationKeys, deploymentFixture, readyFixture, signedFixture } from "./helpers/realProviderFixtures";

test("signed nonsecret policy binds deployment, issuer, client, environment and pinned fingerprint", () => {
  const {configuration} = deploymentFixture(), value = confirmationPolicyFixture(configuration);
  assertConfirmationPolicy(value);
  assert.throws(() => assertConfirmationPolicy({...value}), /Verified/);
  assert.throws(() => loadConfirmationPolicy(value.artifact, configurationKeys.publicKey, configuration, "00".repeat(32)), /mismatch/);
  for (const changes of [{environment:"wrong"},{issuer:"https://wrong.example/"},{clientId:"wrong"},{configuration:"00".repeat(32)},
    {dialect:"rfc9068"},{algorithm:"HS256"},{flow:"implicit"},{refreshPolicy:"enabled"},{mode:"production"},{extra:true}]) {
    const artifact = signedFixture({...value.policy,...changes});
    assert.throws(() => loadConfirmationPolicy(artifact, configurationKeys.publicKey, configuration, sha256(artifact.payload)));
  }
});
for (const attestation of ["TEST","UNATTESTED","ATTESTED"] as const) test(`production remains gated with ${attestation} operator facts`, () => {
  const p = confirmationPolicyFixture(deploymentFixture().configuration, {attestation, reauthentication:attestation});
  const gate = confirmationProductionGate(p);
  assert.equal(gate.productionReady, false); assert.equal(gate.factsAttested, attestation === "ATTESTED");
});
test("reauthentication proofs cannot be copied, swapped, or reused under a changed challenge/policy", async () => {
  const f = await readyFixture(), now = Math.floor(Date.now()/1000);
  const challenge: ReauthenticationChallenge = {nonce:"server-nonce",subject:"subject:alice",accountSessionId:"canonical-session",envelopeDigest:"ab".repeat(32),
    action:"confirm-economic-intent",requestedAt:now-1,expiresAt:now+60,maxAuthenticationAgeSeconds:30,acceptedAcr:["fixture:mfa"]};
  const raw = await accessFixture({aud:f.configuration.profile.clientId,nonce:challenge.nonce,auth_time:now-1,acr:"fixture:mfa"});
  const proof = await f.auth.verifyReauthentication(raw, challenge);
  assert.equal((await f.auth.assertReauthentication(proof,challenge,now)).tokenDigest,sha256(raw));
  await assert.rejects(() => f.auth.assertReauthentication({...proof},challenge,now), /Unverified/);
  await assert.rejects(() => f.auth.assertReauthentication(proof,{...challenge,nonce:"changed"},now), /substituted/);
  await assert.rejects(() => f.auth.assertReauthentication(proof,{...challenge,acceptedAcr:["other"]},now), /substituted/);
  await assert.rejects(() => f.auth.assertReauthentication(proof,challenge,now+60), /expired/);
  const reconstructed = await readyFixture();
  await assert.rejects(() => reconstructed.auth.assertReauthentication(proof,challenge,now), /Unverified/);
});
for (const [label, changes] of [["missing auth_time",{auth_time:undefined}],["stale auth_time with current iat",{auth_time:1}],
  ["missing assurance",{acr:undefined}],["insufficient assurance",{acr:"password"}],["wrong nonce",{nonce:"other"}],
  ["wrong subject",{sub:"subject:bob"}],["wrong client",{aud:"other"}],["wrong issuer",{iss:"https://other.example/"}]] as const)
  test(`fresh callback rejects ${label}`, async () => {
    const f = await readyFixture(), now = Math.floor(Date.now()/1000), challenge: ReauthenticationChallenge = {
      nonce:"server-nonce",subject:"subject:alice",accountSessionId:"session",envelopeDigest:"ab".repeat(32),action:"confirm-economic-intent",
      requestedAt:now-1,expiresAt:now+60,maxAuthenticationAgeSeconds:30,acceptedAcr:["fixture:mfa"]};
    const raw = await accessFixture({aud:f.configuration.profile.clientId,nonce:challenge.nonce,auth_time:now-1,acr:"fixture:mfa",...changes});
    await assert.rejects(() => f.auth.verifyReauthentication(raw,challenge));
  });
