import type { KeyObject } from "node:crypto";
import type { PoolClient } from "pg";
import { requireCondition } from "../foundation/database";
import { AuthorityProcess } from "../provider/authorityProcess";
import { digest, frozen, positive, text, verifyArtifact, type SignedArtifact } from "./signedArtifact";

export const readinessRoles = ["identity", "app", "issuer", "signer", "observer", "reader"] as const;
export type ReadinessRole = typeof readinessRoles[number];
export type DeploymentProfile = Readonly<{
  type: "zephipay-deployment-readiness-v1"; mode: "non-value-readiness"; provider: "auth0";
  deploymentId: string; environment: string; revision: number;
  issuer: string; audience: string; clientId: string; dialect: "auth0";
  keySource: string; snapshotAdapter: string; maxSnapshotAgeSeconds: number; maxTokenLifetimeSeconds: number;
  databaseName: string; databaseHost: string; databasePeerSha256: string; endpointAttestor: string;
  services: Readonly<Record<ReadinessRole, Readonly<{ login: string; generation: string; endpoint: string }>>>;
}>;
const verified = new WeakSet<object>();
export type VerifiedDeployment = Readonly<{ profile: DeploymentProfile; fingerprint: string }>;
export function assertVerifiedDeployment(value: VerifiedDeployment): void { requireCondition(verified.has(value), "Authenticated deployment configuration required."); }
export function loadDeploymentProfile(input: SignedArtifact, root: KeyObject, expected: { fingerprint: string; revision: number; deploymentId: string; environment: string }): VerifiedDeployment {
  const result = verifyArtifact<DeploymentProfile>(input, root), p = result.data;
  requireCondition(digest(expected.fingerprint) && result.fingerprint === expected.fingerprint && p.revision === expected.revision &&
    p.deploymentId === expected.deploymentId && p.environment === expected.environment, "Deployment configuration provenance mismatch.");
  requireCondition(p.type === "zephipay-deployment-readiness-v1" && p.mode === "non-value-readiness" && p.provider === "auth0" && p.dialect === "auth0", "Unsupported provider/deployment profile.");
  requireCondition(/^[a-f0-9-]{36}$/.test(p.deploymentId) && [p.environment,p.issuer,p.audience,p.clientId,p.snapshotAdapter,p.databaseName,p.databaseHost,p.endpointAttestor].every(text) && positive(p.revision), "Incomplete deployment profile.");
  const issuer = new URL(p.issuer);
  requireCondition(issuer.protocol === "https:" && issuer.href === p.issuer && issuer.pathname === "/" && !issuer.username && !issuer.password && !issuer.search && !issuer.hash && !issuer.port &&
    p.keySource === `${p.issuer}.well-known/jwks.json` && p.audience !== p.clientId && p.audience !== `${p.issuer}userinfo`, "Issuer, audience or key source mismatch.");
  requireCondition(positive(p.maxSnapshotAgeSeconds) && positive(p.maxTokenLifetimeSeconds) && digest(p.databasePeerSha256) && /^[A-Za-z0-9.-]+$/.test(p.databaseHost), "Explicit lifetime/endpoint policy required.");
  requireCondition(p.services && Object.keys(p.services).sort().join() === [...readinessRoles].sort().join(), "Exact service inventory required.");
  const logins = new Set<string>(), endpoints = new Set<string>();
  for (const role of readinessRoles) {
    const service = p.services[role], endpoint = new URL(service.endpoint);
    requireCondition(/^[a-z][a-z0-9_]{0,62}$/.test(service.login) && /^[1-9][0-9]*$/.test(service.generation) && !logins.has(service.login) &&
      endpoint.protocol === "https:" && endpoint.href === service.endpoint && endpoint.pathname === "/" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && !endpoints.has(service.endpoint), "Distinct service LOGINs and HTTPS identities required.");
    logins.add(service.login); endpoints.add(service.endpoint);
  }
  const value = frozen({ profile: p, fingerprint: result.fingerprint }); verified.add(value); return value;
}

type EndpointProof = { type: "zephipay-database-endpoint-v1"; attestor: string; nonce: string; deploymentId: string; environment: string; configuration: string; host: string; peerSha256: string; verifiedAt: number; expiresAt: number };
/** Unmounted boundary. The attestor must observe verified TLS outside the database; test signatures do not prove production TLS. */
export class DeploymentReadiness {
  constructor(readonly process: AuthorityProcess, readonly configuration: VerifiedDeployment, private readonly attestorKey: KeyObject) {
    assertVerifiedDeployment(configuration);
    const p = configuration.profile, s = p.services[process.role];
    requireCondition(s && process.deployment.deploymentId === p.deploymentId && process.deployment.environment === p.environment &&
      process.deployment.databaseName === p.databaseName && process.deployment.login === s.login && process.deployment.credentialGeneration === s.generation, "Service credential/configuration mismatch.");
  }
  private endpoint(input: SignedArtifact, nonce: string): void {
    const e = verifyArtifact<EndpointProof>(input, this.attestorKey).data, p = this.configuration.profile, now = Date.now() / 1000;
    requireCondition(text(nonce) && e.type === "zephipay-database-endpoint-v1" && e.attestor === p.endpointAttestor && e.nonce === nonce && e.deploymentId === p.deploymentId && e.environment === p.environment &&
      e.configuration === this.configuration.fingerprint && e.host === p.databaseHost && e.peerSha256 === p.databasePeerSha256 && positive(e.verifiedAt) && positive(e.expiresAt) && e.verifiedAt <= now && e.expiresAt > now && e.expiresAt - e.verifiedAt <= 60, "Database endpoint identity rejected.");
  }
  async readiness(proof: SignedArtifact, nonce: string): Promise<void> { this.endpoint(proof, nonce); await this.process.readiness(); this.endpoint(proof, nonce); }
  async run<T>(proof: SignedArtifact, nonce: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.readiness(proof, nonce);
    return this.process.run(async client => { this.endpoint(proof, nonce); const result = await action(client); this.endpoint(proof, nonce); return result; });
  }
}
