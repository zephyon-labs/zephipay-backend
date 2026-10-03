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

/** Pinned public keys only. Provider discovery/refresh transport is deliberately not installed here. */
export class ProviderTokenVerifier {
  readonly contract: ProviderContract;
  private revision = 0;
  private keys!: ReturnType<typeof createLocalJWKSet>;
  private readonly proofs = new WeakSet<object>();

  constructor(contract: ProviderContract, snapshot: { revision: number; jwks: JSONWebKeySet }) {
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
    this.replaceKeys(snapshot);
  }

  replaceKeys(snapshot: { revision: number; jwks: JSONWebKeySet }): void {
    requireCondition(positive(snapshot.revision) && snapshot.revision > this.revision, "Provider key revision must increase.");
    const jwks: JSONWebKeySet = JSON.parse(JSON.stringify(snapshot.jwks));
    requireCondition(jwks.keys.length > 0 && jwks.keys.length <= 16 && new Set(jwks.keys.map(k => k.kid)).size === jwks.keys.length, "Invalid provider key set.");
    for (const key of jwks.keys) requireCondition(key.kty === "RSA" && key.alg === "RS256" && key.use === "sig" && text(key.kid) && !["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(k => k in key), "Only pinned public RS256 verification keys are allowed.");
    this.keys = createLocalJWKSet(jwks);
    this.revision = snapshot.revision;
  }

  get keyRevision(): number { return this.revision; }

  async verify(raw: string, action: ProviderAction): Promise<VerifiedProviderToken> {
    try {
      requireCondition(typeof raw === "string" && raw.length <= 16384 && raw.split(".").length === 3, "Invalid token.");
      // Reject duplicate JSON names before JOSE interprets the signed header/claims.
      const [header, claims] = raw.split(".");
      const h = parseEconomicJson(Buffer.from(header, "base64url")) as Record<string, unknown>;
      parseEconomicJson(Buffer.from(claims, "base64url"));
      requireCondition(h.typ === "at+jwt" && h.alg === "RS256" && text(h.kid) && !["jku", "jwk", "x5u", "x5c", "crit"].some(k => k in h), "Invalid token header.");
      const revision = this.revision;
      const { payload: p } = await jwtVerify(raw, this.keys, {
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
    requireCondition(this.proofs.has(proof) && proof.keyRevision === this.revision && proof.issuedAt <= now && proof.expiresAt > now &&
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
