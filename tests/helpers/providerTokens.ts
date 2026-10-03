import { generateKeyPairSync } from "node:crypto";
import { SignJWT, type JSONWebKeySet } from "jose";
import type { ProviderContract } from "../../src/economic/provider/providerTokenVerifier";

// Generated per test process; no deployed provider or persisted private key.
export const providerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const providerJwks: JSONWebKeySet = { keys: [{ ...providerKeys.publicKey.export({ format: "jwk" }), kid: "fixture-v1", alg: "RS256", use: "sig" }] };
export const providerContract: ProviderContract = {
  issuer: "https://economic-auth.example/", audience: "https://economic-api.example/", authorizedClient: "fixture-browser",
  environment: "offline-fixture", context: "zephipay-economic-consent-v1", maxTokenAgeSeconds: 300, maxTokenLifetimeSeconds: 600,
  actions: {
    "create-session": { scope: "create:session", freshness: {} },
    "bind-session": { scope: "bind:session", freshness: {} },
    "revoke-session": { scope: "revoke:session", freshness: {} },
    consent: { scope: "confirm:economic", freshness: { maxAuthenticationAgeSeconds: 120, acceptedAcr: ["urn:fixture:recent"] } },
  },
};
let sequence = 0;
export async function providerToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = providerKeys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: providerContract.issuer, aud: providerContract.audience, sub: "subject:alice", sid: "session:test",
    jti: `fixture-token-${++sequence}`, iat: now - 1, exp: now + 240, auth_time: now - 5, acr: "urn:fixture:recent", azp: providerContract.authorizedClient,
    scope: "create:session bind:session revoke:session confirm:economic", zep_environment: providerContract.environment, zep_context: providerContract.context, ...claims })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "fixture-v1", ...header }).sign(key);
}
