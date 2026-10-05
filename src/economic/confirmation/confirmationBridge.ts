import type { PoolClient } from "pg";
import { authorizationBindingDigestV1 } from "zephyon-protocol";
import { databaseTime, requireCondition, sha256 } from "../foundation/database";
import { loadEnvelope } from "../foundation/evidenceIngestion";
import { exactObject, parseEconomicJson } from "../foundation/strictJson";
import { qualifyAsset } from "../foundation/trustedRegistry";
import type { Auth0Authentication, Auth0Reauthentication } from "../readiness/auth0Authentication";
import { ProviderDeploymentReadiness } from "../readiness/providerDeploymentReadiness";
import { ReadinessServiceTransport } from "../readiness/serviceTransport";
import { digest, frozen, type SignedArtifact } from "../readiness/signedArtifact";
import { assertConfirmationPolicy, lockConfirmationPolicy, type VerifiedConfirmationPolicy } from "./confirmationPolicy";

export const confirmationRoutes = ["start", "roundtrip", "confirm", "recover"].map(action =>
  ({ caller: "identity" as const, method: "POST", path: `/confirmation/${action}` }));
type Request = { accountSessionId: string; envelopeDigest: string; authenticationDigest: string;
  requestId?: string; challengeId?: string; transactionId?: string; action?: string; reauthenticationDigest?: string };
type Row = Record<string, any>;
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Unmounted, non-value issuer service. Identity signs the SDK transaction/session and explicit confirmation action.
 * Authentication and callback success alone cannot call the confirm operation. No signer/Runtime/observer port exists.
 */
export class Auth0ConfirmationBridge {
  constructor(private readonly readiness: ProviderDeploymentReadiness, private readonly transport: ReadinessServiceTransport,
    private readonly policy: VerifiedConfirmationPolicy) {
    assertConfirmationPolicy(policy);
    requireCondition(readiness.deployment.process.role === "issuer" && transport.role === "issuer" &&
      transport.configuration === readiness.deployment.configuration && policy.policy.configuration === transport.configuration.fingerprint,
      "Confirmation issuer/configuration mismatch.");
  }

  async execute(path: string, body: string, invocation: SignedArtifact, endpoint: SignedArtifact, endpointNonce: string,
    authentication: Auth0Authentication, reauthentication?: Auth0Reauthentication, proofId?: string): Promise<{ body: string; signature: SignedArtifact }> {
    requireCondition(confirmationRoutes.some(r => r.path === path), "Unknown confirmation action.");
    const verifiedRequest = await this.transport.receive(invocation, "POST", path, body);
    requireCondition(verifiedRequest.caller === "identity", "Canonical identity caller required.");
    const input = parseEconomicJson(Buffer.from(body)) as Request;
    const start = path === "/confirmation/start", confirm = path === "/confirmation/confirm", recover = path === "/confirmation/recover";
    exactObject(input, ["accountSessionId", "envelopeDigest", "authenticationDigest", ...(start ? ["requestId"] : ["challengeId", "transactionId"]),
      ...(confirm ? ["action", "reauthenticationDigest"] : [])]);
    requireCondition(uuid(input.accountSessionId) && digest(input.envelopeDigest) && digest(input.authenticationDigest) &&
      (start ? uuid(input.requestId) : uuid(input.challengeId) && uuid(input.transactionId)), "Invalid confirmation reference.");
    const result = await this.readiness.run(endpoint, endpointNonce, authentication, async client => {
      requireCondition(input.authenticationDigest === authentication.tokenDigest && authentication.scopes.includes(this.policy.policy.requiredScope),
        "Authentication/request scope mismatch.");
      // Stable lock order shared with attempt admission: intent -> account -> session -> policy -> provider revision.
      const envelope = await loadEnvelope(client, input.envelopeDigest);
      requireCondition(authorizationBindingDigestV1(envelope, envelope.amount.asset) === input.envelopeDigest, "Corrupt immutable envelope.");
      const head = (await client.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE", [envelope.attempt.intentId])).rows[0];
      const canonical = await this.lockCanonical(client, input.accountSessionId, authentication);
      requireCondition(envelope.principal.id === canonical.account.actor_subject && head?.principal_id === canonical.account.actor_subject,
        "Envelope ownership mismatch.");
      let challenge: Row | undefined;
      if (!start) {
        challenge = (await client.query("SELECT * FROM economic_confirmation_challenges WHERE challenge_id=$1", [input.challengeId])).rows[0];
        requireCondition(challenge && challenge.account_session_id === input.accountSessionId && challenge.account_id === canonical.account.account_id &&
          challenge.envelope_digest === input.envelopeDigest && challenge.transaction_id === input.transactionId && challenge.provider_subject === authentication.subject &&
          challenge.issuer === authentication.issuer && challenge.environment === authentication.environment, "Challenge/transaction/session mismatch.");
        // Historical recovery is a read, not a new grant: do not reinterpret old policy or consume again.
        if (recover) return this.summary(client, challenge.challenge_id);
      }
      await lockConfirmationPolicy(client, this.policy);
      const deployment = (await client.query("SELECT * FROM economic_deployment_identity WHERE singleton FOR SHARE")).rows[0];
      requireCondition(String(deployment?.provider_key_revision) === String(authentication.keyRevision), "Retired provider revision.");
      const attempt = (await client.query("SELECT state FROM economic_attempts WHERE envelope_digest=$1", [input.envelopeDigest])).rows[0];
      const now = Date.parse(await databaseTime(client))/1000;
      requireCondition(head.current_generation === envelope.attempt.generation && attempt?.state === "OPEN" &&
        Date.parse(envelope.createdAt)/1000 <= now && Date.parse(envelope.expiresAt)/1000 > now &&
        envelope.amount.asset.network.environment === "devnet", "Ineligible, replaced or terminal non-value envelope.");
      await qualifyAsset(client, envelope.amount.asset, "PAYMENT", iso(now));
      await qualifyAsset(client, envelope.fee.asset, "FEE", iso(now));
      if (start) {
        const existing = (await client.query("SELECT * FROM economic_confirmation_challenges WHERE account_session_id=$1 AND request_id=$2",
          [input.accountSessionId, input.requestId])).rows[0];
        if (existing) {
          requireCondition(existing.envelope_digest === input.envelopeDigest, "Creation request already bound to another envelope.");
          return this.summary(client, existing.challenge_id); // Creation retry never mints another challenge or extends expiry.
        }
        const issued = await client.query("SELECT economic_issue_confirmation($1,$2,$3,$4) AS id", [input.requestId,input.accountSessionId,input.envelopeDigest,
          {subject:authentication.subject,issuer:authentication.issuer,configuration:authentication.configuration,providerRevision:authentication.keyRevision,
            digest:authentication.tokenDigest,issuedAt:authentication.issuedAt,expiresAt:authentication.expiresAt,scope:this.policy.policy.requiredScope}]);
        return this.summary(client,issued.rows[0].id);
      }
      requireCondition(challenge, "Missing challenge.");
      requireCondition(challenge.account_version === canonical.account.version && challenge.configuration === this.transport.configuration.fingerprint &&
        String(challenge.configuration_revision) === String(this.transport.configuration.profile.revision) && challenge.policy_fingerprint === this.policy.fingerprint &&
        String(challenge.policy_revision) === String(this.policy.policy.revision) && String(challenge.provider_revision) === String(authentication.keyRevision),
        "Stale account, configuration or policy revision.");
      requireCondition(challenge.expires_at.getTime()/1000 > now && !(await client.query("SELECT 1 FROM economic_confirmation_consumptions WHERE challenge_id=$1",
        [challenge.challenge_id])).rowCount, "Challenge expired or already consumed.");
      if (!confirm) return { challengeId: challenge.challenge_id, transactionId: challenge.transaction_id, reauthentication: challenge.reauthentication };
      requireCondition(input.action === "confirm-economic-intent" && reauthentication && digest(input.reauthenticationDigest), "Explicit exact-intent confirmation required.");
      const metadata = await this.readiness.authentication.assertReauthentication(reauthentication, challenge.reauthentication, now);
      requireCondition(metadata.tokenDigest === input.reauthenticationDigest, "Provider callback substitution.");
      requireCondition(uuid(proofId), "Identity-verifier proof reference required.");
      await client.query("SELECT economic_admit_confirmation($1,$2,$3,$4,$5,$6)",
        [challenge.challenge_id,proofId,input.accountSessionId,input.envelopeDigest,input.transactionId,sha256(body)]);
      // Service rechecks may reject before commit. The DB invariant is admission-time eligibility, not physical commit time.
      await this.readiness.authentication.assertReauthentication(reauthentication,challenge.reauthentication,Date.parse(await databaseTime(client))/1000);
      return this.summary(client, challenge.challenge_id);
    });
    const responseBody = JSON.stringify(result);
    return { body: responseBody, signature: this.transport.respond(verifiedRequest, responseBody) };
  }

  private async lockCanonical(client: PoolClient, sessionId: string, authentication: Auth0Authentication) {
    const identity = (await client.query("SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2",
      [authentication.issuer, authentication.subject])).rows[0];
    requireCondition(identity, "Unknown issuer/subject identity.");
    const account = (await client.query("SELECT * FROM accounts WHERE account_id=$1 FOR SHARE", [identity.account_id])).rows[0];
    const session = (await client.query("SELECT * FROM account_sessions WHERE session_id=$1 FOR SHARE", [sessionId])).rows[0];
    const now = Date.parse(await databaseTime(client))/1000;
    requireCondition(account?.status === "ACTIVE" && session?.account_id === account.account_id && !session.revoked_at &&
      session.created_at.getTime()/1000 <= now && session.expires_at.getTime()/1000 > now &&
      authentication.issuedAt >= session.created_at.getTime()/1000 && authentication.issuedAt <= now && authentication.expiresAt > now,
      "Canonical session/account or authentication invalid.");
    return { account, session };
  }
  private async summary(client: PoolClient, challengeId: string): Promise<Row> {
    const row = (await client.query("SELECT * FROM economic_confirmation_summary WHERE challenge_id=$1", [challengeId])).rows[0];
    requireCondition(row, "Unknown challenge.");
    // Creation recovery must include the same transaction reference, without exposing nonce/provider artifacts.
    const ref = (await client.query("SELECT transaction_id FROM economic_confirmation_challenges WHERE challenge_id=$1", [challengeId])).rows[0];
    return frozen({ ...row, transaction_id:ref.transaction_id });
  }
}
