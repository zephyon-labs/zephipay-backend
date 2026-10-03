import { jwtVerify } from "jose";
import { requireCondition, sha256 } from "../foundation/database";
import { parseEconomicJson } from "../foundation/strictJson";
import { Auth0Snapshots } from "./auth0Snapshots";
import { frozen, positive, text } from "./signedArtifact";

export type Auth0Authentication = Readonly<{
  kind: "authentication-only"; issuer: string; subject: string; clientId: string; scopes: readonly string[];
  tokenDigest: string; issuedAt: number; expiresAt: number; keyRevision: number;
  environment: string; configuration: string; // Derived trusted context, NOT Auth0-signed claims.
}>;
export type ReauthenticationChallenge = Readonly<{
  nonce: string; subject: string; accountSessionId: string; envelopeDigest: string; action: "confirm-economic-intent";
  requestedAt: number; expiresAt: number; maxAuthenticationAgeSeconds: number; acceptedAcr: readonly string[];
}>;
export type Auth0Reauthentication = Readonly<{ kind: "reauthentication-only"; subject: string; authenticationTime: number; acr: string; challengeDigest: string; keyRevision: number }>;
function strictHeader(raw: string): void {
  requireCondition(typeof raw === "string" && raw.length <= 16384 && raw.split(".").length === 3, "Malformed provider token.");
  const [header, claims] = raw.split(".");
  const h = parseEconomicJson(Buffer.from(header, "base64url")) as Record<string,unknown>; parseEconomicJson(Buffer.from(claims,"base64url"));
  requireCondition(h.typ === "JWT" && h.alg === "RS256" && text(h.kid) && !["jku","jwk","x5u","x5c","crit"].some(k => k in h), "Unsupported Auth0 token header.");
}

/** Auth0 default-profile adapter; deliberately cannot mint a generic ProviderTokenVerifier proof or economic consent. */
export class Auth0AuthenticationVerifier {
  private readonly proofs = new WeakSet<object>();
  constructor(readonly snapshots: Auth0Snapshots) {}
  async verifyAccess(raw: string, requiredScope: string): Promise<Auth0Authentication> {
    strictHeader(raw); requireCondition(text(requiredScope) && !requiredScope.includes(" "), "Explicit scope required.");
    const snapshot = await this.snapshots.current(), p = this.snapshots.configuration.profile;
    const { payload: c } = await jwtVerify(raw, snapshot.resolver, { issuer: p.issuer, audience: p.audience, algorithms: ["RS256"], typ: "JWT", clockTolerance: 0, requiredClaims: ["iss","aud","sub","azp","scope","iat","exp"] });
    const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
    requireCondition(audiences.length >= 1 && audiences.length <= 2 && new Set(audiences).size === audiences.length && audiences.includes(p.audience) && audiences.every(a => a === p.audience || a === `${p.issuer}userinfo`) && c.azp === p.clientId, "Auth0 audience/client mismatch.");
    requireCondition(text(c.sub) && !c.sub.endsWith("@clients") && c.gty !== "client-credentials" && !["org_id","org_name","act","sub_profile","client_profile","authorization_details"].some(k => k in c), "Unreviewed principal/delegation profile.");
    requireCondition(typeof c.scope === "string" && c.scope.split(" ").includes(requiredScope) && positive(c.iat) && positive(c.exp) && c.iat <= Date.now()/1000 && c.exp > c.iat && c.exp - c.iat <= p.maxTokenLifetimeSeconds, "Invalid Auth0 scope/time.");
    await this.snapshots.assertCurrent(snapshot);
    requireCondition(c.exp > Date.now()/1000, "Authentication expired during verification.");
    const proof = frozen({ kind: "authentication-only" as const, issuer: p.issuer, subject: c.sub, clientId: p.clientId, scopes: c.scope.split(" "), tokenDigest: sha256(raw), issuedAt: c.iat, expiresAt: c.exp,
      keyRevision: snapshot.provenance.revision, environment: p.environment, configuration: this.snapshots.configuration.fingerprint });
    this.proofs.add(proof); return proof;
  }
  async assertCurrent(proof: Auth0Authentication): Promise<void> {
    requireCondition(this.proofs.has(proof) && proof.expiresAt > Date.now()/1000, "Unverified/expired Auth0 authentication.");
    const snapshot = await this.snapshots.current(); requireCondition(proof.keyRevision === snapshot.provenance.revision && proof.expiresAt > Date.now()/1000, "Retired Auth0 authentication.");
  }
  /** Only a server-stored SDK callback challenge may call this seam; browser-supplied ID tokens/challenge fields are not an API. */
  async verifyReauthentication(rawIdToken: string, input: ReauthenticationChallenge): Promise<Auth0Reauthentication> {
    const challenge = frozen(structuredClone(input)); strictHeader(rawIdToken);
    requireCondition(text(challenge.nonce) && text(challenge.subject) && text(challenge.accountSessionId) && /^[a-f0-9]{64}$/.test(challenge.envelopeDigest) && challenge.action === "confirm-economic-intent" &&
      positive(challenge.requestedAt) && positive(challenge.expiresAt) && challenge.expiresAt > challenge.requestedAt && positive(challenge.maxAuthenticationAgeSeconds) &&
      challenge.acceptedAcr.length > 0 && challenge.acceptedAcr.every(text), "Explicit reauthentication challenge/assurance policy required.");
    const snapshot = await this.snapshots.current(), p = this.snapshots.configuration.profile;
    const { payload: c } = await jwtVerify(rawIdToken, snapshot.resolver, { issuer: p.issuer, audience: p.clientId, algorithms: ["RS256"], typ: "JWT", clockTolerance: 0, requiredClaims: ["iss","aud","sub","nonce","iat","exp","auth_time","acr"] });
    const now = Date.now()/1000;
    requireCondition(c.aud === p.clientId && (c.azp === undefined || c.azp === p.clientId) && c.sub === challenge.subject && c.nonce === challenge.nonce && positive(c.iat) && positive(c.exp) && c.iat <= now && c.exp > c.iat &&
      c.exp - c.iat <= p.maxTokenLifetimeSeconds && positive(c.auth_time) && c.auth_time <= c.iat && c.auth_time >= challenge.requestedAt && now - c.auth_time <= challenge.maxAuthenticationAgeSeconds &&
      challenge.requestedAt <= now && challenge.expiresAt > now && text(c.acr) && challenge.acceptedAcr.includes(c.acr), "Recent authentication/assurance unavailable or mismatched.");
    await this.snapshots.assertCurrent(snapshot);
    requireCondition(challenge.expiresAt > Date.now()/1000 && c.exp > Date.now()/1000 && Date.now()/1000-c.auth_time <= challenge.maxAuthenticationAgeSeconds, "Reauthentication expired during verification.");
    return frozen({ kind: "reauthentication-only", subject: c.sub, authenticationTime: c.auth_time, acr: c.acr, challengeDigest: sha256(JSON.stringify(challenge)), keyRevision: snapshot.provenance.revision });
  }
}
