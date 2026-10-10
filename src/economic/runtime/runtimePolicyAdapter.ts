import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { authorizationBindingDigestV1, createRuntimeEvidenceAuthorityV1, createRuntimeEvidenceSetV1, RuntimePolicyEvaluatorV1,
  type EconomicIntentEnvelopeV1, type RuntimeEvidenceV1, type RuntimePolicyContextV1, type RuntimePolicyDecisionV1 } from "zephyon-protocol";
import { databaseTime, requireCondition, sha256 } from "../foundation/database";
import { loadEnvelope } from "../foundation/evidenceIngestion";
import { qualifyAsset } from "../foundation/trustedRegistry";
import type { Auth0Authentication } from "../readiness/auth0Authentication";
import { ProviderDeploymentReadiness } from "../readiness/providerDeploymentReadiness";
import { frozen, type SignedArtifact } from "../readiness/signedArtifact";
import { loadRuntimeTestProfile, runtimeSources } from "./runtimeTestProfile";
import { runtimeRequest, type RuntimeRequest } from "./runtimeRequest";
import { exactObject } from "../foundation/strictJson";
import { controlledRuntimeResult, type ControlledRuntimeAction, type ControlledRuntimeResult } from "./controlledRuntimeResult";

export type NonValueRuntimeResult = Readonly<{
  mode:"non-value"; decision:RuntimePolicyDecisionV1; currentApproval:boolean; executionAuthorized:false;
}>;
type Row = Record<string,any>;
const authorityId="zephipay:postgres-runtime-evidence:v1";
// Hash storage evidence, never canonicalize or reconstruct payment economics here.
const snapshotDigest=(value:unknown)=>sha256(JSON.stringify(value));

/** Trusted server composition only; no mounted HTTP endpoint or execution/legacy Runtime port.
 * The provider-session reference comes from the accepted SDK server session, as in preparation.
 * Even in-process callers supply only references: all facts and evaluation time are loaded here.
 */
export class RuntimePolicyAdapter {
  constructor(private readonly readiness: ProviderDeploymentReadiness) {
    requireCondition(readiness.deployment.process.role==="issuer","Runtime issuer authority required.");
  }
  /** Private controlled product seam. Identity loads challengeId from the immutable web ceremony;
   * the browser supplies paymentId only. All remaining references and facts are issuer-owned.
   * Recovery never calls the evaluator when the ledger has no decision.
   */
  async controlled(action:ControlledRuntimeAction, reference:{paymentId:string;challengeId:string}, authentication:Auth0Authentication,
    providerSessionReference:string, endpoint:SignedArtifact, endpointNonce:string):Promise<ControlledRuntimeResult> {
    exactObject(reference,["paymentId","challengeId"]);
    const uuid=(v:unknown)=>typeof v==="string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
    requireCondition(["runtime-evaluate","runtime-recover"].includes(action) && uuid(reference.paymentId) && uuid(reference.challengeId) &&
      Reflect.ownKeys(reference).length===2 && Object.values(Object.getOwnPropertyDescriptors(reference)).every(d=>"value" in d) &&
      typeof providerSessionReference==="string" && providerSessionReference.length>0 && providerSessionReference.length<=512,"Invalid controlled Runtime reference.");
    const load=()=>this.readiness.run(endpoint,endpointNonce,authentication,async client=>{
      const p=(await client.query(`SELECT p.*,s.created_at AS session_created_at FROM economic_payment_preparations p
        JOIN account_sessions s ON s.session_id=p.account_session_id
        JOIN external_identities e ON e.account_id=s.account_id
        JOIN economic_session_bindings b ON b.account_session_id=s.session_id AND b.issuer=e.issuer AND b.provider_subject=e.subject
        WHERE p.payment_id=$1 AND e.issuer=$2 AND e.subject=$3 AND b.provider_session_reference=$4`,
      [reference.paymentId,authentication.issuer,authentication.subject,providerSessionReference])).rows[0];
      requireCondition(p,"Unknown controlled Runtime payment/session owner.");
      const c=(await client.query(`SELECT c.*,r.consent_id,pol.payload AS policy_payload FROM economic_confirmation_challenges c
        JOIN economic_confirmation_consumptions r USING(challenge_id)
        JOIN economic_confirmation_policies pol ON pol.fingerprint=c.policy_fingerprint
        WHERE c.challenge_id=$1 AND c.envelope_digest=$2 AND c.account_session_id=$3`,
      [reference.challengeId,p.envelope_digest,p.account_session_id])).rows[0];
      const configuration=this.readiness.deployment.configuration;
      const now=await databaseTime(client);
      requireCondition(c && c.issuer===authentication.issuer && c.provider_subject===authentication.subject &&
        c.configuration===configuration.fingerprint && c.environment===configuration.profile.environment &&
        authentication.scopes.includes(JSON.parse(c.policy_payload).requiredScope) &&
        authentication.issuedAt*1000>=p.session_created_at.getTime() && authentication.issuedAt*1000<=Date.parse(now) && authentication.expiresAt*1000>Date.parse(now),
        "Exact confirmed payment and current authentication required.");
      const request=runtimeRequest({paymentId:p.payment_id,accountSessionId:p.account_session_id,envelopeDigest:p.envelope_digest,consentId:c.consent_id});
      const old=(await client.query("SELECT * FROM economic_policy_decisions WHERE payment_id=$1",[p.payment_id])).rows[0];
      requireCondition(!old || (old.envelope_digest===request.envelopeDigest && old.account_session_id===request.accountSessionId && old.consent_id===request.consentId),"Controlled Runtime history binding conflict.");
      return {request,old,now};
    });
    const before=await load();
    if(action==="runtime-recover" && !before.old)return controlledRuntimeResult(reference.paymentId,undefined,false,before.now);
    // A rejected identity is terminal. Never look for another evaluator or manufacture a replacement.
    if(before.old?.decision.status==="REJECTED")return controlledRuntimeResult(reference.paymentId,before.old.decision,false,before.now);
    let result:NonValueRuntimeResult|undefined;
    try {result=await this.evaluate(before.request,authentication,providerSessionReference,endpoint,endpointNonce);}
    catch(error) {
      if(!before.old)throw error;
      // Existing history may be readable while current registry/configuration qualification fails.
      // Report verification unavailable, never reinterpret this exception as a new policy decision.
    }
    const after=await load(); // Fresh authenticated ownership and database expiry observation, including on failure.
    requireCondition(after.old && (!result || isDeepStrictEqual(after.old.decision,result.decision)),"Controlled Runtime decision missing or changed.");
    return controlledRuntimeResult(reference.paymentId,after.old.decision,result?.currentApproval??false,after.now,!result);
  }
  evaluate(request:RuntimeRequest, authentication:Auth0Authentication, providerSessionReference:string,
    endpoint:SignedArtifact, endpointNonce:string):Promise<NonValueRuntimeResult> {
    const input=runtimeRequest(request);
    requireCondition(typeof providerSessionReference==="string" && providerSessionReference.length>0 && providerSessionReference.length<=512,
      "Trusted SDK session reference required.");
    return this.readiness.run(endpoint,endpointNonce,authentication,
      client=>this.run(client,input,authentication,providerSessionReference));
  }
  private async run(client:PoolClient, input:RuntimeRequest, auth:Auth0Authentication, providerSession:string):Promise<NonValueRuntimeResult> {
    const deployment=this.readiness.deployment.configuration;
    const envelope=await loadEnvelope(client,input.envelopeDigest);
    requireCondition(authorizationBindingDigestV1(envelope,envelope.amount.asset)===input.envelopeDigest,"Corrupt prepared envelope.");
    const head=(await client.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE",[envelope.attempt.intentId])).rows[0];
    const identity=(await client.query("SELECT account_id FROM external_identities WHERE issuer=$1 AND subject=$2",[auth.issuer,auth.subject])).rows[0];
    requireCondition(identity,"Unknown Runtime identity.");
    const account=(await client.query("SELECT * FROM accounts WHERE account_id=$1 FOR SHARE",[identity.account_id])).rows[0];
    const session=(await client.query("SELECT * FROM account_sessions WHERE session_id=$1 FOR SHARE",[input.accountSessionId])).rows[0];
    const binding=(await client.query(`SELECT account_session_id FROM economic_session_bindings
      WHERE issuer=$1 AND provider_subject=$2 AND provider_session_reference=$3`,[auth.issuer,auth.subject,providerSession])).rows[0];
    const prepared=(await client.query("SELECT * FROM economic_payment_preparations WHERE payment_id=$1",[input.paymentId])).rows[0];
    requireCondition(account && session?.account_id===account.account_id && envelope.principal.id===account.actor_subject &&
      head?.principal_id===account.actor_subject && binding?.account_session_id===session.session_id &&
      prepared?.envelope_digest===input.envelopeDigest && prepared.account_session_id===session.session_id &&
      auth.issuedAt*1000>=session.created_at.getTime(),"Runtime payment/session/identity binding mismatch.");
    const {profile,current:policyCurrent}=await loadRuntimeTestProfile(client,deployment,envelope.runtime.evidenceDigest);
    const provider=(await client.query("SELECT * FROM economic_deployment_identity WHERE singleton FOR SHARE")).rows[0];
    const consent=(await client.query("SELECT * FROM economic_consent_evidence WHERE consent_id=$1 FOR SHARE",[input.consentId])).rows[0];
    const admitted=(await client.query(`SELECT c.* FROM economic_confirmation_consumptions r
      JOIN economic_confirmation_challenges c USING(challenge_id) WHERE r.consent_id=$1`,[input.consentId])).rows[0];
    // Guarded consumption provenance is mandatory. Raw/legacy consent rows cannot enter this path.
    requireCondition(consent && admitted && consent.envelope_digest===input.envelopeDigest && consent.principal_id===account.actor_subject &&
      consent.account_session_id===session.session_id && consent.issuer===auth.issuer && consent.audience===deployment.profile.audience &&
      consent.provider_subject===auth.subject && consent.context==="zephipay-economic-consent-v1" &&
      admitted.account_session_id===session.session_id && admitted.envelope_digest===input.envelopeDigest &&
      admitted.configuration===deployment.fingerprint && admitted.environment===deployment.profile.environment,
      "Exact guarded consent required.");
    const consentPolicy=(await client.query("SELECT payload FROM economic_confirmation_policies WHERE fingerprint=$1",[admitted.policy_fingerprint])).rows[0];
    requireCondition(consentPolicy && auth.scopes.includes(JSON.parse(consentPolicy.payload).requiredScope),"Runtime authentication scope mismatch.");
    const state=(await client.query("SELECT state FROM economic_envelopes WHERE envelope_digest=$1",[input.envelopeDigest])).rows[0].state;
    // Registry locks prevent revocation racing the decision. A missing/revoked registry fails closed, including recovery.
    const registryTime=await databaseTime(client);
    await qualifyAsset(client,envelope.amount.asset,"PAYMENT",registryTime);
    await qualifyAsset(client,envelope.fee.asset,"FEE",registryTime);
    const context:RuntimePolicyContextV1={evaluatedAt:await databaseTime(client),network:profile.network,
      session:{id:session.session_id,version:String(account.version)}};
    // Recheck effective times at the evaluation sample too, including a database clock correction.
    await qualifyAsset(client,envelope.amount.asset,"PAYMENT",context.evaluatedAt);
    await qualifyAsset(client,envelope.fee.asset,"FEE",context.evaluatedAt);
    requireCondition(auth.issuedAt*1000<=Date.parse(context.evaluatedAt) && auth.expiresAt*1000>Date.parse(context.evaluatedAt),"Runtime authentication expired.");
    const eligible=account.status==="ACTIVE" && policyCurrent && state==="OPEN" && head.current_generation===envelope.attempt.generation &&
      String(provider?.provider_key_revision)===String(auth.keyRevision) && String(admitted.provider_revision)===String(auth.keyRevision) &&
      envelope.runtime.validFrom<=context.evaluatedAt;
    const records=this.records(envelope,input,account,session,prepared,consent,eligible);
    // Authentication is over the WHOLE normalized record, against snapshots obtained above under the issuer's
    // real LOGIN and authority locks. This closed capability never accepts a caller-selected record or qualifier.
    const authority=createRuntimeEvidenceAuthorityV1({authorityId,
      authenticate:async record=>records.some(known=>isDeepStrictEqual(record,known))});
    const qualified=await createRuntimeEvidenceSetV1(records,authority);
    const evaluator=new RuntimePolicyEvaluatorV1(profile,{evaluatorId:"zephyon:RuntimePolicyEvaluatorV1",evaluatorVersion:"0.5.0",
      evidenceAuthorityId:authorityId,expectedProfileDigest:envelope.runtime.evidenceDigest,
      configurationVersion:profile.configurationVersion,configurationFingerprint:profile.configurationFingerprint},authority);
    const old=(await client.query("SELECT * FROM economic_policy_decisions WHERE envelope_digest=$1",[input.envelopeDigest])).rows[0];
    if(old) {
      requireCondition(old.consent_id===input.consentId && old.payment_id===input.paymentId && old.account_session_id===input.accountSessionId,
        "Runtime recovery binding conflict.");
      let currentApproval=false;
      // Reconstruct the original capability only if ALL current authoritative facts still equal its snapshot.
      // Revocation, eligibility/version change or shorter expiry never rewrites/renews the historical decision.
      if(old.decision.status==="APPROVED" && isDeepStrictEqual(old.evidence,records) &&
        context.evaluatedAt>=old.decision.issuedAt && context.evaluatedAt<old.decision.expiresAt) {
        evaluator.verifyDecision(old.decision,envelope,qualified,old.evaluation_context,context.evaluatedAt);
        currentApproval=true;
      }
      return frozen({mode:"non-value",decision:old.decision,currentApproval,executionAuthorized:false});
    }
    const decision=evaluator.evaluate(envelope,qualified,context);
    // A lock wait crossing expiry cannot persist an approval. SQL checks the database clock again at insertion.
    if(decision.status==="APPROVED") evaluator.verifyDecision(decision,envelope,qualified,context,await databaseTime(client));
    await client.query(`INSERT INTO economic_policy_decisions(decision_id,envelope_digest,payment_id,account_session_id,consent_id,
      profile_digest,decision,evidence,evaluation_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [decision.decisionId,input.envelopeDigest,input.paymentId,input.accountSessionId,input.consentId,
      decision.profileDigest,decision,JSON.stringify(records),context]);
    return frozen({mode:"non-value",decision,currentApproval:decision.status==="APPROVED",executionAuthorized:false});
  }
  private records(envelope:EconomicIntentEnvelopeV1,input:RuntimeRequest,account:Row,session:Row,prepared:Row,consent:Row,eligible:boolean):RuntimeEvidenceV1[] {
    const common={schema:"zephyon.runtime-policy-evidence/v1" as const,subjectId:envelope.principal.id,
      envelopeDigest:input.envelopeDigest,network:envelope.amount.asset.network};
    const p=prepared.payment_snapshot;
    requireCondition(envelope.amount.asset.kind==="spl-token","Prepared token destination required.");
    // Qualify the receiving account independently from the immutable payment's mint/wallet.
    // Local address derivation only: no RPC, transaction construction or ownership claim.
    const destinationAccount=getAssociatedTokenAddressSync(new PublicKey(p.mint),new PublicKey(p.recipient),false,
      new PublicKey(envelope.amount.asset.tokenProgram)).toBase58();
    return [
      {...common,evidenceId:consent.consent_id,evidenceClass:"economic-consent",sourceId:runtimeSources.consent.id,sourceVersion:runtimeSources.consent.version,
        resource:{kind:"envelope",id:envelope.attempt.intentId,version:envelope.attempt.intentVersion},
        issuedAt:consent.confirmed_at.toISOString(),expiresAt:consent.expires_at.toISOString(),digest:snapshotDigest(consent),
        reference:`consent:${consent.consent_id}`,status:consent.revoked_at?"revoked":"satisfied",
        fact:{kind:"economic-consent",consent:{schema:"zephyon.economic-consent/v1",consentId:consent.consent_id,
          principalId:consent.principal_id,envelopeDigest:consent.envelope_digest,confirmedAt:consent.confirmed_at.toISOString()}}},
      {...common,evidenceId:`session:${session.session_id}`,evidenceClass:"eligibility",sourceId:runtimeSources.eligibility.id,sourceVersion:runtimeSources.eligibility.version,
        resource:{kind:"session",id:session.session_id,version:String(account.version)},issuedAt:session.created_at.toISOString(),expiresAt:session.expires_at.toISOString(),
        digest:snapshotDigest({account,session,eligible}),reference:`session:${session.session_id}`,status:session.revoked_at?"revoked":eligible?"satisfied":"unsatisfied",fact:{kind:"attestation"}},
      {...common,evidenceId:`destination:${prepared.payment_id}`,evidenceClass:"destination",sourceId:runtimeSources.destination.id,sourceVersion:runtimeSources.destination.version,
        resource:{kind:"destination",id:envelope.recipient.destinationBindingId,version:envelope.recipient.destinationVersion},
        issuedAt:prepared.created_at.toISOString(),expiresAt:envelope.expiresAt,digest:snapshotDigest(p),reference:`preparation:${prepared.payment_id}`,
        status:p.recipientType==="DIRECT_WALLET"&&p.recipient===envelope.recipient.wallet?"satisfied":"unsatisfied",
        fact:{kind:"destination",recipientKind:"direct-wallet",wallet:p.recipient,account:destinationAccount}},
    ];
  }
}
