import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createAccountSessionInTransaction, revokeAccountSessionInTransaction } from "../../storage/postgres/postgresIdentityPersistence";
import { bindEconomicSession, lockEconomicSession } from "../foundation/sessionAuthority";
import { databaseTime, requireCondition } from "../foundation/database";
import { AuthorityProcess } from "./authorityProcess";
import { ProviderTokenVerifier, type VerifiedProviderToken } from "./providerTokenVerifier";

export async function lockProviderAccount(client: PoolClient, proof: VerifiedProviderToken, expectedVersion: string, accountId?: string, exclusive = true) {
  requireCondition(/^(0|[1-9][0-9]*)$/.test(expectedVersion), "Canonical account version required.");
  const row = (await client.query(`SELECT a.* FROM external_identities e JOIN accounts a USING(account_id)
    WHERE e.issuer=$1 AND e.subject=$2 FOR ${exclusive ? "UPDATE" : "SHARE"} OF a`, [proof.issuer, proof.subject])).rows[0];
  requireCondition(row?.status === "ACTIVE" && String(row.version) === expectedVersion && (accountId === undefined || row.account_id === accountId), "Canonical account or version mismatch.");
  return row;
}

export async function consumeProviderToken(client: PoolClient, verifier: ProviderTokenVerifier, proof: VerifiedProviderToken, sessionId: string, version: string, reference: string): Promise<void> {
  await checkProviderRevision(client, verifier);
  verifier.assertCurrent(proof, Date.parse(await databaseTime(client)));
  const row = await client.query(`INSERT INTO economic_provider_token_uses(token_id,token_digest,account_session_id,account_version,action,resource_reference,issued_at,authentication_time,key_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(token_id) DO NOTHING RETURNING token_id`,
  [proof.tokenId, proof.tokenDigest, sessionId, version, proof.action, reference, new Date(proof.issuedAt * 1000).toISOString(),
    proof.authenticationTime === undefined ? null : new Date(proof.authenticationTime * 1000).toISOString(), proof.keyRevision]);
  requireCondition(row.rowCount === 1, "PROVIDER_TOKEN_REPLAY_REJECTED");
  await checkProviderRevision(client, verifier);
  verifier.assertCurrent(proof, Date.parse(await databaseTime(client)));
}

async function checkProviderRevision(client: PoolClient, verifier: ProviderTokenVerifier): Promise<void> {
  const row = (await client.query("SELECT provider_key_revision FROM economic_deployment_identity WHERE singleton")).rows[0];
  requireCondition(row && String(row.provider_key_revision) === String(verifier.keyRevision), "Provider key snapshot is not current for this deployment.");
}

/** Unmounted identity-service seam. Raw signed tokens only; canonical lifecycle/CAS is shared with the existing repository. */
export class ProviderSessionAuthority {
  constructor(private readonly process: AuthorityProcess, private readonly verifier: ProviderTokenVerifier, private readonly sessionLifetimeSeconds: number) {
    requireCondition(process.role === "identity" && process.deployment.environment === verifier.contract.environment, "Identity process/environment required.");
    requireCondition(Number.isSafeInteger(sessionLifetimeSeconds) && sessionLifetimeSeconds > 0, "Explicit canonical session lifetime required.");
  }

  readiness() { return this.process.run(client => checkProviderRevision(client, this.verifier)); }

  async create(rawToken: string, expectedAccountVersion: string) {
    const proof = await this.verifier.verify(rawToken, "create-session");
    return this.process.run(async client => {
      const account = await lockProviderAccount(client, proof, expectedAccountVersion);
      const now = await databaseTime(client);
      this.verifier.assertCurrent(proof, Date.parse(now));
      const result = await createAccountSessionInTransaction(client, { accountId: account.account_id, expectedAccountVersion: BigInt(expectedAccountVersion),
        sessionId: randomUUID(), createdAt: now, expiresAt: new Date(Date.parse(now) + this.sessionLifetimeSeconds * 1000).toISOString() });
      await consumeProviderToken(client, this.verifier, proof, result.session.sessionId, result.account.version.toString(), result.session.sessionId);
      // This bootstrap token normally predates the new session; a newly issued token is required for binding and consent.
      return result;
    });
  }

  async bind(rawToken: string, accountSessionId: string, expectedAccountVersion: string): Promise<void> {
    const proof = await this.verifier.verify(rawToken, "bind-session");
    await this.process.run(async client => {
      const account = await lockProviderAccount(client, proof, expectedAccountVersion);
      const session = (await client.query("SELECT * FROM account_sessions WHERE session_id=$1 FOR SHARE", [accountSessionId])).rows[0];
      requireCondition(session?.account_id === account.account_id && session.created_at.getTime() <= proof.issuedAt * 1000, "Token predates canonical session or account mismatch.");
      await bindEconomicSession(client, { issuer: proof.issuer, providerSubject: proof.subject, providerSessionReference: proof.session, accountSessionId });
      await consumeProviderToken(client, this.verifier, proof, accountSessionId, expectedAccountVersion, accountSessionId);
    });
  }

  async revoke(rawToken: string, accountSessionId: string, expectedAccountVersion: string) {
    const proof = await this.verifier.verify(rawToken, "revoke-session");
    return this.process.run(async client => {
      const account = await lockProviderAccount(client, proof, expectedAccountVersion);
      await lockEconomicSession(client, { issuer: proof.issuer, subject: proof.subject, providerSession: proof.session, principalId: account.actor_subject,
        requiredSessionId: accountSessionId, authenticatedAt: new Date(proof.issuedAt * 1000).toISOString() });
      await consumeProviderToken(client, this.verifier, proof, accountSessionId, expectedAccountVersion, accountSessionId);
      return revokeAccountSessionInTransaction(client, { accountId: account.account_id, sessionId: accountSessionId, expectedAccountVersion: BigInt(expectedAccountVersion) });
    });
  }
}

/** Issuer owns one DB credential and public verification keys. It never receives the identity credential. */
export class ProviderConsentGate {
  constructor(private readonly process: AuthorityProcess, readonly verifier: ProviderTokenVerifier) {
    requireCondition(process.role === "issuer" && process.deployment.environment === verifier.contract.environment, "Issuer process/environment required.");
  }
  readiness() { return this.process.run(client => checkProviderRevision(client, this.verifier)); }
  verify(rawToken: string) { return this.verifier.verify(rawToken, "consent"); }
  async consume(client: PoolClient, proof: VerifiedProviderToken, input: { accountVersion: string; principalId: string; sessionId: string; envelopeDigest: string }): Promise<void> {
    await this.process.checkConnection(client);
    await lockProviderAccount(client, proof, input.accountVersion, input.principalId.replace(/^zp:account:/, ""), false);
    await consumeProviderToken(client, this.verifier, proof, input.sessionId, input.accountVersion, input.envelopeDigest);
    await this.process.checkConnection(client);
  }
}
