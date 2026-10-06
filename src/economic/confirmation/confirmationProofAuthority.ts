import { requireCondition, sha256, databaseTime } from "../foundation/database";
import { exactObject, parseEconomicJson } from "../foundation/strictJson";
import type { Auth0Authentication, Auth0Reauthentication, ReauthenticationChallenge } from "../readiness/auth0Authentication";
import { ProviderDeploymentReadiness } from "../readiness/providerDeploymentReadiness";
import type { SignedArtifact } from "../readiness/signedArtifact";
import { assertConfirmationPolicy, type VerifiedConfirmationPolicy } from "./confirmationPolicy";

/** Separate identity credential: attests accepted provider proofs, but cannot issue/consume challenges or insert consent.
 * This is the existing trusted identity-service compartment, not a browser or generic SQL evidence endpoint.
 */
export class ConfirmationProofAuthority {
  constructor(private readonly readiness: ProviderDeploymentReadiness, private readonly policy: VerifiedConfirmationPolicy) {
    assertConfirmationPolicy(policy);
    requireCondition(readiness.deployment.process.role === "identity" && readiness.deployment.configuration.fingerprint === policy.policy.configuration,
      "Separate identity proof authority required.");
  }
  async record(challengeId: string, challenge: ReauthenticationChallenge, confirmationBody: string, authentication: Auth0Authentication,
    reauthentication: Auth0Reauthentication, endpoint: SignedArtifact, endpointNonce: string): Promise<string> {
    const body = parseEconomicJson(Buffer.from(confirmationBody)) as Record<string,unknown>;
    exactObject(body,["accountSessionId","envelopeDigest","authenticationDigest","challengeId","transactionId","action","reauthenticationDigest"]);
    return this.readiness.run(endpoint,endpointNonce,authentication,async client => {
      const now=Date.parse(await databaseTime(client))/1000;
      const metadata=await this.readiness.authentication.assertReauthentication(reauthentication,challenge,now);
      requireCondition(body.challengeId===challengeId && body.accountSessionId===challenge.accountSessionId && body.envelopeDigest===challenge.envelopeDigest &&
        body.action===challenge.action && body.authenticationDigest===authentication.tokenDigest && body.reauthenticationDigest===metadata.tokenDigest &&
        authentication.subject===challenge.subject && authentication.scopes.includes(this.policy.policy.requiredScope),"Exact confirmation proof request required.");
      if (metadata.sdkBindingId) {
        const binding=(await client.query("SELECT economic_read_confirmation_sdk($1,$2) AS binding",[metadata.sdkBindingId,authentication])).rows[0].binding;
        requireCondition(binding.challenge_id===challengeId && binding.callback?.token_digest===metadata.tokenDigest,
          "Durable SDK callback required for bound proof.");
        if (binding.proof) {
          requireCondition(binding.proof.request_digest===sha256(confirmationBody) && binding.proof.authentication_digest===authentication.tokenDigest,
            "SDK proof retry must preserve the exact confirmation request.");
          await this.readiness.authentication.assertReauthentication(reauthentication,challenge,Date.parse(await databaseTime(client))/1000);
          return binding.proof.proof_id as string;
        }
      }
      const evidence={authenticationDigest:authentication.tokenDigest,authenticationIssuedAt:authentication.issuedAt,authenticationExpiresAt:authentication.expiresAt,
        providerEvidence:metadata.tokenDigest,issuedAt:metadata.issuedAt,expiresAt:metadata.expiresAt,authTime:reauthentication.authenticationTime,
        assurance:reauthentication.acr,nonce:challenge.nonce,subject:authentication.subject,issuer:authentication.issuer,configuration:authentication.configuration,
        providerRevision:authentication.keyRevision,requestDigest:sha256(confirmationBody),accountSessionId:challenge.accountSessionId,envelopeDigest:challenge.envelopeDigest,
        transactionId:body.transactionId,action:challenge.action,policyFingerprint:this.policy.fingerprint,scope:this.policy.policy.requiredScope};
      const result=await client.query("SELECT economic_record_confirmation_proof($1,$2) AS id",[challengeId,evidence]);
      await this.readiness.authentication.assertReauthentication(reauthentication,challenge,Date.parse(await databaseTime(client))/1000);
      return result.rows[0].id;
    });
  }
}
