import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { createAccountSessionInTransaction, revokeAccountSessionInTransaction } from "../../storage/postgres/postgresIdentityPersistence";
import { databaseTime, requireCondition, sha256 } from "../foundation/database";
import { bindEconomicSession, lockEconomicSession } from "../foundation/sessionAuthority";
import { exactObject } from "../foundation/strictJson";
import { Auth0SdkConfirmationAdapter, type ReadAuth0SdkSession } from "../confirmation/auth0SdkConfirmationAdapter";
import type { VerifiedConfirmationPolicy } from "../confirmation/confirmationPolicy";
import type { Auth0Authentication } from "../readiness/auth0Authentication";
import type { ProviderDeploymentReadiness } from "../readiness/providerDeploymentReadiness";
import type { SignedArtifact } from "../readiness/signedArtifact";
import type { PreparedPayment } from "../preparation/paymentEnvelopePreparation";
import { signWebResponse, verifyWebRequest, webUuid, type Handoff, type HandoffContext, type WebAction, type WebSession, type WebState } from "./handoffContract";

type Proof = Awaited<ReturnType<Auth0SdkConfirmationAdapter["prepareConfirmation"]>>;
/** App/issuer remain separate restricted authorities. These ports wrap their accepted services,
 * including identity->issuer readiness transport. No operational database credential goes to Site. */
export type ControlledWebPorts = {
  prepare(paymentId: string, authentication: Auth0Authentication, reference: string): Promise<PreparedPayment>;
  challenge(prepared: PreparedPayment, authentication: Auth0Authentication, requestId: string): Promise<{challenge_id: string; transaction_id: string}>;
  admit(proof: Proof): Promise<void>;
};
export class ControlledWebConfirmation {
  readonly productionReady = false;
  private readonly sdk: Auth0SdkConfirmationAdapter;
  constructor(private readonly identity: ProviderDeploymentReadiness, private readonly policy: VerifiedConfirmationPolicy,
    private readonly context: HandoffContext, private readonly siteKey: KeyObject, private readonly responseKey: KeyObject,
    private readonly endpoint: () => {artifact: SignedArtifact; nonce: string}, private readonly ports: ControlledWebPorts,
    enabled: "controlled-non-value") {
    exactObject(context,["environment","configuration","siteOrigin","backendOrigin","clientId","issuer"]);
    this.context=Object.freeze({...context});
    requireCondition(siteKey.type==="public" && siteKey.asymmetricKeyType==="ed25519" && responseKey.type==="private" && responseKey.asymmetricKeyType==="ed25519" &&
      siteKey.export({type:"spki",format:"pem"})!==createPublicKey(responseKey).export({type:"spki",format:"pem"}),"Distinct pinned Site and Backend keys required.");
    const p=identity.deployment.configuration;
    requireCondition(enabled === "controlled-non-value" && identity.deployment.process.role === "identity" && policy.policy.attestation === "TEST" &&
      context.configuration===p.fingerprint && context.environment===p.profile.environment && context.clientId===p.profile.clientId && context.issuer===p.profile.issuer,
      "Explicit TEST-only controlled web composition required.");
    for(const origin of [context.siteOrigin,context.backendOrigin]) {
      const url=new URL(origin);requireCondition(url.origin===origin && (url.protocol==="https:" || (url.protocol==="http:" && url.hostname==="localhost")),"Exact trusted origin required.");
    }
    this.sdk=new Auth0SdkConfirmationAdapter(identity,policy,()=>{throw new Error("SDK is Site-hosted.");},`${context.siteOrigin}/auth/callback`);
  }
  async handle(action: WebAction, packet: Handoff): Promise<Handoff> {
    const ep=this.endpoint();
    // Authenticate before reading any provider credential. Atomic replay claim commits separately;
    // failed or ambiguous calls need a fresh transport request, not re-use of its signature.
    const verified=await this.identity.deployment.run(ep.artifact,ep.nonce,async client=>{
      const m=verifyWebRequest(packet,this.context,action,this.siteKey,Date.parse(await databaseTime(client))/1000);
      const claim=await client.query("INSERT INTO economic_web_handoff_requests(request_id,expires_at) VALUES($1,to_timestamp($2)) ON CONFLICT DO NOTHING RETURNING request_id",[m.requestId,m.expiresAt]);
      requireCondition(claim.rowCount===1,"Site handoff replay rejected.");return m;
    });
    const b=verified.body;
    exactObject(b,["session",...(["revoke","callback"].includes(action)?[]:["paymentId"]),...(action==="start"?["bindingId","authorizationUrl"]:action==="callback"?["bindingId","stateDigest"]:[])]);
    exactObject(b.session,["reference","expiresAt","subject","accessToken","idToken"]);
    requireCondition(webUuid(b.session.reference) && Number.isSafeInteger(b.session.expiresAt) && typeof b.session.subject === "string" && b.session.subject.length<=512 &&
      typeof b.session.accessToken === "string" && b.session.accessToken.length<=12000 && typeof b.session.idToken === "string" && b.session.idToken.length<=12000 &&
      (["revoke","callback"].includes(action) || webUuid(b.paymentId)),"Invalid controlled handoff body.");
    if(action==="revoke") {
      await this.identity.deployment.run(ep.artifact,ep.nonce,async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[b.session.reference]);
        await client.query("INSERT INTO economic_web_revocations(reference) VALUES($1) ON CONFLICT DO NOTHING",[b.session.reference]);
        const s=(await client.query("SELECT * FROM economic_web_sessions WHERE reference=$1",[b.session.reference])).rows[0];
        if(!s)return;
        requireCondition(s.issuer===this.context.issuer && s.subject===b.session.subject,"Web session owner changed.");
        const row=(await client.query("SELECT a.* FROM accounts a JOIN account_sessions s USING(account_id) WHERE s.session_id=$1 FOR UPDATE OF a",[s.account_session_id])).rows[0];
        const current=(await client.query("SELECT revoked_at FROM account_sessions WHERE session_id=$1",[s.account_session_id])).rows[0];
        if(!current.revoked_at)await revokeAccountSessionInTransaction(client,{accountId:row.account_id,sessionId:s.account_session_id,expectedAccountVersion:BigInt(row.version)});
      });
      return signWebResponse(packet,{state:"REVOKED"},this.responseKey);
    }
    const auth=await this.identity.authentication.verifyAccess(b.session.accessToken,this.policy.policy.requiredScope);
    requireCondition(auth.subject===b.session.subject,"Site/provider subject mismatch.");
    const read: ReadAuth0SdkSession=async()=>({user:{sub:b.session.subject},tokenSet:{accessToken:b.session.accessToken,idToken:b.session.idToken}});
    const sessionId=await this.session(b.session,auth,action==="prepare");
    if(action==="callback") {
      requireCondition(webUuid(b.bindingId),"Invalid binding reference.");
      b.paymentId=await this.identity.run(ep.artifact,ep.nonce,auth,async c=>(await c.query("SELECT payment_id FROM economic_web_ceremonies WHERE binding_id=$1 AND reference=$2",[b.bindingId,b.session.reference])).rows[0]?.payment_id);
      requireCondition(webUuid(b.paymentId),"Unknown callback session/binding.");
    }
    let ceremony=await this.identity.run(ep.artifact,ep.nonce,auth,async c=>(await c.query("SELECT * FROM economic_web_ceremonies WHERE payment_id=$1",[b.paymentId])).rows[0]);
    if(!ceremony && action==="prepare") {
      const prepared=await this.ports.prepare(b.paymentId!,auth,`zephipay:web:${b.session.reference}`);
      requireCondition(prepared.accountSessionId===sessionId,"Prepared session mismatch.");
      await this.sdk.bindExistingSession(sessionId,read,ep.artifact,ep.nonce);
      const challenge=await this.ports.challenge(prepared,auth,b.paymentId!);
      ceremony=await this.identity.run(ep.artifact,ep.nonce,auth,async c=>{
        await c.query(`INSERT INTO economic_web_ceremonies(payment_id,reference,envelope_digest,challenge_id,transaction_id,binding_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(payment_id) DO NOTHING`,[b.paymentId,b.session.reference,prepared.envelopeDigest,challenge.challenge_id,challenge.transaction_id,randomUUID()]);
        return (await c.query("SELECT * FROM economic_web_ceremonies WHERE payment_id=$1",[b.paymentId])).rows[0];
      });
    }
    requireCondition(ceremony?.reference===b.session.reference,"Prepared payment belongs to another session or is not prepared.");
    const prior=await this.state(b.paymentId!,b.session.reference,auth,sha256(b.session.idToken));
    if(action==="recover" || action==="prepare" || prior.state==="CONFIRMED" || prior.state==="EXPIRED")return signWebResponse(packet,prior,this.responseKey);
    if(action==="start") {
      requireCondition(b.bindingId===ceremony.binding_id && typeof b.authorizationUrl==="string" && b.authorizationUrl.length<=4096 && prior.state==="READY","SDK initiation conflict.");
      await this.sdk.bindExistingSession(sessionId,read,ep.artifact,ep.nonce);
      await this.sdk.bindSdkTransaction(ceremony.challenge_id,ceremony.binding_id,b.authorizationUrl,read,ep.artifact,ep.nonce);
    } else if(action==="callback") {
      requireCondition(b.bindingId===ceremony.binding_id && typeof b.stateDigest==="string" && /^[a-f0-9]{64}$/.test(b.stateDigest),"SDK callback reference mismatch.");
      await this.sdk.recordSdkCallback(ceremony.binding_id,b.stateDigest,read,ep.artifact,ep.nonce);
    } else if(action==="confirm") {
      requireCondition(prior.state==="CONFIRMABLE","Explicit confirmation requires validated callback.");
      // A concurrent winner may consume between this read and guarded admission. Recover only
      // from authoritative CONFIRMED evidence, never from a failed operation or callback success.
      try { await this.ports.admit(await this.sdk.prepareConfirmation(ceremony.binding_id,read,ep.artifact,ep.nonce)); }
      catch(error) {if((await this.state(b.paymentId!,b.session.reference,auth,sha256(b.session.idToken))).state!=="CONFIRMED")throw error;}
    }
    return signWebResponse(packet,await this.state(b.paymentId!,b.session.reference,auth,sha256(b.session.idToken)),this.responseKey);
  }
  private async session(s: WebSession, auth: Auth0Authentication, create: boolean): Promise<string> {
    const ep=this.endpoint();
    return this.identity.run(ep.artifact,ep.nonce,auth,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[s.reference]);
      requireCondition(!(await client.query("SELECT 1 FROM economic_web_revocations WHERE reference=$1",[s.reference])).rowCount,"Web session revoked.");
      const a=(await client.query("SELECT a.* FROM accounts a JOIN external_identities e USING(account_id) WHERE e.issuer=$1 AND e.subject=$2 FOR UPDATE OF a",[auth.issuer,auth.subject])).rows[0];
      requireCondition(a?.status==="ACTIVE","Canonical account unavailable.");
      let old=(await client.query("SELECT * FROM economic_web_sessions WHERE reference=$1",[s.reference])).rows[0];
      if(!old) {
        requireCondition(create && s.expiresAt>auth.issuedAt && s.expiresAt<=auth.issuedAt+604800,"Missing web session or invalid absolute lifetime.");
        // Canonical chronology begins at the independently verified authentication event. The
        // separate mapping recorded_at retains actual DB creation time; no browser timestamp is used.
        const created=await createAccountSessionInTransaction(client,{accountId:a.account_id,sessionId:randomUUID(),expectedAccountVersion:BigInt(a.version),
          createdAt:new Date(auth.issuedAt*1000).toISOString(),expiresAt:new Date(s.expiresAt*1000).toISOString()},await databaseTime(client));
        old=(await client.query("INSERT INTO economic_web_sessions(reference,issuer,subject,account_session_id,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [s.reference,auth.issuer,auth.subject,created.session.sessionId,created.session.expiresAt])).rows[0];
        await bindEconomicSession(client,{issuer:auth.issuer,providerSubject:auth.subject,providerSessionReference:`zephipay:web:${s.reference}`,accountSessionId:old.account_session_id});
      }
      requireCondition(old.issuer===auth.issuer && old.subject===auth.subject && old.expires_at.getTime()/1000===s.expiresAt,"Immutable web session mismatch.");
      await lockEconomicSession(client,{issuer:auth.issuer,subject:auth.subject,principalId:a.actor_subject,providerSession:`zephipay:web:${s.reference}`,
        requiredSessionId:old.account_session_id,authenticatedAt:new Date(auth.issuedAt*1000).toISOString()});
      return old.account_session_id;
    });
  }
  private async state(paymentId: string, reference: string, auth: Auth0Authentication, idTokenDigest: string): Promise<WebState> {
    const ep=this.endpoint();
    return this.identity.run(ep.artifact,ep.nonce,auth,async c=>{
      const row=(await c.query("SELECT * FROM economic_web_status WHERE payment_id=$1 AND reference=$2",[paymentId,reference])).rows[0];
      requireCondition(row,"Unknown web ceremony.");
      const state: WebState["state"]=row.state==="CONFIRMED"?"CONFIRMED":row.state==="EXPIRED"?"EXPIRED":row.state!=="ISSUED"?"SESSION_CHANGED":row.sdk_completed?(row.sdk_token_digest===idTokenDigest?"CONFIRMABLE":"SESSION_CHANGED"):row.sdk_started?"AUTHENTICATION_REQUIRED":"READY";
      return {paymentId,state,expiresAt:row.expires_at.toISOString(),bindingId:row.binding_id};
    });
  }
}
