import type { Pool, PoolClient } from "pg";
import type { EconomicAuthorityRole } from "../composition/authorityPrivilegePolicy";
import { assertDeploymentConnection, verifyAuthorityLogin, type DeploymentExpectation } from "../composition/verifyAuthorityLogin";
import { requireCondition, transaction } from "../foundation/database";

/** One credential per service instance. This cannot prove OS/container isolation; deployment attestation must. */
export class AuthorityProcess {
  readonly deployment: DeploymentExpectation;
  constructor(readonly role: EconomicAuthorityRole, private readonly pool: Pool, deployment: DeploymentExpectation) {
    requireCondition(/^[a-f0-9-]{36}$/.test(deployment.deploymentId) && deployment.environment.length > 0 && deployment.databaseName.length > 0 &&
      deployment.login.length > 0 && deployment.schemaOwner.length > 0 && deployment.identityOwner.length > 0 && /^[1-9][0-9]*$/.test(deployment.credentialGeneration), "Explicit deployment identity required.");
    this.deployment = Object.freeze({ ...deployment });
  }
  readiness() { return verifyAuthorityLogin(this.pool, this.role, { deployment: this.deployment }); }
  checkConnection(client: PoolClient) { return assertDeploymentConnection(client, this.role, this.deployment); }
  async run<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.readiness();
    return transaction(this.pool, async client => {
      await this.checkConnection(client);
      const result = await action(client);
      await this.checkConnection(client);
      return result;
    });
  }
}
