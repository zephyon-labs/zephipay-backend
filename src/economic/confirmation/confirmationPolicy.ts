import type { KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { requireCondition, transaction } from "../foundation/database";
import { exactObject } from "../foundation/strictJson";
import { assertVerifiedDeployment, type VerifiedDeployment } from "../readiness/deploymentProfile";
import { frozen, positive, text, verifyArtifact, type SignedArtifact } from "../readiness/signedArtifact";

export type ConfirmationPolicy = Readonly<{
  type: "zephipay-confirmation-policy-v1"; mode: "non-value"; deploymentId: string; environment: string;
  configuration: string; revision: number; issuer: string; audience: string; clientId: string;
  dialect: "auth0"; algorithm: "RS256"; flow: "authorization-code-pkce";
  attestation: "TEST" | "ATTESTED" | "UNATTESTED"; operator: string; reference: string;
  allowedConnections: readonly string[]; refreshPolicy: "disabled"; reauthentication: "TEST" | "ATTESTED" | "UNATTESTED";
  issuedAt: number; expiresAt: number; requiredScope: string; challengeSeconds: number;
  maxAuthenticationAgeSeconds: number; consentSeconds: number; acceptedAcr: readonly string[];
}>;
export type VerifiedConfirmationPolicy = Readonly<{ policy: ConfirmationPolicy; fingerprint: string; artifact: SignedArtifact }>;
const verified = new WeakSet<object>();

export function loadConfirmationPolicy(artifact: SignedArtifact, root: KeyObject, deployment: VerifiedDeployment, expectedFingerprint: string): VerifiedConfirmationPolicy {
  assertVerifiedDeployment(deployment);
  const result = verifyArtifact<ConfirmationPolicy>(artifact, root), p = result.data, d = deployment.profile;
  exactObject(p, ["type","mode","deploymentId","environment","configuration","revision","issuer","audience","clientId","dialect","algorithm","flow",
    "attestation","operator","reference","allowedConnections","refreshPolicy","reauthentication","issuedAt","expiresAt","requiredScope","challengeSeconds","maxAuthenticationAgeSeconds","consentSeconds","acceptedAcr"]);
  requireCondition(result.fingerprint === expectedFingerprint && p.type === "zephipay-confirmation-policy-v1" && p.mode === "non-value" &&
    p.deploymentId === d.deploymentId && p.environment === d.environment && p.configuration === deployment.fingerprint && p.issuer === d.issuer && p.audience === d.audience && p.clientId === d.clientId &&
    p.dialect === "auth0" && p.algorithm === "RS256" && p.flow === "authorization-code-pkce" && p.refreshPolicy === "disabled", "Confirmation profile mismatch.");
  requireCondition([p.revision,p.issuedAt,p.expiresAt,p.challengeSeconds,p.maxAuthenticationAgeSeconds,p.consentSeconds].every(positive) && p.expiresAt>p.issuedAt &&
    p.expiresAt-p.issuedAt<=86400 && [p.challengeSeconds,p.maxAuthenticationAgeSeconds,p.consentSeconds].every(v=>v<=600) &&
    [p.operator,p.reference,p.requiredScope].every(text) && !p.requiredScope.includes(" ") &&
    [p.attestation,p.reauthentication].every(v=>["TEST","ATTESTED","UNATTESTED"].includes(v)) &&
    [p.allowedConnections,p.acceptedAcr].every(v=>Array.isArray(v)&&v.length>0&&v.length<=16&&v.every(text)&&new Set(v).size===v.length), "Explicit bounded confirmation policy required.");
  const value = frozen({ policy:p, fingerprint:result.fingerprint, artifact:{...artifact} }); verified.add(value); return value;
}
export function assertConfirmationPolicy(value: VerifiedConfirmationPolicy): void {
  requireCondition(verified.has(value), "Verified confirmation policy required.");
}
/** Offline administrator only: ordinary services have no INSERT/UPDATE privilege on policy records/heads. */
export async function registerConfirmationPolicy(pool: Pool, value: VerifiedConfirmationPolicy): Promise<void> {
  assertConfirmationPolicy(value);
  await transaction(pool, async client => {
    const p = value.policy;
    await client.query("INSERT INTO economic_confirmation_policies(fingerprint,deployment_id,revision,payload,signature) VALUES($1,$2,$3,$4,$5) ON CONFLICT(fingerprint) DO NOTHING",
      [value.fingerprint,p.deploymentId,p.revision,value.artifact.payload,value.artifact.signature]);
    const prior = (await client.query("SELECT * FROM economic_confirmation_policy_heads WHERE deployment_id=$1 FOR UPDATE", [p.deploymentId])).rows[0];
    if(prior?.fingerprint===value.fingerprint) return;
    await client.query(`INSERT INTO economic_confirmation_policy_heads VALUES($1,$2,$3)
      ON CONFLICT(deployment_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,revision=EXCLUDED.revision`,[p.deploymentId,value.fingerprint,p.revision]);
  });
}
export async function lockConfirmationPolicy(client: PoolClient, value: VerifiedConfirmationPolicy): Promise<void> {
  assertConfirmationPolicy(value);
  const p = value.policy;
  const head = (await client.query("SELECT * FROM economic_confirmation_policy_heads WHERE deployment_id=$1 FOR SHARE",[p.deploymentId])).rows[0];
  const stored = (await client.query("SELECT payload,signature FROM economic_confirmation_policies WHERE fingerprint=$1",[value.fingerprint])).rows[0];
  requireCondition(head?.fingerprint===value.fingerprint && String(head.revision)===String(p.revision) && stored?.payload===value.artifact.payload && stored.signature===value.artifact.signature, "Retired or unregistered confirmation policy.");
  const now = (await client.query("SELECT extract(epoch from clock_timestamp()) AS now")).rows[0].now;
  requireCondition(p.issuedAt<=Number(now)&&p.expiresAt>Number(now)&&p.attestation!=="UNATTESTED"&&p.reauthentication!=="UNATTESTED", "Unattested or expired confirmation policy.");
}
export function confirmationProductionGate(value: VerifiedConfirmationPolicy) {
  assertConfirmationPolicy(value);
  return frozen({ productionReady:false, factsAttested:value.policy.attestation==="ATTESTED"&&value.policy.reauthentication==="ATTESTED",
    reason:"NON_VALUE_PACKAGE_REQUIRES_SEPARATE_DEPLOYMENT_APPROVAL" });
}
