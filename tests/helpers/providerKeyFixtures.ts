import { generateKeyPairSync } from "node:crypto";
import type { JSONWebKeySet, JWK } from "jose";
import { providerJwks } from "./providerTokens";

// Disposable local keys only; malformed fixtures are configuration inputs, never provider tokens.
export const strongerProviderKeys = generateKeyPairSync("rsa", { modulusLength: 3072 });
export const strongerProviderJwks: JSONWebKeySet = { keys: [{ ...strongerProviderKeys.publicKey.export({ format: "jwk" }), kid: "fixture-stronger", alg: "RS256", use: "sig", key_ops: ["verify"] }] };
const weakPublicKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" });
const valid = providerJwks.keys[0];
function changed(fields: Record<string, unknown>, omitted: string[] = []): JSONWebKeySet {
  const key = { ...valid, ...fields };
  for (const field of omitted) delete key[field];
  return { keys: [key as JWK] };
}
const evenModulus = Buffer.from(valid.n!, "base64url"); evenModulus[evenModulus.length - 1] &= 254;
export const invalidProviderKeySets: ReadonlyArray<Readonly<{ name: string; jwks: JSONWebKeySet }>> = [
  { name: "missing n", jwks: changed({}, ["n"]) },
  { name: "missing e", jwks: changed({}, ["e"]) },
  { name: "empty n", jwks: changed({ n: "" }) },
  { name: "empty e", jwks: changed({ e: "" }) },
  { name: "malformed n type", jwks: changed({ n: 123 }) },
  { name: "malformed e type", jwks: changed({ e: [3] }) },
  { name: "invalid base64url n", jwks: changed({ n: "++/invalid=" }) },
  { name: "invalid base64url e", jwks: changed({ e: "AQ AB" }) },
  { name: "noncanonical base64url bits", jwks: changed({ e: "Ax" }) },
  { name: "zero n", jwks: changed({ n: "AA" }) },
  { name: "zero e", jwks: changed({ e: "AA" }) },
  { name: "leading zero modulus", jwks: changed({ n: Buffer.concat([Buffer.from([0]), Buffer.from(valid.n!, "base64url")]).toString("base64url") }) },
  { name: "even modulus", jwks: changed({ n: evenModulus.toString("base64url") }) },
  { name: "unit exponent", jwks: changed({ e: "AQ" }) },
  { name: "even exponent", jwks: changed({ e: "Ag" }) },
  { name: "exponent at least modulus", jwks: changed({ e: valid.n }) },
  { name: "wrong kty", jwks: changed({ kty: "EC" }) },
  { name: "incompatible alg", jwks: changed({ alg: "PS256" }) },
  { name: "private field", jwks: changed({ d: "private-material-forbidden" }) },
  { name: "undefined private field", jwks: changed({ p: undefined }) },
  { name: "sign-only key_ops", jwks: changed({ key_ops: ["sign"] }) },
  { name: "mixed key_ops", jwks: changed({ key_ops: ["verify", "sign"] }) },
  { name: "empty key_ops", jwks: changed({ key_ops: [] }) },
  { name: "malformed key_ops", jwks: changed({ key_ops: "verify" }) },
  { name: "incompatible use", jwks: changed({ use: "enc" }) },
  { name: "1024-bit RSA", jwks: changed(weakPublicKey) },
  { name: "duplicate kid", jwks: { keys: [valid, { ...valid }] } },
  { name: "unsupported metadata", jwks: changed({ x5u: "https://unused.example/cert" }) },
  { name: "unsupported ext metadata", jwks: changed({ ext: true }) },
  { name: "valid key plus unusable key", jwks: { keys: [valid, { ...valid, kid: "broken-second", n: "" }] } },
];
