import type { Pool } from "pg";
import { requireCondition } from "../foundation/database";
import { PostgresFinalizationRepository } from "../foundation/postgresFinalizationRepository";

/** No timer, lease or production registration. Selection is advisory; the existing transaction decides. */
export class NeverContactedExpiryWorker {
  constructor(private readonly pool:Pool,private readonly repository:PostgresFinalizationRepository) {}
  async candidates(limit=25):Promise<string[]> {
    requireCondition(Number.isInteger(limit)&&limit>0&&limit<=100,"Expiry batch must be between 1 and 100.");
    return (await this.pool.query(`SELECT f.finalization_id FROM economic_finalizations f
      JOIN economic_attempts a USING(intent_id,generation) JOIN economic_consent_evidence c USING(consent_id)
      JOIN economic_runtime_evidence r ON r.decision_id=f.runtime_id LEFT JOIN account_sessions s ON s.session_id=c.account_session_id
      JOIN accounts ac ON ac.actor_subject=c.principal_id
      WHERE f.signer_state='NOT_CONTACTED' AND f.exposure_state='RESERVED'
      AND NOT EXISTS(SELECT 1 FROM economic_authority_incidents i WHERE i.finalization_id=f.finalization_id)
      AND NOT EXISTS(SELECT 1 FROM economic_callback_evidence cb WHERE cb.intent_id=f.intent_id AND cb.generation=f.generation AND cb.validation IN ('REJECTED','SPONSOR_RESULT_PRESENT'))
      AND ((a.envelope->>'expiresAt')::timestamptz<=clock_timestamp() OR c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp()
        OR r.revoked_at IS NOT NULL OR r.valid_until<=clock_timestamp() OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR ac.status<>'ACTIVE'
        OR EXISTS(SELECT 1 FROM economic_asset_registry ar JOIN economic_network_registry nr ON nr.registry_id=ar.network_id
          WHERE ar.registry_id IN (f.payment_registry_id,f.fee_registry_id) AND (ar.revoked_at IS NOT NULL OR nr.revoked_at IS NOT NULL)))
      ORDER BY f.created_at,f.finalization_id LIMIT $1`,[limit])).rows.map(r=>r.finalization_id);
  }
  async runBatch(limit=25):Promise<{selected:number;expired:string[];retained:string[]}> {
    const ids=await this.candidates(limit),expired:string[]=[],retained:string[]=[];
    for(const id of ids) {
      try {await this.repository.expireNeverContacted(id,"bounded-expiry-worker");expired.push(id);}
      catch(error) {
        // Only expected authority races/contradictions are retained. Infrastructure failures escape for retry.
        if(error instanceof Error && /cannot be reclaimed|not authoritatively|canonical generation|contradictory|frozen for manual review/.test(error.message)) retained.push(id);
        else throw error;
      }
    }
    return {selected:ids.length,expired,retained};
  }
}
