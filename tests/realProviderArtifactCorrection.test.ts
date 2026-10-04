import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { test } from "node:test";
import type { JSONWebKeySet } from "jose";
import { MAX_ECONOMIC_JSON_BYTES, parseEconomicJson } from "../src/economic/foundation/strictJson";
import { sha256 } from "../src/economic/foundation/database";
import { Auth0Snapshots } from "../src/economic/readiness/auth0Snapshots";
import { Auth0AuthenticationVerifier } from "../src/economic/readiness/auth0Authentication";
import { ReadinessServiceTransport } from "../src/economic/readiness/serviceTransport";
import { readinessRoles } from "../src/economic/readiness/deploymentProfile";
import { ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BASE64URL_LENGTH, MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES, verifyArtifact } from "../src/economic/readiness/signedArtifact";
import { deploymentFixture, snapshotFixture, headFixture, distributionKeys, configurationKeys, signedFixture, readyFixture, accessFixture, serviceKeys } from "./helpers/realProviderFixtures";
import { providerJwks, providerContract } from "./helpers/providerTokens";
import { ProviderTokenVerifier } from "../src/economic/provider/providerTokenVerifier";
import { strongerProviderKeys } from "./helpers/providerKeyFixtures";
import { AUTH0_DOCUMENTED_X5T, AUTH0_DOCUMENTED_X5T_HEX, documentedAuth0ThumbprintJwks } from "./helpers/auth0ThumbprintFixture";

function candidate(jwks: JSONWebKeySet) {
  const { configuration } = deploymentFixture();
  const artifact = snapshotFixture(configuration, 1, jwks);
  const head = headFixture(configuration, artifact);
  const snapshots = new Auth0Snapshots(configuration, distributionKeys.publicKey, async () => head);
  return { configuration, artifact, snapshots };
}

test("AUD-RPDR-01: exact documented Auth0 metadata installs; RSA alone still determines verification", async () => {
  assert.equal(AUTH0_DOCUMENTED_X5T.length, 54);
  assert.equal(Buffer.from(AUTH0_DOCUMENTED_X5T, "base64url").toString("latin1"), AUTH0_DOCUMENTED_X5T_HEX);
  const f = candidate(documentedAuth0ThumbprintJwks());
  verifyArtifact(f.artifact, distributionKeys.publicKey); // Authenticated source, not an unsigned key object.
  const installed = await f.snapshots.install(f.artifact);
  assert.equal(installed.fingerprint, sha256(f.artifact.payload));
  assert.equal(installed.normalizedKeysFingerprint, sha256(JSON.stringify(providerJwks)));
  const bare = candidate(providerJwks);
  assert.equal((await bare.snapshots.install(bare.artifact)).normalizedKeysFingerprint, installed.normalizedKeysFingerprint);
  const auth = new Auth0AuthenticationVerifier(f.snapshots);
  assert.equal((await auth.verifyAccess(await accessFixture(), "read:account")).kind, "authentication-only");
  await assert.rejects(async () => auth.verifyAccess(await accessFixture({}, {}, strongerProviderKeys.privateKey), "read:account"), /signature verification failed/);
  await assert.rejects(() => ProviderTokenVerifier.create(providerContract, { revision: 1, jwks: documentedAuth0ThumbprintJwks() }));
});
test("standard binary thumbprints and documented x5t project to identical public RSA keys", async () => {
  for (const metadata of [
    { x5t: Buffer.from(AUTH0_DOCUMENTED_X5T_HEX, "hex").toString("base64url") },
    { "x5t#S256": Buffer.alloc(32, 7).toString("base64url") },
    { x5t: AUTH0_DOCUMENTED_X5T, "x5t#S256": Buffer.alloc(32, 7).toString("base64url") },
  ]) {
    const jwks = structuredClone(providerJwks); Object.assign(jwks.keys[0], metadata);
    const f = candidate(jwks), installed = await f.snapshots.install(f.artifact);
    assert.equal(installed.normalizedKeysFingerprint, sha256(JSON.stringify(providerJwks)));
  }
});

const encodedHex = (hex: string) => Buffer.from(hex, "latin1").toString("base64url");
const malformedThumbprints: [string, string, unknown][] = [
  ["empty", "x5t", ""], ["non-string", "x5t", null],
  ["invalid alphabet", "x5t", "!".repeat(27)],
  ["padding", "x5t", AUTH0_DOCUMENTED_X5T + "=="],
  ["wrong binary length", "x5t", Buffer.alloc(19).toString("base64url")],
  ["wrong SHA256 length", "x5t#S256", Buffer.alloc(20).toString("base64url")],
  ["noncanonical trailing bits", "x5t", "A".repeat(26) + "B"],
  ["odd encoded hex length", "x5t", encodedHex(AUTH0_DOCUMENTED_X5T_HEX.slice(1))],
  ["long encoded hex", "x5t", encodedHex(AUTH0_DOCUMENTED_X5T_HEX + "AA")],
  ["invalid hex", "x5t", encodedHex("G" + AUTH0_DOCUMENTED_X5T_HEX.slice(1))],
  ["lowercase hex unsupported", "x5t", encodedHex(AUTH0_DOCUMENTED_X5T_HEX.toLowerCase())],
  ["mixed hex case", "x5t", encodedHex("a" + AUTH0_DOCUMENTED_X5T_HEX.slice(1))],
  ["non-ASCII hex lookalike", "x5t", Buffer.alloc(40, 0xC1).toString("base64url")],
  ["raw hex unsupported", "x5t", AUTH0_DOCUMENTED_X5T_HEX],
  ["mixed encodings", "x5t", AUTH0_DOCUMENTED_X5T + ":" + AUTH0_DOCUMENTED_X5T_HEX],
  ["hex profile not extended to SHA256", "x5t#S256", encodedHex("A".repeat(64))],
  ["overlong metadata", "x5t", "A".repeat(4096)],
  ["unsupported thumbprint field", "x5t#S384", "A".repeat(64)],
];
for (const [name, field, value] of malformedThumbprints) test(`thumbprint rejected before publication: ${name}`, async () => {
  const jwks = structuredClone(providerJwks); Object.assign(jwks.keys[0], { [field]: value });
  const f = candidate(jwks);
  await assert.rejects(() => f.snapshots.install(f.artifact), /thumbprint|metadata/);
  await assert.rejects(() => f.snapshots.current(), /not initialized/);
});

test("duplicate/escaped thumbprint members and duplicate key identities fail before publication", async () => {
  const f = candidate(documentedAuth0ThumbprintJwks());
  for (const duplicate of ['"x5t":"different"', '"x5\\u0074":"different"']) {
    const payload = f.artifact.payload.replace('"x5t":', `${duplicate},"x5t":`);
    const artifact = { payload, signature: sign(null, Buffer.from(payload), distributionKeys.privateKey).toString("base64url") };
    await assert.rejects(() => f.snapshots.install(artifact), /Duplicate/);
  }
  const jwks = documentedAuth0ThumbprintJwks(); jwks.keys.push({ ...jwks.keys[0], x5t: Buffer.alloc(20).toString("base64url") });
  const duplicateKeys = candidate(jwks); await assert.rejects(() => duplicateKeys.snapshots.install(duplicateKeys.artifact), /duplicate/);
  await assert.rejects(() => f.snapshots.current(), /not initialized/);
});

test("metadata compatibility cannot repair invalid RSA material or displace the active snapshot", async () => {
  for (const mutation of [{ n: "" }, { d: "private" }, { alg: "HS256" }, { key_ops: ["sign"] }]) {
    const jwks = documentedAuth0ThumbprintJwks(); Object.assign(jwks.keys[0], mutation);
    const c = candidate(jwks); await assert.rejects(() => c.snapshots.install(c.artifact));
    await assert.rejects(() => c.snapshots.current(), /not initialized/);
  }
  const f = await readyFixture(), malformed = documentedAuth0ThumbprintJwks(); malformed.keys[0].x5t = "";
  await assert.rejects(() => f.snapshots.install(snapshotFixture(f.configuration, 2, malformed)), /thumbprint/);
  assert.equal((await f.snapshots.current()).provenance.revision, 1);
  await f.auth.verifyAccess(await accessFixture(), "read:account");
});

test("bounded keys, certificate metadata and source/revision identifiers reject before key import", async t => {
  const f = candidate(providerJwks);
  let imports = 0;
  const hook = t.mock.method(crypto.subtle, "importKey", async () => { imports++; throw new Error("unexpected import"); });
  try {
    for (const jwks of [
      { keys: Array.from({ length: 17 }, (_, i) => ({ ...providerJwks.keys[0], kid: `key-${i}` })) },
      { keys: [{ ...providerJwks.keys[0], kid: "k".repeat(513) }] },
      { keys: [{ ...providerJwks.keys[0], x5c: ["A".repeat(8193)] }] },
      { keys: [{ ...providerJwks.keys[0], x5c: Array(5).fill("QQ==") }] },
    ]) {
      const c = candidate(jwks); await assert.rejects(() => c.snapshots.install(c.artifact));
    }
    for (const fields of [{ revision: Number.MAX_SAFE_INTEGER + 1 }, { source: "x".repeat(513) }, { adapter: "x".repeat(513) }]) {
      await assert.rejects(() => f.snapshots.install(snapshotFixture(f.configuration, 1, providerJwks, fields)));
    }
    assert.equal(imports, 0);
  } finally { hook.mock.restore(); }
});

test("AUD-RPDR-02: canonical Ed25519 signature verifies; exact raw/encoded lengths remain enforced", () => {
  const artifact = signedFixture({ fixture: true });
  assert.equal(ED25519_SIGNATURE_BYTES, 64);
  assert.equal(ED25519_SIGNATURE_BASE64URL_LENGTH, 86);
  assert.equal(artifact.signature.length, ED25519_SIGNATURE_BASE64URL_LENGTH);
  assert.equal(Buffer.from(artifact.signature, "base64url").length, ED25519_SIGNATURE_BYTES);
  assert.deepEqual(verifyArtifact(artifact, configurationKeys.publicKey).data, { fixture: true });
  assert.throws(() => verifyArtifact(artifact, distributionKeys.publicKey), /authentication rejected/);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(artifact.signature.at(-1)!);
  const noncanonical = artifact.signature.slice(0, -1) + alphabet[last + 1];
  assert.deepEqual(Buffer.from(noncanonical, "base64url"), Buffer.from(artifact.signature, "base64url"));
  assert.throws(() => verifyArtifact({ ...artifact, signature: noncanonical }, configurationKeys.publicKey), /authentication rejected/);
});

for (const [name, signature] of [
  ["one character", "A"], ["empty", ""], ["85 characters", "A".repeat(85)], ["87 characters", "A".repeat(87)],
  ["padding", "A".repeat(85) + "="], ["whitespace", "A".repeat(85) + " "],
  ["standard base64 alphabet", "A".repeat(85) + "/"], ["unicode", "A".repeat(85) + "é"],
  ["4096-character audit reproduction", "A".repeat(4096)], ["bounded 65536-character fixture", "A".repeat(65536)],
]) test(`signature rejects before any Buffer allocation: ${name}`, t => {
  const artifact = { payload: "{}", signature };
  const hook = t.mock.method(Buffer, "from", () => { throw new Error("unexpected Buffer allocation"); });
  try {
    assert.throws(() => verifyArtifact(artifact, configurationKeys.publicKey), /encoding\/size/);
    assert.equal(hook.mock.callCount(), 0);
  } finally { hook.mock.restore(); }
});

test("one effective parser/artifact/acquisition limit, including UTF-8 byte length", async () => {
  assert.equal(MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES, MAX_ECONOMIC_JSON_BYTES);
  assert.equal(MAX_ECONOMIC_JSON_BYTES, 32768);
  const payload = '"' + "x".repeat(MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES - 2) + '"';
  const artifact = { payload, signature: sign(null, Buffer.from(payload), configurationKeys.privateKey).toString("base64url") };
  assert.equal((verifyArtifact<string>(artifact, configurationKeys.publicKey).data).length, MAX_ECONOMIC_JSON_BYTES - 2);
  assert.equal(parseEconomicJson(Buffer.from(payload)), verifyArtifact(artifact, configurationKeys.publicKey).data);
  const f = await readyFixture(), next = snapshotFixture(f.configuration, 2);
  f.state.head = headFixture(f.configuration, next, 2);
  await f.snapshots.refresh({ acquire: async request => {
    assert.equal(request.maxBytes, MAX_ECONOMIC_JSON_BYTES); assert.equal(request.redirects, "reject");
    assert.equal(request.url, f.configuration.profile.keySource); return next;
  } });
});

for (const [name, payload] of [
  ["one byte over parser limit", '"' + "x".repeat(MAX_ECONOMIC_JSON_BYTES - 1) + '"'],
  ["multibyte over byte limit", '"' + "é".repeat(MAX_ECONOMIC_JSON_BYTES / 2) + '"'],
  ["formerly documented outer limit", "x".repeat(131072)],
]) test(`payload rejects before Buffer allocation/verification: ${name}`, t => {
  const signature = signedFixture({}).signature;
  const hook = t.mock.method(Buffer, "from", () => { throw new Error("unexpected Buffer allocation"); });
  try {
    assert.throws(() => verifyArtifact({ payload, signature }, configurationKeys.publicKey), /encoding\/size/);
    assert.equal(hook.mock.callCount(), 0);
  } finally { hook.mock.restore(); }
});

test("service identity peeking applies the same pre-decode bounds", async t => {
  const keys = Object.fromEntries(readinessRoles.map(role => [role, serviceKeys[role].publicKey])) as any;
  const server = new ReadinessServiceTransport("identity", deploymentFixture().configuration, serviceKeys.identity.privateKey, keys,
    { consume: async () => { throw new Error("ledger must not be reached"); } }, []);
  const signature = signedFixture({}).signature;
  for (const input of [{ payload: "{}", signature: "A".repeat(4096) }, { payload: "x".repeat(MAX_ECONOMIC_JSON_BYTES + 1), signature }]) {
    const hook = t.mock.method(Buffer, "from", () => { throw new Error("unexpected Buffer allocation"); });
    try {
      await assert.rejects(() => server.receive(input, "POST", "/test", ""), /encoding\/size/);
      assert.equal(hook.mock.callCount(), 0);
    } finally { hook.mock.restore(); }
  }
});
