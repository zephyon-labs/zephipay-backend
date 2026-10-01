import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Router } from "express";
import type { Pool, PoolClient } from "pg";
import { EconomicConsentV1, EconomicIntentEnvelopeV1, RuntimeDecisionBindingV1, assertEconomicAuthorizationV1, authorizationBindingDigestV1, createEconomicIntentEnvelopeV1, createRuntimePolicyReferenceV1, sameNetworkV1 } from "zephyon-protocol";
import { createAuthPipeline, externalPrincipalFrom, type AuthConfiguration } from "../../auth/authMiddleware";
import { audit, databaseTime, machineId, requireCondition, sha256, transaction } from "./database";
import { exactObject, parseEconomicJson } from "./strictJson";
import { lockEconomicSession } from "./sessionAuthority";
import { qualifyAsset } from "./trustedRegistry";

export type EvidencePolicy = Readonly<{
  auth: AuthConfiguration;
  runtimeIssuer: string;
  policyVersions: readonly string[];
  context: "production" | "devnet-test";
}>;

/** Trusted in-process SDK adapter OR authenticated private transport. No default implementation or public ingestion endpoint. */
export interface TrustedRuntimeIssuer {
  evaluate(envelope: EconomicIntentEnvelopeV1): Promise<Uint8Array>;
}

export function validateEvidencePolicy(policy: EvidencePolicy): EvidencePolicy {
  machineId(policy.runtimeIssuer);
  requireCondition(policy.auth.issuer && policy.auth.audience && policy.auth.requiredScope && policy.policyVersions.length > 0, "Missing trusted evidence configuration.");
  policy.policyVersions.forEach(machineId);
  requireCondition(policy.context === "production" || policy.context === "devnet-test", "Invalid evidence context.");
  return Object.freeze({ ...policy, auth: Object.freeze({ ...policy.auth }), policyVersions: Object.freeze([...policy.policyVersions]) });
}

function scopeAllowed(envelope: EconomicIntentEnvelopeV1, policy: EvidencePolicy): void {
  requireCondition(policy.policyVersions.includes(envelope.runtime.policyVersion), "Untrusted Runtime policy version.");
  requireCondition(envelope.runtime.scope === "production" || (policy.context === "devnet-test" && envelope.amount.asset.network.environment === "devnet"), "Test-scope Runtime evidence forbidden in production context.");
}

export async function loadEnvelope(client: PoolClient, digest: string): Promise<EconomicIntentEnvelopeV1> {
  const row = (await client.query("SELECT envelope FROM economic_attempts WHERE envelope_digest=$1", [digest])).rows[0];
  requireCondition(row, "Unknown economic envelope.");
  return createEconomicIntentEnvelopeV1(row.envelope, row.envelope.amount.asset);
}

export async function assertActivePrincipal(client: PoolClient, principalId: string): Promise<void> {
  const account = (await client.query("SELECT status FROM accounts WHERE actor_subject=$1 FOR SHARE", [principalId])).rows[0];
  requireCondition(account?.status === "ACTIVE", "Economic principal inactive or unknown.");
}

/** Every eligible operation loads server-owned records. No consent/approved object argument exists. */
export async function loadAuthoritativeEvidence(client: PoolClient, envelope: EconomicIntentEnvelopeV1, consentId: string, policy: EvidencePolicy, now: string) {
  scopeAllowed(envelope, policy);
  await assertActivePrincipal(client, envelope.principal.id);
  const c = (await client.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1 FOR SHARE", [consentId])).rows[0];
  const d = (await client.query("SELECT * FROM economic_runtime_evidence WHERE decision_id=$1 FOR SHARE", [envelope.runtime.decisionId])).rows[0];
  requireCondition(c && !c.revoked_at && c.issuer === policy.auth.issuer && c.audience === policy.auth.audience && c.context === "zephipay-economic-consent-v1" && c.expires_at.toISOString() > now, "Missing, stale, revoked or unauthenticated consent.");
  requireCondition(d && !d.revoked_at && d.issuer === policy.runtimeIssuer && d.policy_version === envelope.runtime.policyVersion && d.evidence_digest === envelope.runtime.evidenceDigest && d.scope === envelope.runtime.scope && d.valid_from.toISOString() <= now && d.valid_until.toISOString() > now && sameNetworkV1(d.network, envelope.amount.asset.network), "Missing, stale, revoked or unauthenticated Runtime evidence.");
  await lockEconomicSession(client, { issuer: c.issuer, subject: c.provider_subject, providerSession: c.session_reference, principalId: envelope.principal.id, requiredSessionId: c.account_session_id });
  // Session/account lock waits may cross validity; validate the fresh database clock under all authority locks.
  const eligibleAt = await databaseTime(client);
  requireCondition(c.expires_at.toISOString() > eligibleAt && d.valid_from.toISOString() <= eligibleAt && d.valid_until.toISOString() > eligibleAt,"Evidence expired during eligibility lock wait.");
  const consent: EconomicConsentV1 = { schema: "zephyon.economic-consent/v1", consentId: c.consent_id, principalId: c.principal_id, envelopeDigest: c.envelope_digest, confirmedAt: c.confirmed_at.toISOString() };
  const decision = d.binding as RuntimeDecisionBindingV1;
  requireCondition(d.envelope_digest === consent.envelopeDigest, "Runtime envelope mismatch.");
  assertEconomicAuthorizationV1(envelope, consent, decision, eligibleAt);
  return { consent, decision };
}

/** Factory creates an UNMOUNTED, authenticated raw transport seam. It cannot accept a caller-created principal. */
export function createEconomicEvidenceIngestion(pool: Pool, configuration: EvidencePolicy, runtime: TrustedRuntimeIssuer): {
  consentRouter: Router;
  issueRuntimeDecision(envelopeDigest: string): Promise<void>;
  revoke(kind: "consent" | "runtime", id: string): Promise<void>;
} {
  const policy = validateEvidencePolicy(configuration), router = express.Router();
  router.post("/", ...createAuthPipeline(policy.auth), express.raw({ type: "application/json", limit: "32kb", inflate: false }), async (req, res) => {
    const body = exactObject(parseEconomicJson(req.body), ["envelopeDigest"]);
    requireCondition(typeof body.envelopeDigest === "string" && /^[a-f0-9]{64}$/.test(body.envelopeDigest), "Invalid envelope reference.");
    const principal = externalPrincipalFrom(res), claims = req.auth!.payload;
    const expiry = claims.exp, issued = claims.iat;
    requireCondition(typeof expiry === "number" && Number.isSafeInteger(expiry) && typeof issued === "number" && Number.isSafeInteger(issued), "Authentication validity required.");
    const token = req.headers.authorization;
    requireCondition(typeof token === "string" && /^Bearer /i.test(token), "Bearer authentication required.");
    const consentId = await transaction(pool, async client => {
      const envelope = await loadEnvelope(client, body.envelopeDigest as string);
      const identity = (await client.query(`SELECT a.actor_subject FROM external_identities e JOIN accounts a USING(account_id)
        WHERE e.issuer=$1 AND e.subject=$2`, [principal.issuer, principal.providerSubject])).rows[0];
      requireCondition(identity?.actor_subject === envelope.principal.id, "Authenticated subject does not own envelope.");
      await assertActivePrincipal(client, envelope.principal.id);
      const session = await lockEconomicSession(client, { issuer: principal.issuer, subject: principal.providerSubject, providerSession: principal.providerSessionId, principalId: envelope.principal.id });
      const now = await databaseTime(client), validUntil = new Date(Math.min(expiry * 1000, Date.parse(envelope.expiresAt), Date.parse(session.expiresAt))).toISOString();
      requireCondition(now >= envelope.createdAt && now < validUntil && issued * 1000 <= Date.parse(now), "Expired or premature confirmation.");
      const id = randomUUID();
      await client.query(`INSERT INTO economic_consent_evidence(consent_id,envelope_digest,principal_id,issuer,audience,context,provider_subject,authentication_reference,session_reference,authenticated_at,confirmed_at,expires_at,account_session_id)
        VALUES($1,$2,$3,$4,$5,'zephipay-economic-consent-v1',$6,$7,$8,$9,$10,$11,$12)`, [id, body.envelopeDigest, envelope.principal.id, principal.issuer, policy.auth.audience, principal.providerSubject,
        sha256(token.slice(7)), principal.providerSessionId ?? null, new Date(issued * 1000).toISOString(), now, validUntil, session.sessionId]);
      await audit(client, { type: "CONSENT_ACCEPTED", actor: envelope.principal.id, ...envelope.attempt, consentId: id, reference: body.envelopeDigest as string });
      return id;
    });
    res.status(201).json({ consentId });
  });
  router.use(((error, _req, res, _next) => {
    const status = typeof error?.status === "number" && [400,401,403,413,415].includes(error.status) ? error.status : 400;
    res.status(status).json({ error: "ECONOMIC_CONSENT_REJECTED" });
  }) as ErrorRequestHandler);

  return {
    consentRouter: router,
    async issueRuntimeDecision(digest) {
      const envelope = await transaction(pool, client => loadEnvelope(client, digest));
      scopeAllowed(envelope, policy);
      // Only the configured authority is called. The caller supplies no decision body.
      const wire = exactObject(parseEconomicJson(await runtime.evaluate(envelope)), ["issuer", "network", "binding"]);
      requireCondition(wire.issuer === policy.runtimeIssuer && sameNetworkV1(wire.network as never, envelope.amount.asset.network), "Runtime issuer/network mismatch.");
      const binding = exactObject(wire.binding, ["schema", "reference", "envelopeDigest", "result"]);
      const reference = createRuntimePolicyReferenceV1(binding.reference);
      requireCondition(binding.schema === "zephyon.runtime-binding/v1" && binding.result === "approved" && binding.envelopeDigest === digest && JSON.stringify(reference) === JSON.stringify(envelope.runtime), "Runtime decision binding mismatch or not approved.");
      await transaction(pool, async client => {
        const now = await databaseTime(client);
        requireCondition(now >= envelope.createdAt && now < envelope.expiresAt, "Expired Runtime issuance.");
        await assertActivePrincipal(client, envelope.principal.id);
        await qualifyAsset(client, envelope.amount.asset, "PAYMENT", now);
        await qualifyAsset(client, envelope.fee.asset, "FEE", now);
        await client.query(`INSERT INTO economic_runtime_evidence(decision_id,envelope_digest,issuer,policy_version,evidence_digest,binding,network,scope,valid_from,valid_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(decision_id) DO NOTHING`, [reference.decisionId, digest, policy.runtimeIssuer, reference.policyVersion, reference.evidenceDigest, binding, envelope.amount.asset.network, reference.scope, reference.validFrom, reference.validUntil]);
        const row = (await client.query("SELECT * FROM economic_runtime_evidence WHERE decision_id=$1 FOR SHARE", [reference.decisionId])).rows[0];
        requireCondition(!row.revoked_at && row.envelope_digest === digest && row.issuer === policy.runtimeIssuer && JSON.stringify(createRuntimePolicyReferenceV1(row.binding.reference)) === JSON.stringify(reference) && row.binding.result === "approved" && row.binding.envelopeDigest === digest, "Conflicting/revoked Runtime decision.");
        await audit(client, { type: "RUNTIME_ACCEPTED", actor: policy.runtimeIssuer, ...envelope.attempt, runtimeId: reference.decisionId, reference: authorizationBindingDigestV1(envelope, envelope.amount.asset) });
      });
    },
    async revoke(kind, id) {
      const table = kind === "consent" ? "economic_consent_evidence" : "economic_runtime_evidence", key = kind === "consent" ? "consent_id" : "decision_id";
      await transaction(pool, async client => {
        const row = (await client.query(`SELECT * FROM ${table} WHERE ${key}=$1 FOR UPDATE`, [id])).rows[0];
        requireCondition(row, "Evidence not found.");
        if (!row.revoked_at) await client.query(`UPDATE ${table} SET revoked_at=clock_timestamp() WHERE ${key}=$1`, [id]);
        await audit(client, { type: "EVIDENCE_REVOKED", actor: "trusted-evidence-administration", reference: id });
      });
    },
  };
}
