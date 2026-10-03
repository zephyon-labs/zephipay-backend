import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { requireCondition, sha256 } from "../foundation/database";
import { parseEconomicJson } from "../foundation/strictJson";

export type ProviderAction = "create-session" | "bind-session" | "revoke-session" | "consent";
export type FreshnessPolicy = Readonly<{ maxAuthenticationAgeSeconds?: number; acceptedAcr?: readonly string[] }>;
export type ProviderContract = Readonly<{
  issuer: string; audience: string; authorizedClient: string; environment: string; context: string;
  maxTokenAgeSeconds: number; maxTokenLifetimeSeconds: number;
  actions: Readonly<Record<ProviderAction, Readonly<{ scope: string; freshness: FreshnessPolicy }>>>;
}>;
export type VerifiedProviderToken = Readonly<{
  issuer: string; subject: string; session: string; tokenId: string; tokenDigest: string;
  issuedAt: number; expiresAt: number; notBefore?: number; authenticationTime?: number;
  acr?: string; keyRevision: number; action: ProviderAction;
}>;

function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }

// RS256 minimum used by the pinned JOSE verification stack; no provider-specific exceptions.
export const MIN_PROVIDER_RSA_BITS = 2048;
const MAX_RSA_INTEGER_BYTES = 2048; // Bounded configuration input, up to a 16384-bit modulus.
type KeyConfiguration = Readonly<{ revision: number; jwks: JSONWebKeySet }>;
type ActiveKeys = Readonly<{ revision: number; resolver: ReturnType<typeof createLocalJWKSet> }>;

function rsaInteger(value: unknown): Buffer {
  requireCondition(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(MAX_RSA_INTEGER_BYTES * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(value), "Invalid RSA public integer.");
  const bytes = Buffer.from(value, "base64url");
  requireCondition(bytes.length > 0 && bytes.length <= MAX_RSA_INTEGER_BYTES && bytes[0] !== 0 && bytes.toString("base64url") === value, "Noncanonical RSA public integer.");
  return bytes;
}

function validateKeySet(input: JSONWebKeySet): JSONWebKeySet {
  // Copy before any await. Unlike JSON stringify, structuredClone preserves undefined metadata
  // so an unsupported/private member cannot disappear before the allowlist check.
  const jwks: JSONWebKeySet = structuredClone(input);
  requireCondition(jwks && Object.keys(jwks).length === 1 && Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 16, "Invalid provider key set.");
  const kids = new Set<string>();
  for (const key of jwks.keys) {
    requireCondition(key && typeof key === "object" && !Array.isArray(key) && Object.keys(key).every(name => ["kty", "kid", "n", "e", "alg", "use", "key_ops"].includes(name)), "Unsupported or private key metadata.");
    requireCondition(key.kty === "RSA" && text(key.kid) && !kids.has(key.kid), "Invalid or duplicate RSA key identity.");
    kids.add(key.kid);
    requireCondition(!("alg" in key) || key.alg === "RS256", "Incompatible RSA algorithm.");
    requireCondition(!("use" in key) || key.use === "sig", "Incompatible RSA use.");
    requireCondition(!("key_ops" in key) || (Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === "verify"), "RSA key must permit only verification.");
    const n = rsaInteger(key.n), e = rsaInteger(key.e);
    const modulus = BigInt(`0x${n.toString("hex")}`), exponent = BigInt(`0x${e.toString("hex")}`);
    requireCondition((modulus & 1n) === 1n && exponent >= 3n && (exponent & 1n) === 1n && exponent < modulus, "Invalid RSA modulus or exponent.");
    requireCondition((n.length - 1) * 8 + (32 - Math.clz32(n[0])) >= MIN_PROVIDER_RSA_BITS, "RSA modulus is below supported strength.");
  }
  return jwks;
}

/** Pinned public keys only. Provider discovery/refresh transport is deliberately not installed here. */
export class ProviderTokenVerifier {
  readonly contract: ProviderContract;
  private active?: ActiveKeys;
  private readonly proofs = new WeakSet<object>();

  /** Configuration alone is never ready. Prefer the awaited create factory. */
  constructor(contract: ProviderContract) {
    requireCondition([contract.issuer, contract.audience, contract.authorizedClient, contract.environment, contract.context].every(text), "Incomplete provider contract.");
    requireCondition(new URL(contract.issuer).protocol === "https:", "HTTPS provider issuer required.");
    requireCondition(positive(contract.maxTokenAgeSeconds) && positive(contract.maxTokenLifetimeSeconds), "Explicit token time limits required.");
    const actions = Object.fromEntries((["create-session", "bind-session", "revoke-session", "consent"] as const).map(action => {
      const policy = contract.actions[action];
      requireCondition(policy && text(policy.scope) && !policy.scope.includes(" "), "Explicit action scope required.");
      const f = policy.freshness;
      requireCondition(f && (f.maxAuthenticationAgeSeconds === undefined || positive(f.maxAuthenticationAgeSeconds)), "Invalid authentication freshness policy.");
      requireCondition(f.acceptedAcr === undefined || (f.acceptedAcr.length > 0 && f.acceptedAcr.every(text)), "Invalid assurance policy.");
      return [action, Object.freeze({ scope: policy.scope, freshness: Object.freeze({ ...f, ...(f.acceptedAcr ? { acceptedAcr: Object.freeze([...f.acceptedAcr]) } : {}) }) })];
    })) as ProviderContract["actions"];
    this.contract = Object.freeze({ ...contract, actions: Object.freeze(actions) });
  }

  static async create(contract: ProviderContract, snapshot: KeyConfiguration): Promise<ProviderTokenVerifier> {
    const verifier = new ProviderTokenVerifier(contract);
    await verifier.replaceKeys(snapshot);
    return verifier;
  }

  async replaceKeys(input: KeyConfiguration): Promise<void> {
    const revision = input.revision;
    requireCondition(positive(revision) && revision > (this.active?.revision ?? 0), "Provider key revision must increase.");
    try {
      const jwks = validateKeySet(input.jwks), resolver = createLocalJWKSet(jwks);
      // Resolve every kid eagerly through the exact JOSE resolver used by jwtVerify. This imports
      // and caches each public CryptoKey before publication; no provider JWT is needed.
      for (const jwk of jwks.keys) {
        const key = await resolver({ alg: "RS256", kid: jwk.kid });
        const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
        requireCondition(key.type === "public" && key.usages.length === 1 && key.usages[0] === "verify" &&
          algorithm.name === "RSASSA-PKCS1-v1_5" && algorithm.hash.name === "SHA-256" && algorithm.modulusLength >= MIN_PROVIDER_RSA_BITS, "Unusable RS256 verification key.");
        // A deliberately invalid zero signature exercises the same WebCrypto verification
        // primitive as JOSE. It must execute and reject, not fail to initialize or verify true.
        requireCondition(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, new Uint8Array(Math.ceil(algorithm.modulusLength / 8)), new Uint8Array()) === false, "Unusable RSA verification operation.");
      }
      // An overlapping newer replacement may have won while imports awaited. Never roll it back.
      requireCondition(revision > (this.active?.revision ?? 0), "Provider key revision must increase.");
      this.active = Object.freeze({ revision, resolver });
    } catch { throw new Error("PROVIDER_KEY_INITIALIZATION_REJECTED"); }
  }

  private initializedSnapshot(): ActiveKeys {
    requireCondition(this.active, "PROVIDER_KEYS_NOT_INITIALIZED");
    return this.active;
  }

  assertInitialized(): number { return this.initializedSnapshot().revision; }
  get keyRevision(): number { return this.assertInitialized(); }

  async verify(raw: string, action: ProviderAction): Promise<VerifiedProviderToken> {
    try {
      requireCondition(typeof raw === "string" && raw.length <= 16384 && raw.split(".").length === 3, "Invalid token.");
      // Reject duplicate JSON names before JOSE interprets the signed header/claims.
      const [header, claims] = raw.split(".");
      const h = parseEconomicJson(Buffer.from(header, "base64url")) as Record<string, unknown>;
      parseEconomicJson(Buffer.from(claims, "base64url"));
      requireCondition(h.typ === "at+jwt" && h.alg === "RS256" && text(h.kid) && !["jku", "jwk", "x5u", "x5c", "crit"].some(k => k in h), "Invalid token header.");
      const { revision, resolver } = this.initializedSnapshot();
      const { payload: p } = await jwtVerify(raw, resolver, {
        issuer: this.contract.issuer, audience: this.contract.audience, algorithms: ["RS256"], typ: "at+jwt", clockTolerance: 0,
        requiredClaims: ["iss", "aud", "sub", "sid", "jti", "iat", "exp", "azp", "scope", "zep_environment", "zep_context"],
      });
      requireCondition(p.aud === this.contract.audience && p.azp === this.contract.authorizedClient && p.zep_environment === this.contract.environment && p.zep_context === this.contract.context, "Provider context mismatch.");
      requireCondition(text(p.sub) && text(p.sid) && text(p.jti) && typeof p.scope === "string" && p.scope.split(" ").includes(this.contract.actions[action].scope), "Missing provider session or action scope.");
      for (const field of ["iat", "exp", "nbf", "auth_time"] as const) requireCondition(p[field] === undefined || (Number.isSafeInteger(p[field]) && Number(p[field]) >= 0), "Invalid provider time.");
      requireCondition(p.acr === undefined || text(p.acr), "Invalid assurance claim.");
      const proof = Object.freeze({ issuer: this.contract.issuer, subject: p.sub, session: p.sid, tokenId: sha256(JSON.stringify([p.iss, this.contract.environment, p.jti])),
        tokenDigest: sha256(raw), issuedAt: p.iat!, expiresAt: p.exp!, notBefore: p.nbf, authenticationTime: p.auth_time as number | undefined,
        acr: p.acr as string | undefined, keyRevision: revision, action });
      this.proofs.add(proof);
      this.assertCurrent(proof, Date.now());
      return proof;
    } catch { throw new Error("PROVIDER_AUTHENTICATION_REJECTED"); }
  }

  /** Re-evaluate after database lock waits; a shaped object or old key snapshot cannot confer authority. */
  assertCurrent(proof: VerifiedProviderToken, nowMilliseconds: number): void {
    const now = nowMilliseconds / 1000;
    requireCondition(this.proofs.has(proof) && proof.keyRevision === this.keyRevision && proof.issuedAt <= now && proof.expiresAt > now &&
      (proof.notBefore === undefined || proof.notBefore <= now) && proof.expiresAt > proof.issuedAt &&
      proof.expiresAt - proof.issuedAt <= this.contract.maxTokenLifetimeSeconds && now - proof.issuedAt <= this.contract.maxTokenAgeSeconds,
    "PROVIDER_AUTHENTICATION_REJECTED");
    const freshness = this.contract.actions[proof.action].freshness;
    requireCondition(proof.authenticationTime === undefined || proof.authenticationTime <= proof.issuedAt, "PROVIDER_AUTHENTICATION_REJECTED");
    requireCondition(freshness.maxAuthenticationAgeSeconds === undefined || (proof.authenticationTime !== undefined && now - proof.authenticationTime <= freshness.maxAuthenticationAgeSeconds), "PROVIDER_RECENT_AUTH_REQUIRED");
    requireCondition(freshness.acceptedAcr === undefined || (proof.acr !== undefined && freshness.acceptedAcr.includes(proof.acr)), "PROVIDER_STEP_UP_REQUIRED");
  }

  eligibleUntil(proof: VerifiedProviderToken): number {
    requireCondition(this.proofs.has(proof), "PROVIDER_AUTHENTICATION_REJECTED");
    const age = this.contract.actions[proof.action].freshness.maxAuthenticationAgeSeconds;
    return Math.min(proof.expiresAt, proof.issuedAt + this.contract.maxTokenAgeSeconds,
      age === undefined || proof.authenticationTime === undefined ? Infinity : proof.authenticationTime + age);
  }
}
