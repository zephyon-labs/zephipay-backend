import type { Pool } from "pg";
import type { EconomicIntentEnvelopeV1 } from "zephyon-protocol";
import { authorizationBindingDigestV1,inspectSponsoredSignaturesV1,sameNetworkV1 } from "zephyon-protocol";
import type { SignerRequest,SignerResponse,DurableFinalization } from "../../src/economic/foundation/finalizationTypes";
import type { SyntheticRuntimePort,SyntheticSignerPort,SyntheticObserverPort,ObserverReport } from "../../src/economic/composition/trustedAuthorityComposition";
import { requireCondition,sha256,transaction } from "../../src/economic/foundation/database";

// Disposable harness infrastructure only; no synthetic state schema is installed by product migrations.
export async function installSyntheticStore(admin:Pool) {
  await admin.query(`CREATE SCHEMA IF NOT EXISTS economic_synthetic;
    CREATE TABLE IF NOT EXISTS economic_synthetic.signer_plans(operation_id uuid PRIMARY KEY,tuple_digest text NOT NULL,customer_digest text NOT NULL,reply jsonb NOT NULL,lose_response boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS economic_synthetic.signer_operations(operation_id uuid PRIMARY KEY,tuple_digest text NOT NULL,reply jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS economic_synthetic.observer_plans(plan_id text PRIMARY KEY,finalization_id uuid NOT NULL,report jsonb NOT NULL);
    REVOKE ALL ON SCHEMA economic_synthetic FROM PUBLIC;
    GRANT USAGE ON SCHEMA economic_synthetic TO zephipay_economic_signer,zephipay_economic_observer;
    GRANT SELECT ON economic_synthetic.signer_plans,economic_synthetic.signer_operations TO zephipay_economic_signer;
    GRANT INSERT ON economic_synthetic.signer_operations TO zephipay_economic_signer;
    GRANT SELECT ON economic_synthetic.observer_plans TO zephipay_economic_observer;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='synthetic_signer_immutable') THEN
        CREATE TRIGGER synthetic_signer_immutable BEFORE UPDATE OR DELETE ON economic_synthetic.signer_operations FOR EACH ROW EXECUTE FUNCTION public.reject_identity_append_only_mutation();
      END IF;
    END; $$;`);
}

export class SyntheticRuntimeIssuer implements SyntheticRuntimePort {
  readonly kind="synthetic" as const;
  constructor(readonly sourceId:string,private readonly transform:(value:any)=>any=value=>value) {}
  async evaluate(envelope:EconomicIntentEnvelopeV1):Promise<Uint8Array> {
    const value=this.transform({issuer:this.sourceId,network:envelope.amount.asset.network,binding:{schema:"zephyon.runtime-binding/v1",reference:envelope.runtime,
      envelopeDigest:authorizationBindingDigestV1(envelope,envelope.amount.asset),result:"approved"}});
    return Buffer.from(typeof value==="string"?value:JSON.stringify(value));
  }
}

/** Exact artifact fixtures are provisioned beforehand using dummy test keys OUTSIDE this adapter.
 * This adapter has no key, signing, transaction construction, RPC or replacement-operation API. */
export class DurableSyntheticSigner implements SyntheticSignerPort {
  readonly kind="synthetic" as const; readonly sourceId="synthetic-signer-v1";
  constructor(private readonly pool:Pool,private readonly corruptReply=false) {}
  private wire(reply:any):SignerResponse {
    const value={...reply,...(reply.artifact?{artifact:Buffer.from(reply.artifact,"base64")}:{}),...(this.corruptReply?{tupleDigest:"ef".repeat(32)}:{})};
    return value as SignerResponse;
  }
  async finalize(request:SignerRequest):Promise<SignerResponse> {
    const {operation:op}=request;
    const stored=await transaction(this.pool,async client=>{
      const authority=(await client.query("SELECT * FROM economic_signer_contact_authority WHERE finalization_id=$1",[op.sponsorFinalizationId])).rows[0];
      requireCondition(authority?.signer_operation_id===op.signerOperationId&&authority.tuple_digest===op.tupleDigest,"Synthetic signer requires exact durable contact authority.");
      const plan=(await client.query("SELECT * FROM economic_synthetic.signer_plans WHERE operation_id=$1",[op.signerOperationId])).rows[0];
      requireCondition(plan?.tuple_digest===op.tupleDigest&&plan.customer_digest===sha256(request.customerArtifact),"Synthetic signer plan/message conflict.");
      const reply=plan.reply;
      requireCondition(reply.signerOperationId===op.signerOperationId&&reply.tupleDigest===op.tupleDigest&&reply.sponsorKeyVersion===op.tuple.sponsorKeyVersion&&sameNetworkV1(reply.network,op.tuple.network),"Synthetic signer identity mismatch.");
      if(reply.state==="SIGNED") {
        const result=inspectSponsoredSignaturesV1(Buffer.from(reply.artifact,"base64"),op.tuple.messageDigest,op.tuple.userSigner,op.tuple.sponsorPublicKey);
        requireCondition(result.state==="FULLY_SIGNED"&&result.customerSignatureDigest===op.tuple.customerSignatureDigest,"Invalid exact synthetic artifact fixture.");
      }
      await client.query("INSERT INTO economic_synthetic.signer_operations(operation_id,tuple_digest,reply) VALUES($1,$2,$3) ON CONFLICT(operation_id) DO NOTHING",[op.signerOperationId,op.tupleDigest,reply]);
      const result=(await client.query("SELECT * FROM economic_synthetic.signer_operations WHERE operation_id=$1",[op.signerOperationId])).rows[0];
      requireCondition(result.tuple_digest===op.tupleDigest&&JSON.stringify(result.reply)===JSON.stringify(reply),"Conflicting immutable synthetic signer result.");
      return {reply:result.reply,lose:plan.lose_response};
    });
    if(stored.lose)throw new Error("Synthetic response lost after durable signer result.");
    return this.wire(stored.reply);
  }
  async query(request:SignerRequest):Promise<SignerResponse> {
    const op=request.operation;
    const stored=(await this.pool.query("SELECT * FROM economic_synthetic.signer_operations WHERE operation_id=$1",[op.signerOperationId])).rows[0];
    if(stored){requireCondition(stored.tuple_digest===op.tupleDigest,"Conflicting operation lookup.");return this.wire(stored.reply);}
    return {state:"UNKNOWN",signerOperationId:op.signerOperationId,tupleDigest:op.tupleDigest,network:op.tuple.network,sponsorKeyVersion:op.tuple.sponsorKeyVersion};
  }
}

export class DurableSyntheticObserver implements SyntheticObserverPort {
  readonly kind="synthetic" as const;readonly sourceId="synthetic-observer-v1";
  constructor(private readonly pool:Pool,private readonly planId="pending") {}
  async observe(op:DurableFinalization):Promise<ObserverReport> {
    if(this.planId==="pending")return {sourceId:this.sourceId,reference:`pending:${op.sponsorFinalizationId}`,finalizationId:op.sponsorFinalizationId,network:op.tuple.network,state:"UNKNOWN"};
    const row=(await this.pool.query("SELECT * FROM economic_synthetic.observer_plans WHERE plan_id=$1",[this.planId])).rows[0];
    requireCondition(row?.finalization_id===op.sponsorFinalizationId,"Synthetic observer plan operation mismatch.");
    return row.report as ObserverReport;
  }
}
