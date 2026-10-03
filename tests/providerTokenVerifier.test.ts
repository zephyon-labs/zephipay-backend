import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ProviderTokenVerifier } from "../src/economic/provider/providerTokenVerifier";
import { providerContract, providerJwks, providerToken } from "./helpers/providerTokens";

const make = () => new ProviderTokenVerifier(providerContract, { revision: 1, jwks: providerJwks });
test("provider verifies exact signed context and keeps iat distinct from auth_time", async () => {
  const v = make(), proof = await v.verify(await providerToken(), "consent");
  assert(proof.issuedAt > proof.authenticationTime!);
  assert.equal(proof.subject, "subject:alice");
  assert(Object.isFrozen(proof));
  assert.throws(() => v.assertCurrent({ ...proof }, Date.now()), /REJECTED/);
});
for (const [label, claims, header] of [
  ["wrong issuer", { iss: "https://other.example/" }],
  ["wrong audience", { aud: "wrong-api" }],
  ["multiple audiences", { aud: [providerContract.audience, "wrong-api"] }],
  ["wrong client", { azp: "other-client" }],
  ["wrong environment", { zep_environment: "production" }],
  ["wrong context", { zep_context: "other-purpose" }],
  ["missing scope", { scope: "login" }],
  ["missing session", { sid: undefined }],
  ["missing jti", { jti: undefined }],
  ["missing iat", { iat: undefined }],
  ["expired", { exp: 1 }],
  ["future issuance", { iat: Math.floor(Date.now() / 1000) + 100 }],
  ["future nbf", { nbf: Math.floor(Date.now() / 1000) + 100 }],
  ["stale issuance", { iat: Math.floor(Date.now() / 1000) - 301, exp: Math.floor(Date.now() / 1000) + 10 }],
  ["excessive lifetime", { exp: Math.floor(Date.now() / 1000) + 1000 }],
  ["fractional time", { iat: Date.now() / 1000 + 0.1 }],
  ["missing auth_time", { auth_time: undefined }],
  ["refresh without reauthentication", { auth_time: Math.floor(Date.now() / 1000) - 5000 }],
  ["authentication after issuance", { auth_time: Math.floor(Date.now() / 1000) + 5 }],
  ["wrong assurance", { acr: "urn:fixture:weak" }],
  ["ID-token type", {}, { typ: "JWT" }],
  ["untrusted kid", {}, { kid: "unknown" }],
  ["token-directed key URL", {}, { jku: "https://attacker.example/jwks" }],
] as const) test(`provider rejects ${label}`, async () => {
  await assert.rejects(() => providerToken(claims, header).then(raw => make().verify(raw, "consent")), /REJECTED/);
});
test("signature mismatch and shaped/cookie input cannot authenticate", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(() => providerToken({}, {}, other.privateKey).then(raw => make().verify(raw, "consent")), /REJECTED/);
  for (const raw of ["session=cookie", JSON.stringify({ approved: true }), { subject: "subject:alice" }, "x".repeat(16385)])
    await assert.rejects(() => make().verify(raw as string, "consent"), /REJECTED/);
});
test("missing auth_time can identify a login but cannot satisfy sensitive action freshness", async () => {
  const raw = await providerToken({ auth_time: undefined });
  assert.equal((await make().verify(raw, "create-session")).authenticationTime, undefined);
  await assert.rejects(() => make().verify(raw, "consent"));
});
test("key rotation rejects removed keys, stale proofs and revision rollback", async () => {
  const v = make(), oldToken = await providerToken(), proof = await v.verify(oldToken, "consent");
  const next = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...next.publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "fixture-v2" }] };
  v.replaceKeys({ revision: 2, jwks });
  assert.throws(() => v.assertCurrent(proof, Date.now()));
  await assert.rejects(() => v.verify(oldToken, "consent"));
  assert.equal((await v.verify(await providerToken({}, { kid: "fixture-v2" }, next.privateKey), "consent")).keyRevision, 2);
  assert.throws(() => v.replaceKeys({ revision: 1, jwks }));
  assert.throws(() => v.replaceKeys({ revision: 3, jwks: { keys: [{ ...jwks.keys[0], d: "private-material-forbidden" }] } }));
});
test("freshness is rechecked after waits and contract cannot be weakened through mutation", async () => {
  const v = make(), proof = await v.verify(await providerToken(), "consent");
  assert.throws(() => v.assertCurrent(proof, Date.now() + 121000), /RECENT_AUTH/);
  try { (v.contract.actions.consent.freshness as any).maxAuthenticationAgeSeconds = 999999; } catch {}
  assert.equal(v.contract.actions.consent.freshness.maxAuthenticationAgeSeconds, 120);
});
