import express from "express";
import type { Pool } from "pg";
import type { EconomicIntentEnvelopeV1, NetworkDomainV1, PossibleEffectV1 } from "zephyon-protocol";
import type { IdentityPersistence } from "../../identity/identityStorageContracts";
import { createEconomicEvidenceIngestion, EvidencePolicy, TrustedRuntimeIssuer } from "../foundation/evidenceIngestion";
import { DurableFinalization, TrustedSignerPort } from "../foundation/finalizationTypes";
import { PostgresFinalizationRepository } from "../foundation/postgresFinalizationRepository";
import { EconomicSessionAdministration } from "../foundation/sessionAuthority";
import { requireCondition, transaction } from "../foundation/database";
import { CanonicalEconomicSessionService } from "./canonicalSessionService";
import { NeverContactedExpiryWorker } from "./expiryWorker";
import { verifyAuthorityLogin } from "./verifyAuthorityLogin";

type SyntheticIdentity = Readonly<{ kind:"synthetic"; sourceId:string }>;
export type SyntheticRuntimePort = TrustedRuntimeIssuer & SyntheticIdentity;
export type SyntheticSignerPort = TrustedSignerPort & SyntheticIdentity;
export type ObserverReport = Readonly<{sourceId:string;reference:string;finalizationId:string;network:NetworkDomainV1} & (
  {state:"UNKNOWN"} | {state:"POSSIBLE_EFFECT";transactionId:string} |
  {state:"FINALIZED";transactionId:string;outcome:Extract<PossibleEffectV1,{state:"RESOLVED"}>["outcome"];base:string;priority:string;rent:string})>;
export interface SyntheticObserverPort extends SyntheticIdentity { observe(operation:DurableFinalization):Promise<ObserverReport>; }
export type AuthorityConnections=Readonly<{app:Pool;issuer:Pool;signer:Pool;observer:Pool;reader:Pool}>;

/** Explicit internal test/dev factory. No route mounting, environment activation flag or external transport. */
export async function createTrustedAuthorityComposition(input: {
  mode:"synthetic-internal"; connections:AuthorityConnections; identities:IdentityPersistence; policy:EvidencePolicy;
  runtime:SyntheticRuntimePort; signer:SyntheticSignerPort; observer:SyntheticObserverPort;
  expectedSignerSource:string; expectedObserverSource:string;
}) {
  requireCondition(input.mode==="synthetic-internal","Only explicit non-live composition is supported.");
  requireCondition(input.runtime.kind==="synthetic"&&input.signer.kind==="synthetic"&&input.observer.kind==="synthetic","Synthetic adapters required.");
  requireCondition(input.runtime.sourceId===input.policy.runtimeIssuer && input.signer.sourceId===input.expectedSignerSource && input.observer.sourceId===input.expectedObserverSource,"Configured trusted source identity mismatch.");
  const db=input.connections;
  async function readiness() {
    const checks=await Promise.allSettled((Object.keys(db) as (keyof AuthorityConnections)[]).map(role=>verifyAuthorityLogin(db[role],role,{syntheticFixtures:true})));
    const failure=checks.find(r=>r.status==="rejected");if(failure?.status==="rejected")throw failure.reason;
    const result=checks.map(r=>{requireCondition(r.status==="fulfilled","Incomplete authority verification.");return r.value;});
    requireCondition(new Set(result.map(r=>r.login)).size===5,"Distinct operational LOGIN identities required.");
    return result;
  }
  await readiness();
  const repository=new PostgresFinalizationRepository(db.app,input.policy,input.signer,undefined,{signerResults:db.signer});
  const ingestion=createEconomicEvidenceIngestion(db.issuer,input.policy,input.runtime);
  const expiry=new NeverContactedExpiryWorker(db.app,repository);
  const consentRouter=express.Router();
  consentRouter.use(async (_req,res,next)=>{try{await readiness();next();}catch{res.status(503).json({error:"ECONOMIC_AUTHORITY_NOT_READY"});}});
  consentRouter.use(ingestion.consentRouter);
  return Object.freeze({
    readiness,consentRouter,
    sessions:new CanonicalEconomicSessionService(input.identities,new EconomicSessionAdministration(db.issuer),input.policy.auth.issuer),
    async prepare(envelope:EconomicIntentEnvelopeV1,blockhash:string){await readiness();return repository.registerAttempt(envelope,blockhash);},
    async issueRuntime(digest:string){await readiness();return ingestion.issueRuntimeDecision(digest);},
    async revokeEvidence(kind:"consent"|"runtime",id:string){await readiness();return ingestion.revoke(kind,id);},
    async claim(claim:Parameters<PostgresFinalizationRepository["claim"]>[0]){await readiness();return repository.claim(claim);},
    async recover(id:string){await readiness();return repository.recover(id);},
    async expire(id:string){await readiness();return repository.expireNeverContacted(id);},
    async runExpiryBatch(limit=25){await readiness();return expiry.runBatch(limit);},
    async observe(id:string){
      await readiness();const operation=await repository.find(id);requireCondition(operation,"Unknown finalization.");
      // Only this fixed producer is called; callers cannot submit an observer body or accounting values.
      const report=await input.observer.observe(operation);
      const reportId=(await db.observer.query("SELECT economic_ingest_observation($1,$2,$3) AS id",[id,input.expectedObserverSource,report])).rows[0].id;
      const stored=(await db.observer.query("SELECT report_id,disposition,effect_evidence_id FROM economic_observer_reports WHERE report_id=$1",[reportId])).rows[0];
      if(stored.disposition==="FINALIZED") await transaction(db.app,async client=>{await client.query("SELECT economic_apply_finalized_accounting($1,$2)",[id,stored.effect_evidence_id]);});
      return stored;
    },
    async trace(id:string){
      await readiness();
      const state=(await db.reader.query("SELECT * FROM economic_authority_trace WHERE finalization_id=$1",[id])).rows[0];
      const events=(await db.reader.query("SELECT * FROM economic_authority_events WHERE finalization_id=$1 OR (intent_id=$2 AND generation=$3) ORDER BY event_id",[id,state?.intent_id,state?.generation])).rows;
      const reports=(await db.reader.query("SELECT * FROM economic_observer_report_summary WHERE finalization_id=$1 ORDER BY occurred_at,report_id",[id])).rows;
      const incidents=(await db.reader.query("SELECT * FROM economic_authority_incidents WHERE finalization_id=$1 ORDER BY occurred_at,incident_id",[id])).rows;
      const expiry=(await db.reader.query("SELECT * FROM economic_expiry_records WHERE finalization_id=$1",[id])).rows[0];
      const signerReports=(await db.reader.query("SELECT * FROM economic_signer_report_summary WHERE finalization_id=$1 ORDER BY occurred_at,report_id",[id])).rows;
      return {state,events,reports,incidents,expiry,signerReports};
    },
  });
}
