import type { PoolClient } from "pg";
import { requireCondition } from "../foundation/database";
import type { Auth0Authentication, Auth0AuthenticationVerifier } from "./auth0Authentication";
import { DeploymentReadiness } from "./deploymentProfile";
import type { SignedArtifact } from "./signedArtifact";

/** Combines authenticated external endpoint/configuration identity with actual LOGIN and durable key revision. No mounted routes. */
export class ProviderDeploymentReadiness {
  constructor(readonly deployment: DeploymentReadiness, readonly authentication: Auth0AuthenticationVerifier) {
    requireCondition(deployment.configuration === authentication.snapshots.configuration && ["identity","issuer","app"].includes(deployment.process.role), "Identity/issuer/preparation app provider deployment required.");
  }
  private async check(client: PoolClient): Promise<void> {
    const snapshot = await this.authentication.snapshots.current();
    const row = (await client.query("SELECT provider_key_revision FROM economic_deployment_identity WHERE singleton")).rows[0];
    requireCondition(row && String(row.provider_key_revision) === String(snapshot.provenance.revision), "Durable provider revision mismatch.");
    await this.authentication.snapshots.assertCurrent(snapshot);
  }
  async readiness(endpoint: SignedArtifact, nonce: string): Promise<void> {
    await this.deployment.run(endpoint, nonce, client => this.check(client));
  }
  async run<T>(endpoint: SignedArtifact, nonce: string, proof: Auth0Authentication, action: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.deployment.run(endpoint, nonce, async client => {
      await this.check(client); await this.authentication.assertCurrent(proof);
      const result = await action(client);
      await this.check(client); await this.authentication.assertCurrent(proof);
      return result;
    });
  }
}
