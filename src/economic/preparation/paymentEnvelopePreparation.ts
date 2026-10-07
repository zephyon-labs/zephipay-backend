import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createEconomicIntentEnvelopeV1, authorizationBindingDigestV1, type AssetIdentityV1, type EconomicIntentEnvelopeV1 } from "zephyon-protocol";
import { normalizeCurrentDevnetIntentV1 } from "../devnetCompatibility";
import type { CanonicalDevnetPreparationPolicy } from "../../devnet/devnetPreparationPolicy";
import type { PaymentRecord } from "../../payments/paymentTypes";
import { databaseTime, requireCondition } from "../foundation/database";
import { lockEconomicSession } from "../foundation/sessionAuthority";
import { qualifyAsset } from "../foundation/trustedRegistry";
import type { Auth0Authentication } from "../readiness/auth0Authentication";
import { ProviderDeploymentReadiness } from "../readiness/providerDeploymentReadiness";
import type { SignedArtifact } from "../readiness/signedArtifact";

/** Administrative TEST inventory metadata. Never accepted from an HTTP payment request.
 * Runtime reference metadata is allocated before consent; it is NOT an approval.
 */
export type PaymentPreparationProfile = Readonly<{
  mode: "controlled-non-value"; attestation: "TEST";
  asset: AssetIdentityV1; devnetPolicy: CanonicalDevnetPreparationPolicy;
  fee: EconomicIntentEnvelopeV1["fee"];
  runtime: Omit<EconomicIntentEnvelopeV1["runtime"], "decisionId">;
  lifetimeSeconds: number;
}>;
export type PreparedPayment = Readonly<{
  paymentId: string; accountSessionId: string; envelopeDigest: string; envelope: EconomicIntentEnvelopeV1;
}>;
const intentId = (id: string) => `zephipay:payment:${id}`;

/** Runs only under the existing authenticated app readiness boundary. Browser input is payment ID only.
 * The provider-session reference is supplied by trusted SDK server composition, never a request body.
 * No Runtime, chain, blockhash, transaction, signer, or submission port exists here.
 */
export class PaymentEnvelopePreparation {
  constructor(private readonly readiness: ProviderDeploymentReadiness) {
    requireCondition(readiness.deployment.process.role === "app", "Preparation application authority required.");
  }
  prepare(paymentId: string, authentication: Auth0Authentication, providerSessionReference: string,
    endpoint: SignedArtifact, endpointNonce: string): Promise<PreparedPayment> {
    requireCondition(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(paymentId), "Invalid payment reference.");
    return this.readiness.run(endpoint, endpointNonce, authentication,
      client => this.prepareInTransaction(client, paymentId, authentication, providerSessionReference));
  }
  private async prepareInTransaction(client: PoolClient, paymentId: string, auth: Auth0Authentication, providerSession: string): Promise<PreparedPayment> {
    const identity = (await client.query(`SELECT a.* FROM accounts a JOIN external_identities e USING(account_id)
      WHERE e.issuer=$1 AND e.subject=$2`, [auth.issuer,auth.subject])).rows[0];
    requireCondition(identity, "Unknown payment identity.");
    // Deterministic intent namespace and the existing head serialize initial creation and retries.
    await client.query(`INSERT INTO economic_attempt_heads(intent_id,principal_id,current_generation) VALUES($1,$2,1)
      ON CONFLICT(intent_id) DO NOTHING`, [intentId(paymentId),identity.actor_subject]);
    const head = (await client.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE", [intentId(paymentId)])).rows[0];
    const p = (await client.query("SELECT p.*,economic_payment_snapshot(p) AS snapshot FROM payments p WHERE id=$1 FOR UPDATE", [paymentId])).rows[0];
    requireCondition(p && p.actor_subject === identity.actor_subject && head.principal_id === identity.actor_subject && head.current_generation === "1",
      "Payment ownership or generation mismatch.");
    const account = (await client.query("SELECT * FROM accounts WHERE account_id=$1 FOR SHARE", [identity.account_id])).rows[0];
    requireCondition(account.status === "ACTIVE", "Inactive payment account.");
    const session = await lockEconomicSession(client, {issuer:auth.issuer,subject:auth.subject,providerSession,principalId:account.actor_subject,
      authenticatedAt:new Date(auth.issuedAt*1000).toISOString()});
    const old = (await client.query(`SELECT b.*,e.envelope FROM economic_payment_preparations b JOIN economic_envelopes e USING(envelope_digest)
      WHERE payment_id=$1`, [paymentId])).rows[0];
    if (old) {
      requireCondition(old.account_session_id === session.sessionId && JSON.stringify(old.payment_snapshot) === JSON.stringify(p.snapshot),
        "Prepared payment/session conflict.");
      const envelope = createEconomicIntentEnvelopeV1(old.envelope,old.envelope.amount.asset);
      requireCondition(authorizationBindingDigestV1(envelope,envelope.amount.asset) === old.envelope_digest, "Corrupt prepared envelope.");
      // Recovery returns the exact historical binding, including its original expiry, never a renewed envelope.
      return Object.freeze({paymentId,accountSessionId:session.sessionId,envelopeDigest:old.envelope_digest,envelope});
    }
    requireCondition(p.status === "AWAITING_CONFIRMATION" && p.version === "0" && !p.user_confirmed_at && !p.execution_started_at && !p.recent_blockhash,
      "Payment no longer eligible for non-value preparation.");
    const profile: PaymentPreparationProfile | undefined = (await client.query(
      "SELECT profile FROM economic_payment_preparation_profiles WHERE principal_id=$1", [account.actor_subject])).rows[0]?.profile;
    requireCondition(profile?.mode === "controlled-non-value" && profile.attestation === "TEST" &&
      Number.isInteger(profile.lifetimeSeconds) && profile.lifetimeSeconds > 0 && profile.lifetimeSeconds <= 600,
      "Explicit bounded TEST preparation profile required.");
    const now = await databaseTime(client);
    await qualifyAsset(client,profile.asset,"PAYMENT",now);
    await qualifyAsset(client,profile.fee.asset,"FEE",now);
    // Reuse the accepted current-Devnet adapter: no fabricated external-wallet ownership or verified beneficiary.
    const payment = {id:p.id,actorSubject:p.actor_subject,version:BigInt(p.version),requestHash:Buffer.from(p.request_hash).toString("hex"),
      network:p.network,rail:p.rail,asset:p.asset,mintAddress:p.mint_address,recipientAddress:p.recipient_address,
      recipientType:p.recipient_type,amountRaw:BigInt(p.amount_raw)} as PaymentRecord;
    const projection = normalizeCurrentDevnetIntentV1(payment,profile.devnetPolicy,profile.asset);
    requireCondition(profile.fee.mode === "devnet-server" && profile.fee.signer === projection.feeAuthority.signer &&
      profile.fee.keyVersion === projection.feeAuthority.keyVersion && profile.runtime.scope === "devnet-test-only", "TEST authority profile mismatch.");
    const expiresAt = new Date(Math.min(Date.parse(now)+profile.lifetimeSeconds*1000,Date.parse(session.expiresAt),
      auth.expiresAt*1000,Date.parse(profile.runtime.validUntil))).toISOString();
    const envelope = createEconomicIntentEnvelopeV1({schema:"zephyon.economic-intent/v1",principal:{id:account.actor_subject},
      attempt:{intentId:head.intent_id,intentVersion:(BigInt(p.version)+1n).toString(),attemptId:randomUUID(),generation:"1",fenceToken:randomUUID()},
      nonce:randomBytes(32).toString("hex"),createdAt:now,expiresAt,
      source:{mode:"devnet-server",signer:projection.sourceAuthority.signer,account:projection.sourceAuthority.account,
        bindingId:projection.sourceAuthority.keyId,bindingVersion:"1"},
      recipient:{id:`payment:${paymentId}:recipient`,snapshotVersion:"1",beneficiaryId:`payment:${paymentId}:beneficiary`,
        destinationBindingId:`payment:${paymentId}:destination`,destinationVersion:"1",verification:"devnet-unverified",
        wallet:projection.recipient.wallet,account:projection.recipient.tokenAccount},
      amount:projection.amount,fee:profile.fee,purpose:{kind:"p2p",reference:paymentId},runtime:{...profile.runtime,decisionId:randomUUID()}},profile.asset);
    const envelopeDigest = authorizationBindingDigestV1(envelope,profile.asset);
    await client.query("INSERT INTO economic_envelopes(intent_id,generation,attempt_id,fence_token,envelope_digest,envelope) VALUES($1,$2,$3,$4,$5,$6)",
      [head.intent_id,"1",envelope.attempt.attemptId,envelope.attempt.fenceToken,envelopeDigest,envelope]);
    await client.query(`INSERT INTO economic_payment_preparations(payment_id,account_session_id,envelope_digest,payment_snapshot) VALUES($1,$2,$3,$4)`,
      [paymentId,session.sessionId,envelopeDigest,p.snapshot]);
    return Object.freeze({paymentId,accountSessionId:session.sessionId,envelopeDigest,envelope});
  }
}
