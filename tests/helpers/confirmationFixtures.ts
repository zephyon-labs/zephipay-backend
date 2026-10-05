import { sha256 } from "../../src/economic/foundation/database";
import { loadConfirmationPolicy, type ConfirmationPolicy } from "../../src/economic/confirmation/confirmationPolicy";
import type { VerifiedDeployment } from "../../src/economic/readiness/deploymentProfile";
import { configurationKeys, signedFixture } from "./realProviderFixtures";

export function confirmationPolicyFixture(configuration: VerifiedDeployment, changes: Partial<ConfirmationPolicy> = {}) {
  const p = configuration.profile, now = Math.floor(Date.now()/1000);
  const value: ConfirmationPolicy = { type:"zephipay-confirmation-policy-v1", mode:"non-value", deploymentId:p.deploymentId, environment:p.environment,
    configuration:configuration.fingerprint, revision:1, issuer:p.issuer, audience:p.audience, clientId:p.clientId, dialect:"auth0", algorithm:"RS256",
    flow:"authorization-code-pkce", attestation:"TEST", operator:"offline-test-operator", reference:"TEST:confirmation-fixture",
    allowedConnections:["TEST:database-connection"], refreshPolicy:"disabled", reauthentication:"TEST", issuedAt:now-1, expiresAt:now+600,
    requiredScope:"confirm:economic", challengeSeconds:120, maxAuthenticationAgeSeconds:60, consentSeconds:60, acceptedAcr:["fixture:mfa"], ...changes };
  const artifact = signedFixture(value);
  return loadConfirmationPolicy(artifact, configurationKeys.publicKey, configuration, sha256(artifact.payload));
}
