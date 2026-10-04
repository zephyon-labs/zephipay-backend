import { createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { requireCondition, sha256 } from "../foundation/database";
import { parseEconomicJson } from "../foundation/strictJson";
import { assertVerifiedDeployment, readinessRoles, type ReadinessRole, type VerifiedDeployment } from "./deploymentProfile";
import { assertArtifactBounds, frozen, positive, verifyArtifact, type SignedArtifact } from "./signedArtifact";

export interface TransportReplayLedger {
  /** Atomic insert-if-absent. Production must be durable/shared through expiry; no volatile fallback. */
  consume(id: string, expiresAt: number): Promise<boolean>;
}
type Message = {
  type: "zephipay-readiness-request-v1" | "zephipay-readiness-response-v1";
  caller: ReadinessRole; server: ReadinessRole; callerGeneration: string; serverGeneration: string;
  callerEndpoint: string; serverEndpoint: string; environment: string; deploymentId: string; configuration: string;
  requestId: string; method: string; path: string; bodyDigest: string; issuedAt: number; expiresAt: number;
  requestFingerprint?: string;
};
export type TransportRoute = Readonly<{ caller: ReadinessRole; method: string; path: string }>;
/** Non-network test adapter. Exercises mutual message authentication; does NOT attest production mTLS, mesh or network isolation. */
export class ReadinessServiceTransport {
  private readonly responses = new WeakSet<object>();
  private readonly publicKeys: Readonly<Record<ReadinessRole, KeyObject>>;
  private readonly routes: readonly TransportRoute[];
  constructor(readonly role: ReadinessRole, readonly configuration: VerifiedDeployment, private readonly signingKey: KeyObject,
    keys: Readonly<Record<ReadinessRole, KeyObject>>, private readonly replay: TransportReplayLedger, routes: readonly TransportRoute[]) {
    assertVerifiedDeployment(configuration);
    requireCondition(Object.keys(keys).sort().join() === [...readinessRoles].sort().join(), "Exact workload key inventory required.");
    const identities = new Set<string>();
    for (const service of readinessRoles) {
      const key = keys[service];
      requireCondition(key.type === "public" && key.asymmetricKeyType === "ed25519", "Public Ed25519 workload key required.");
      const identity = key.export({ type: "spki", format: "pem" }).toString();
      requireCondition(!identities.has(identity), "Distinct workload keys required for credential isolation.");
      identities.add(identity);
    }
    requireCondition(readinessRoles.includes(role) && signingKey.type === "private" && signingKey.asymmetricKeyType === "ed25519" &&
      createPublicKey(signingKey).export({type:"spki",format:"pem"}) === keys[role].export({type:"spki",format:"pem"}), "Service key identity mismatch.");
    this.publicKeys = Object.freeze({...keys}); this.routes = frozen(structuredClone(routes));
  }
  private seal(data: Message): SignedArtifact { const payload = JSON.stringify(data); return Object.freeze({payload,signature:sign(null,Buffer.from(payload),this.signingKey).toString("base64url")}); }
  request(server: ReadinessRole, method: string, path: string, body: string): SignedArtifact {
    const p = this.configuration.profile, now = Math.floor(Date.now()/1000);
    requireCondition(readinessRoles.includes(server) && /^(GET|POST)$/.test(method) && /^\/[a-z0-9/-]{1,128}$/.test(path) && Buffer.byteLength(body)<=65536, "Bounded request required.");
    return this.seal({type:"zephipay-readiness-request-v1",caller:this.role,server,callerGeneration:p.services[this.role].generation,serverGeneration:p.services[server].generation,
      callerEndpoint:p.services[this.role].endpoint,serverEndpoint:p.services[server].endpoint,environment:p.environment,deploymentId:p.deploymentId,configuration:this.configuration.fingerprint,
      requestId:randomUUID(),method,path,bodyDigest:sha256(body),issuedAt:now,expiresAt:now+60});
  }
  private authenticated(input: SignedArtifact, response: boolean): Message {
    assertArtifactBounds(input);
    const peek = parseEconomicJson(Buffer.from(input.payload)) as Message;
    requireCondition(readinessRoles.includes(peek.caller) && readinessRoles.includes(peek.server), "Unknown service identity.");
    const m = verifyArtifact<Message>(input,this.publicKeys[response ? peek.server : peek.caller]).data, p = this.configuration.profile, now=Date.now()/1000;
    requireCondition(m.type === (response ? "zephipay-readiness-response-v1" : "zephipay-readiness-request-v1") && m.configuration===this.configuration.fingerprint && m.deploymentId===p.deploymentId && m.environment===p.environment &&
      m.callerGeneration===p.services[m.caller].generation && m.serverGeneration===p.services[m.server].generation && m.callerEndpoint===p.services[m.caller].endpoint && m.serverEndpoint===p.services[m.server].endpoint &&
      /^[a-f0-9-]{36}$/.test(m.requestId) && positive(m.issuedAt) && positive(m.expiresAt) && m.issuedAt<=now && m.expiresAt>now && m.expiresAt-m.issuedAt<=60, "Service context/generation/expiry rejected.");
    return m;
  }
  async receive(input: SignedArtifact, method: string, path: string, body: string): Promise<Readonly<Message>> {
    const m=this.authenticated(input,false);
    requireCondition(m.server===this.role && m.method===method && m.path===path && Buffer.byteLength(body)<=65536 && m.bodyDigest===sha256(body) &&
      this.routes.some(r=>r.caller===m.caller&&r.method===method&&r.path===path), "Service route/body/caller rejected.");
    requireCondition(await this.replay.consume(sha256(JSON.stringify([m.deploymentId,m.server,m.requestId])),m.expiresAt), "Transport replay rejected.");
    requireCondition(m.expiresAt>Date.now()/1000,"Transport expired while awaiting replay ledger.");
    this.responses.add(m); return m;
  }
  respond(request: Readonly<Message>, body: string): SignedArtifact {
    requireCondition(this.responses.has(request) && request.expiresAt>Date.now()/1000 && Buffer.byteLength(body)<=65536,"Verified request required.");
    this.responses.delete(request);
    return this.seal({...request,type:"zephipay-readiness-response-v1",bodyDigest:sha256(body),requestFingerprint:sha256(JSON.stringify(request))});
  }
  async verifyResponse(original: SignedArtifact, response: SignedArtifact, body: string): Promise<void> {
    requireCondition(Buffer.byteLength(body) <= 65536, "Bounded response required.");
    const request=this.authenticated(original,false), result=this.authenticated(response,true);
    requireCondition(request.caller===this.role && result.caller===this.role && result.server===request.server && result.requestId===request.requestId &&
      result.requestFingerprint===sha256(JSON.stringify(request)) && result.method===request.method && result.path===request.path && result.bodyDigest===sha256(body), "Server response binding rejected.");
    requireCondition(await this.replay.consume(sha256(JSON.stringify([request.deploymentId,this.role,"response",request.requestId])),result.expiresAt),"Response replay rejected.");
    requireCondition(result.expiresAt>Date.now()/1000,"Response expired while awaiting replay ledger.");
  }
}
