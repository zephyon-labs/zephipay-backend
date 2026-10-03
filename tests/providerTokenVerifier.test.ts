import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { MIN_PROVIDER_RSA_BITS, ProviderTokenVerifier } from "../src/economic/provider/providerTokenVerifier";
import { providerContract, providerJwks, providerToken, providerKeys } from "./helpers/providerTokens";

const make = () => ProviderTokenVerifier.create(providerContract, { revision: 1, jwks: providerJwks });
test("provider verifies exact signed context and keeps iat distinct from auth_time", async () => {
  const v = await make(), proof = await v.verify(await providerToken(), "consent");
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
  await assert.rejects(() => providerToken(claims, header).then(async raw => (await make()).verify(raw, "consent")), /REJECTED/);
});
test("signature mismatch and shaped/cookie input cannot authenticate", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(() => providerToken({}, {}, other.privateKey).then(async raw => (await make()).verify(raw, "consent")), /REJECTED/);
  for (const raw of ["session=cookie", JSON.stringify({ approved: true }), { subject: "subject:alice" }, "x".repeat(16385)])
    await assert.rejects(async () => (await make()).verify(raw as string, "consent"), /REJECTED/);
});
test("missing auth_time can identify a login but cannot satisfy sensitive action freshness", async () => {
  const raw = await providerToken({ auth_time: undefined });
  assert.equal((await (await make()).verify(raw, "create-session")).authenticationTime, undefined);
  await assert.rejects(async () => (await make()).verify(raw, "consent"));
});
test("key rotation rejects removed keys, stale proofs and revision rollback", async () => {
  const v = await make(), oldToken = await providerToken(), proof = await v.verify(oldToken, "consent");
  const next = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...next.publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "fixture-v2" }] };
  await v.replaceKeys({ revision: 2, jwks });
  assert.throws(() => v.assertCurrent(proof, Date.now()));
  await assert.rejects(() => v.verify(oldToken, "consent"));
  assert.equal((await v.verify(await providerToken({}, { kid: "fixture-v2" }, next.privateKey), "consent")).keyRevision, 2);
  await assert.rejects(() => v.replaceKeys({ revision: 1, jwks }));
  await assert.rejects(() => v.replaceKeys({ revision: 3, jwks: { keys: [{ ...jwks.keys[0], d: "private-material-forbidden" }] } }));
});
test("freshness is rechecked after waits and contract cannot be weakened through mutation", async () => {
  const v = await make(), proof = await v.verify(await providerToken(), "consent");
  assert.throws(() => v.assertCurrent(proof, Date.now() + 121000), /RECENT_AUTH/);
  try { (v.contract.actions.consent.freshness as any).maxAuthenticationAgeSeconds = 999999; } catch {}
  assert.equal(v.contract.actions.consent.freshness.maxAuthenticationAgeSeconds, 120);
});


import { invalidProviderKeySets, strongerProviderJwks, strongerProviderKeys } from "./helpers/providerKeyFixtures";

for (const { name, jwks } of invalidProviderKeySets) test(`key initialization rejects ${name} without any provider JWT`, async () => {
  const v = new ProviderTokenVerifier(providerContract);
  assert.throws(() => v.assertInitialized(), /NOT_INITIALIZED/);
  await assert.rejects(() => v.replaceKeys({ revision: 1, jwks }), /INITIALIZATION_REJECTED/);
  assert.throws(() => v.keyRevision, /NOT_INITIALIZED/);
  await assert.rejects(() => ProviderTokenVerifier.create(providerContract, { revision: 1, jwks }), /INITIALIZATION_REJECTED/);
});

test("valid optional metadata and verify-only key_ops initialize with explicit 2048-bit minimum", async () => {
  assert.equal(MIN_PROVIDER_RSA_BITS, 2048);
  const { alg, use, ...key } = providerJwks.keys[0];
  const v = await ProviderTokenVerifier.create(providerContract, { revision: 1, jwks: { keys: [{ ...key, key_ops: ["verify"] }] } });
  assert.equal(v.assertInitialized(), 1);
  assert.equal((await v.verify(await providerToken(), "consent")).keyRevision, 1);
});

test("every configured key imports; cryptographic import failure cannot activate a replacement", async t => {
  const v = await make(), imported: string[] = [];
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "importKey", async (...args: any[]) => {
    if (args[0] === "jwk") {
      imported.push(args[1].kid);
      if (args[1].kid === "fixture-stronger") throw new Error("synthetic import failure");
    }
    return (original as any)(...args);
  });
  const jwks = { keys: [...providerJwks.keys, ...strongerProviderJwks.keys] };
  await assert.rejects(() => v.replaceKeys({ revision: 2, jwks }), /INITIALIZATION_REJECTED/);
  assert.deepEqual(imported, ["fixture-v1", "fixture-stronger"]);
  assert.equal(v.keyRevision, 1);
  assert.equal((await v.verify(await providerToken(), "consent")).keyRevision, 1);
});

test("WebCrypto verification initialization failure is discovered without a JWT", async t => {
  t.mock.method(crypto.subtle, "verify", async () => { throw new Error("synthetic algorithm failure"); });
  await assert.rejects(() => make(), /INITIALIZATION_REJECTED/);
});

test("initialization stays unready while import awaits and copies caller-owned configuration", async t => {
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => release = resolve);
  t.mock.method(crypto.subtle, "importKey", async (...args: any[]) => { await waiting; return (original as any)(...args); });
  const v = new ProviderTokenVerifier(providerContract), config = { revision: 1, jwks: structuredClone(providerJwks) };
  const initializing = v.replaceKeys(config);
  config.revision = 9; config.jwks.keys[0].n = "bad";
  assert.throws(() => v.assertInitialized(), /NOT_INITIALIZED/);
  release(); await initializing;
  assert.equal(v.keyRevision, 1);
  assert.equal((await v.verify(await providerToken(), "consent")).keyRevision, 1);
});

test("stronger replacement publishes revision and initialized resolver atomically", async t => {
  const v = await make(), oldToken = await providerToken(), newToken = await providerToken({}, { kid: "fixture-stronger" }, strongerProviderKeys.privateKey);
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => release = resolve);
  t.mock.method(crypto.subtle, "importKey", async (...args: any[]) => { if (args[0] === "jwk" && args[1].kid === "fixture-stronger") await waiting; return (original as any)(...args); });
  const replacing = v.replaceKeys({ revision: 2, jwks: strongerProviderJwks });
  assert.equal(v.keyRevision, 1);
  assert.equal((await v.verify(oldToken, "consent")).keyRevision, 1);
  await assert.rejects(() => v.verify(newToken, "consent"));
  release(); await replacing;
  assert.equal(v.keyRevision, 2);
  assert.equal((await v.verify(newToken, "consent")).keyRevision, 2);
  await assert.rejects(() => v.verify(oldToken, "consent"));
});

test("older pending replacement cannot overwrite a newer successfully initialized revision", async t => {
  const v = await make(), original = crypto.subtle.importKey.bind(crypto.subtle);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => release = resolve);
  t.mock.method(crypto.subtle, "importKey", async (...args: any[]) => { if (args[0] === "jwk" && args[1].kid === "fixture-stronger") await waiting; return (original as any)(...args); });
  const older = v.replaceKeys({ revision: 2, jwks: strongerProviderJwks });
  await v.replaceKeys({ revision: 3, jwks: providerJwks });
  release(); await assert.rejects(() => older, /INITIALIZATION_REJECTED/);
  assert.equal(v.keyRevision, 3);
  assert.equal((await v.verify(await providerToken(), "consent")).keyRevision, 3);
});

for (let iteration = 0; iteration < 3; iteration++) test(`invalid higher revision cannot win replacement race ${iteration + 1}`, async () => {
  const v = await make();
  const results = await Promise.allSettled([
    v.replaceKeys({ revision: 2, jwks: strongerProviderJwks }),
    v.replaceKeys({ revision: 3, jwks: invalidProviderKeySets[0].jwks }),
  ]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.equal(v.keyRevision, 2);
  assert.equal((await v.verify(await providerToken({}, { kid: "fixture-stronger" }, strongerProviderKeys.privateKey), "consent")).keyRevision, 2);
});

function signedWire(header: string, payload: string): string {
  const wire = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  return `${wire}.${sign("RSA-SHA256", Buffer.from(wire), providerKeys.privateKey).toString("base64url")}`;
}
for (const attack of ["tampered payload", "tampered signature", "unsigned token", "HS256 confusion", "duplicate header", "duplicate claims", "embedded jwk", "x5u header", "x5c header"] as const)
  test(`initialized keys preserve rejection of ${attack}`, async () => {
    const v = await make(), raw = await providerToken(), [h, p, s] = raw.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString()), payload = JSON.parse(Buffer.from(p, "base64url").toString());
    let bad: string;
    if (attack === "tampered payload") bad = `${h}.${Buffer.from(JSON.stringify({ ...payload, sub: "subject:bob" })).toString("base64url")}.${s}`;
    else if (attack === "tampered signature") bad = `${h}.${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`;
    else if (attack === "unsigned token") bad = `${Buffer.from(JSON.stringify({ ...header, alg: "none" })).toString("base64url")}.${p}.`;
    else if (attack === "HS256 confusion") bad = await new SignJWT(payload).setProtectedHeader({ ...header, alg: "HS256" }).sign(Buffer.from(providerKeys.publicKey.export({ format: "pem", type: "spki" })));
    else if (attack === "duplicate header") bad = signedWire(`{"alg":"RS256",${JSON.stringify(header).slice(1)}`, JSON.stringify(payload));
    else if (attack === "duplicate claims") bad = signedWire(JSON.stringify(header), `{"iss":${JSON.stringify(payload.iss)},${JSON.stringify(payload).slice(1)}`);
    else bad = signedWire(JSON.stringify({ ...header, ...(attack === "embedded jwk" ? { jwk: providerJwks.keys[0] } : attack === "x5u header" ? { x5u: "https://unused.example/cert" } : { x5c: ["unused"] }) }), JSON.stringify(payload));
    await assert.rejects(() => v.verify(bad, "consent"), /REJECTED/);
  });
