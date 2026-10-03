import type { Pool, PoolClient } from "pg";
import { audit, databaseTime, requireCondition, transaction } from "./database";

/** Trusted identity/session service binds a verified provider session to an EXISTING canonical account session. */
export class EconomicSessionAdministration {
  constructor(private readonly pool: Pool) {}
  async bind(input: { issuer: string; providerSubject: string; providerSessionReference: string; accountSessionId: string }): Promise<void> {
    for (const value of [input.issuer,input.providerSubject,input.providerSessionReference]) requireCondition(typeof value === "string" && value.length > 0 && value.length <= 512, "Invalid provider session binding.");
    await transaction(this.pool, async client => {
      const identity = (await client.query("SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2",[input.issuer,input.providerSubject])).rows[0];
      requireCondition(identity,"Unknown authenticated identity.");
      const account = (await client.query("SELECT actor_subject,status FROM accounts WHERE account_id=$1 FOR SHARE",[identity.account_id])).rows[0];
      const session = (await client.query("SELECT * FROM account_sessions WHERE session_id=$1 FOR SHARE",[input.accountSessionId])).rows[0];
      const now = await databaseTime(client);
      requireCondition(account.status === "ACTIVE" && session?.account_id === identity.account_id && !session.revoked_at && session.created_at.toISOString() <= now && session.expires_at.toISOString() > now,"Session is invalid, expired or revoked.");
      const inserted = await client.query(`INSERT INTO economic_session_bindings(issuer,provider_subject,provider_session_reference,account_session_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(issuer,provider_subject,provider_session_reference) DO NOTHING RETURNING account_session_id`,[input.issuer,input.providerSubject,input.providerSessionReference,input.accountSessionId]);
      const row = (await client.query("SELECT account_session_id FROM economic_session_bindings WHERE issuer=$1 AND provider_subject=$2 AND provider_session_reference=$3",[input.issuer,input.providerSubject,input.providerSessionReference])).rows[0];
      requireCondition(row.account_session_id === input.accountSessionId,"Provider session cannot be rebound or revived.");
      if (inserted.rowCount) await audit(client,{type:"ACCOUNT_SESSION_BOUND",actor:"trusted-identity-session-service",reference:input.accountSessionId});
    });
  }
}

/** Call after locking the canonical account. Revocation uses the same account -> session lock order. */
export async function lockEconomicSession(client: PoolClient, input: {
  issuer: string; subject: string; providerSession?: string; principalId: string; requiredSessionId?: string | null; authenticatedAt?: string;
}): Promise<{ sessionId: string; expiresAt: string }> {
  requireCondition(input.providerSession,"Authoritative provider session reference required.");
  const binding = (await client.query("SELECT account_session_id FROM economic_session_bindings WHERE issuer=$1 AND provider_subject=$2 AND provider_session_reference=$3",[input.issuer,input.subject,input.providerSession])).rows[0];
  requireCondition(binding && (input.requiredSessionId === undefined || input.requiredSessionId === binding.account_session_id),"Missing or mismatched canonical session binding.");
  const s = (await client.query("SELECT * FROM account_sessions WHERE session_id=$1 FOR SHARE",[binding.account_session_id])).rows[0];
  const now = await databaseTime(client);
  requireCondition(s && `zp:account:${s.account_id}` === input.principalId && !s.revoked_at && s.created_at.toISOString() <= now && s.expires_at.toISOString() > now,"Authoritative session expired, revoked or invalid.");
  if (input.authenticatedAt !== undefined) requireCondition(Number.isFinite(Date.parse(input.authenticatedAt)) && s.created_at.toISOString() <= input.authenticatedAt && input.authenticatedAt <= now,"Authentication predates canonical session or is in the future.");
  return {sessionId:s.session_id,expiresAt:s.expires_at.toISOString()};
}
