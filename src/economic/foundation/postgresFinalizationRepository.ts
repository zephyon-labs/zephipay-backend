import { randomUUID } from "node:crypto";
import { Transaction } from "@solana/web3.js";
import type { Pool, PoolClient } from "pg";
import {
  AttemptFenceV1, EconomicIntentEnvelopeV1,
  assertSponsoredMessageProfileV1, authorizationBindingDigestV1, bindSponsorFinalizationV1,
  cancelAttemptV1, commitFinalizationFenceV1, createAttemptFenceV1, createEconomicIntentEnvelopeV1, createSponsorFinalizationTupleV1,
  inspectSponsoredSignaturesV1, offlineSponsoredMessageV1, replaceCancelledAttemptV1, sameNetworkV1, sponsorTupleDigestV1,
} from "zephyon-protocol";
import { audit, databaseTime, machineId, requireCondition, sha256, transaction, units } from "./database";
import { EvidencePolicy, assertActivePrincipal, loadAuthoritativeEvidence, validateEvidencePolicy } from "./evidenceIngestion";
import { DurableFinalization, SignerResponse, TrustedExposureObserver, TrustedSignerPort } from "./finalizationTypes";
import { qualifyAsset } from "./trustedRegistry";

type Row = Record<string, any>;
type Claim = Readonly<{ sponsorFinalizationId: string; envelopeDigest: string; consentId: string; customerArtifact: Uint8Array }>;

function operation(row: Row): DurableFinalization {
  const tuple = createSponsorFinalizationTupleV1(row.tuple);
  requireCondition(sponsorTupleDigestV1(tuple) === row.tuple_digest, "Stored finalization tuple corrupt.");
  return Object.freeze({ sponsorFinalizationId: row.finalization_id, tuple, tupleDigest: row.tuple_digest,
    signerOperationId: row.signer_operation_id, signerState: row.signer_state, exposureState: row.exposure_state,
    requested: Object.freeze({ base: row.base_requested, priority: row.priority_requested, rent: row.rent_requested }),
    ...(row.accounting_reference ? { consumed: Object.freeze({ base: row.base_consumed, priority: row.priority_consumed, rent: row.rent_consumed, reference: row.accounting_reference }) } : {}),
    ...(row.artifact_reference ? { artifactReference: row.artifact_reference, finalTransactionId: row.final_transaction_id } : {}), version: row.version });
}
function fence(row: Row): AttemptFenceV1 {
  return { ...createAttemptFenceV1(row.envelope.attempt, row.message_digest, row.envelope_digest), state: row.state,
    ...(row.finalization_id ? { sponsorFinalizationId: row.finalization_id } : {}) };
}
function bytes(value: Uint8Array): Buffer {
  requireCondition(value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= 1232, "Invalid transaction artifact size.");
  return Buffer.from(value);
}
function uuid(value: string): void {
  requireCondition(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value), "Invalid server operation ID.");
}

/** Internal service/repository, deliberately not wired into any existing payment or wallet route. */
export class PostgresFinalizationRepository {
  private readonly policy: EvidencePolicy;
  constructor(private readonly pool: Pool, configuration: EvidencePolicy,
    private readonly signer?: TrustedSignerPort, private readonly observer?: TrustedExposureObserver) {
    this.policy = validateEvidencePolicy(configuration);
  }

  /** Server-owned preparation seam, not an API body. Qualification is rechecked when authority is committed. */
  async registerAttempt(candidate: EconomicIntentEnvelopeV1, recentBlockhash: string): Promise<string> {
    const envelope = createEconomicIntentEnvelopeV1(candidate, candidate.amount.asset);
    requireCondition(envelope.source.mode === "external-wallet" && envelope.fee.mode === "platform-sponsor", "Sponsored external-wallet profile required.");
    const digest = authorizationBindingDigestV1(envelope, envelope.amount.asset);
    const message = offlineSponsoredMessageV1(envelope, recentBlockhash);
    const messageDigest = assertSponsoredMessageProfileV1(message, envelope, recentBlockhash);
    await transaction(this.pool, async client => {
      // The head is the single serialization point shared by create, cancel and finalization.
      await client.query(`INSERT INTO economic_attempt_heads(intent_id,principal_id,current_generation) VALUES($1,$2,$3)
        ON CONFLICT(intent_id) DO NOTHING`, [envelope.attempt.intentId, envelope.principal.id, envelope.attempt.generation]);
      const head = (await client.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE", [envelope.attempt.intentId])).rows[0];
      requireCondition(head.principal_id === envelope.principal.id, "Intent principal conflict.");
      const previous = (await client.query("SELECT * FROM economic_attempts WHERE intent_id=$1 AND generation=$2", [head.intent_id, head.current_generation])).rows[0];
      if (previous?.envelope_digest === digest) {
        requireCondition(previous.message_digest === messageDigest && previous.recent_blockhash === recentBlockhash, "Attempt message conflict.");
        return;
      }
      if (previous) {
        replaceCancelledAttemptV1(fence(previous), envelope.attempt, messageDigest, digest);
        await client.query("UPDATE economic_attempt_heads SET current_generation=$2 WHERE intent_id=$1", [head.intent_id, envelope.attempt.generation]);
      } else requireCondition(envelope.attempt.generation === "1", "First attempt must be generation one.");
      const now = await databaseTime(client);
      requireCondition(now >= envelope.createdAt && now < envelope.expiresAt, "Attempt outside validity.");
      await assertActivePrincipal(client, envelope.principal.id);
      await qualifyAsset(client, envelope.amount.asset, "PAYMENT", now);
      await qualifyAsset(client, envelope.fee.asset, "FEE", now);
      await client.query(`INSERT INTO economic_attempts(intent_id,generation,attempt_id,fence_token,envelope_digest,envelope,message_digest,recent_blockhash,requested_exposure_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [envelope.attempt.intentId, envelope.attempt.generation, envelope.attempt.attemptId, envelope.attempt.fenceToken, digest, envelope, messageDigest, recentBlockhash, randomUUID()]);
      await audit(client, { type: "ATTEMPT_REQUESTED", actor: envelope.principal.id, ...envelope.attempt, reference: digest });
    });
    return digest;
  }

  async cancel(intentId: string, generation: string, fenceToken: string, principalId: string): Promise<"CANCELLED" | "FINALIZATION_WON"> {
    return transaction(this.pool, async client => {
      const head = (await client.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE", [intentId])).rows[0];
      requireCondition(head && head.principal_id === principalId && head.current_generation === generation, "Stale or unauthorized cancellation.");
      const row = (await client.query("SELECT * FROM economic_attempts WHERE intent_id=$1 AND generation=$2", [intentId, generation])).rows[0];
      requireCondition(row.fence_token === fenceToken, "Cancellation fence mismatch.");
      if (row.state === "FINALIZATION_COMMITTED") {
        await audit(client, { type: "CANCELLATION_LOST", actor: principalId, intentId, generation, finalizationId: row.finalization_id });
        return "FINALIZATION_WON";
      }
      cancelAttemptV1(fence(row));
      if (row.state !== "CANCELLED") await client.query("UPDATE economic_attempts SET state='CANCELLED' WHERE intent_id=$1 AND generation=$2", [intentId, generation]);
      await audit(client, { type: "CANCELLED", actor: principalId, intentId, generation });
      return "CANCELLED";
    });
  }

  /** IDs are generated by the calling server (newSponsorFinalizationClaimV1/randomUUID), never selected by clients. */
  async claim(input: Claim): Promise<{ disposition: "CREATED" | "REPLAY" | "CONVERGED"; operation: DurableFinalization }> {
    uuid(input.sponsorFinalizationId); uuid(input.consentId);
    const artifact = bytes(input.customerArtifact);
    let verifiedCallback = false;
    try {
      return await transaction(this.pool, async client => {
        const initial = (await client.query("SELECT intent_id FROM economic_attempts WHERE envelope_digest=$1", [input.envelopeDigest])).rows[0];
        requireCondition(initial, "Unknown envelope.");
        const head = (await client.query("SELECT * FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE", [initial.intent_id])).rows[0];
        const attempt = (await client.query("SELECT * FROM economic_attempts WHERE envelope_digest=$1", [input.envelopeDigest])).rows[0];
        const envelope = createEconomicIntentEnvelopeV1(attempt.envelope, attempt.envelope.amount.asset);
        const messageDigest = assertSponsoredMessageProfileV1(Transaction.from(artifact).serializeMessage(), envelope, attempt.recent_blockhash);
        const signatures = inspectSponsoredSignaturesV1(artifact, messageDigest, envelope.source.signer, envelope.fee.signer);
        requireCondition(signatures.state === "CUSTOMER_VERIFIED_SPONSOR_ABSENT", "Expected customer-only verified artifact.");
        verifiedCallback = true;
        requireCondition(head.current_generation === attempt.generation && attempt.state !== "CANCELLED", "Stale or cancelled generation; late evidence retained.");
        const tuple = createSponsorFinalizationTupleV1({ schema: "zephyon.sponsor-finalization/v1", attempt: envelope.attempt,
          network: envelope.amount.asset.network, messageDigest, requiredSigners: [envelope.fee.signer,envelope.source.signer], userSigner: envelope.source.signer,
          customerSignatureDigest: signatures.customerSignatureDigest, sponsorPublicKey: envelope.fee.signer, sponsorKeyVersion: envelope.fee.keyVersion,
          envelopeDigest: input.envelopeDigest, consentId: input.consentId, runtime: envelope.runtime, reservedExposureId: attempt.requested_exposure_id });
        const tupleDigest = sponsorTupleDigestV1(tuple);
        // Both indexes select this ONE table, so result snapshots cannot diverge.
        const matches = (await client.query(`SELECT * FROM economic_finalizations WHERE finalization_id=$1 OR (intent_id=$2 AND generation=$3) FOR UPDATE`, [input.sponsorFinalizationId, head.intent_id, attempt.generation])).rows;
        if (matches.length) {
          requireCondition(matches.length === 1 && matches[0].tuple_digest === tupleDigest && attempt.state === "FINALIZATION_COMMITTED" && attempt.finalization_id === matches[0].finalization_id, "Finalization ID/generation tuple conflict.");
          const existing = operation(matches[0]);
          await audit(client, { type: "CLAIM_REPLAY", actor: envelope.principal.id, ...envelope.attempt, finalizationId: existing.sponsorFinalizationId });
          // Read-only replay is not fresh eligibility and never grants signer contact.
          return { disposition: existing.sponsorFinalizationId === input.sponsorFinalizationId ? "REPLAY" : "CONVERGED", operation: existing };
        }
        commitFinalizationFenceV1(fence(attempt), tuple, input.sponsorFinalizationId);
        const now = await databaseTime(client);
        const paymentRegistryId = await qualifyAsset(client, envelope.amount.asset, "PAYMENT", now);
        const feeRegistryId = await qualifyAsset(client, envelope.fee.asset, "FEE", now);
        const evidence = await loadAuthoritativeEvidence(client, envelope, input.consentId, this.policy, now);
        requireCondition(sponsorTupleDigestV1(bindSponsorFinalizationV1({ envelope, ...evidence, now, userSignedTransaction: artifact, recentBlockhash: attempt.recent_blockhash, reservedExposureId: attempt.requested_exposure_id })) === tupleDigest, "Finalization binding mismatch.");
        const budget = (await client.query(`SELECT * FROM economic_sponsor_budgets WHERE network=$1::jsonb AND sponsor_public_key=$2 AND sponsor_key_version=$3 FOR UPDATE`, [tuple.network, tuple.sponsorPublicKey, tuple.sponsorKeyVersion])).rows[0];
        requireCondition(budget, "No configured sponsor exposure budget.");
        await this.assertBudget(client, budget, envelope);
        const row = (await client.query(`INSERT INTO economic_finalizations(finalization_id,intent_id,generation,tuple,tuple_digest,consent_id,runtime_id,payment_registry_id,fee_registry_id,budget_id,exposure_id,base_requested,priority_requested,rent_requested,signer_operation_id,customer_artifact)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [input.sponsorFinalizationId, head.intent_id, attempt.generation, tuple, tupleDigest, input.consentId, envelope.runtime.decisionId,
          paymentRegistryId, feeRegistryId, budget.budget_id, attempt.requested_exposure_id, envelope.fee.maxBaseFee, envelope.fee.maxPriorityFee, envelope.fee.maxRent, randomUUID(), artifact])).rows[0];
        await client.query("UPDATE economic_attempts SET state='FINALIZATION_COMMITTED',finalization_id=$3 WHERE intent_id=$1 AND generation=$2", [head.intent_id, attempt.generation, input.sponsorFinalizationId]);
        // Recheck the wall clock after possible contention. All authority locks are still held.
        await loadAuthoritativeEvidence(client, envelope, input.consentId, this.policy, await databaseTime(client));
        await audit(client, { type: "FINALIZATION_COMMITTED", actor: envelope.principal.id, ...envelope.attempt, finalizationId: input.sponsorFinalizationId, consentId: input.consentId, runtimeId: envelope.runtime.decisionId, reference: attempt.requested_exposure_id });
        return { disposition: "CREATED", operation: operation(row) };
      });
    } catch (error) {
      // Separate append-only evidence survives rollback, including a late cancelled-A callback. Logs contain only a digest.
      await transaction(this.pool, async client => {
        const row = (await client.query("SELECT intent_id,generation FROM economic_attempts WHERE envelope_digest=$1", [input.envelopeDigest])).rows[0];
        if (row) await client.query(`INSERT INTO economic_callback_evidence(evidence_id,intent_id,generation,artifact_digest,artifact,validation)
          VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(),row.intent_id,row.generation,sha256(artifact),artifact,verifiedCallback ? "CUSTOMER_VERIFIED" : "REJECTED"]);
        await audit(client, { type: "CLAIM_REJECTED", actor: "finalization-service", intentId: row?.intent_id, generation: row?.generation, finalizationId: input.sponsorFinalizationId, reference: sha256(artifact) });
      });
      throw error;
    }
  }

  private async assertBudget(client: PoolClient, budget: Row, envelope: EconomicIntentEnvelopeV1): Promise<void> {
    // Consumed cost remains charged against this immutable budget. No automatic replenishment/reset.
    const sum = (await client.query(`SELECT
      COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN base_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN base_requested ELSE 0 END),0)::text AS base,
      COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN priority_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN priority_requested ELSE 0 END),0)::text AS priority,
      COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN rent_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN rent_requested ELSE 0 END),0)::text AS rent,
      count(*) FILTER (WHERE exposure_state IN ('RESERVED','UNCERTAIN'))::integer AS outstanding
      FROM economic_finalizations WHERE budget_id=$1`, [budget.budget_id])).rows[0];
    requireCondition(BigInt(sum.base) + BigInt(envelope.fee.maxBaseFee) <= BigInt(budget.base_limit) &&
      BigInt(sum.priority) + BigInt(envelope.fee.maxPriorityFee) <= BigInt(budget.priority_limit) &&
      BigInt(sum.rent) + BigInt(envelope.fee.maxRent) <= BigInt(budget.rent_limit) && sum.outstanding < budget.outstanding_limit, "Sponsor exposure budget exhausted.");
  }

  async find(sponsorFinalizationId: string): Promise<DurableFinalization | undefined> {
    const row = (await this.pool.query("SELECT * FROM economic_finalizations WHERE finalization_id=$1", [sponsorFinalizationId])).rows[0];
    return row ? operation(row) : undefined;
  }
  async findByGeneration(intentId: string, generation: string): Promise<DurableFinalization | undefined> {
    const row = (await this.pool.query("SELECT * FROM economic_finalizations WHERE intent_id=$1 AND generation=$2", [intentId, generation])).rows[0];
    return row ? operation(row) : undefined;
  }
  async listRecoveryIds(limit = 100): Promise<string[]> {
    requireCondition(Number.isInteger(limit) && limit > 0 && limit <= 1000, "Invalid recovery limit.");
    return (await this.pool.query(`SELECT finalization_id FROM economic_finalizations WHERE signer_state IN ('NOT_CONTACTED','CONTACT_COMMITTED','RESULT_UNKNOWN') ORDER BY created_at,finalization_id LIMIT $1`, [limit])).rows.map(row => row.finalization_id);
  }

  private async lockOperation(client: PoolClient, id: string): Promise<Row> {
    const preliminary = (await client.query("SELECT budget_id FROM economic_finalizations WHERE finalization_id=$1", [id])).rows[0];
    requireCondition(preliminary, "Unknown finalization.");
    // All accounting/result mutations serialize on budget BEFORE operation; no double-release/cross-operation overspend.
    await client.query("SELECT budget_id FROM economic_sponsor_budgets WHERE budget_id=$1 FOR UPDATE", [preliminary.budget_id]);
    return (await client.query("SELECT * FROM economic_finalizations WHERE finalization_id=$1 FOR UPDATE", [id])).rows[0];
  }

  /** No signer parameter at call time: authority is fixed by server composition, never by a request. */
  async recover(id: string): Promise<DurableFinalization> {
    requireCondition(this.signer, "No trusted signer adapter configured.");
    const committed = await transaction(this.pool, async client => {
      const snapshot = (await client.query("SELECT * FROM economic_finalizations WHERE finalization_id=$1", [id])).rows[0];
      requireCondition(snapshot, "Unknown finalization.");
      if (snapshot.signer_state === "NOT_CONTACTED") {
        await client.query("SELECT intent_id FROM economic_attempt_heads WHERE intent_id=$1 FOR UPDATE", [snapshot.intent_id]);
        const a = (await client.query("SELECT * FROM economic_attempts WHERE intent_id=$1 AND generation=$2", [snapshot.intent_id,snapshot.generation])).rows[0];
        requireCondition(a.state === "FINALIZATION_COMMITTED" && a.finalization_id === id, "Signer fence mismatch.");
        const current = (await client.query("SELECT signer_state FROM economic_finalizations WHERE finalization_id=$1", [id])).rows[0];
        if (current.signer_state === "NOT_CONTACTED") {
          const now = await databaseTime(client), envelope = createEconomicIntentEnvelopeV1(a.envelope,a.envelope.amount.asset);
          await qualifyAsset(client, envelope.amount.asset, "PAYMENT", now);
          await qualifyAsset(client, envelope.fee.asset, "FEE", now);
          await loadAuthoritativeEvidence(client,envelope,snapshot.consent_id,this.policy,now);
        }
      }
      const row = await this.lockOperation(client,id);
      if (row.signer_state !== "NOT_CONTACTED") return { row, contact: false };
      const attempt = (await client.query("SELECT envelope FROM economic_attempts WHERE intent_id=$1 AND generation=$2", [row.intent_id,row.generation])).rows[0];
      await loadAuthoritativeEvidence(client,attempt.envelope,row.consent_id,this.policy,await databaseTime(client));
      const changed = (await client.query(`UPDATE economic_finalizations SET signer_state='CONTACT_COMMITTED',exposure_state='UNCERTAIN',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=$1 RETURNING *`, [id])).rows[0];
      await audit(client, { type: "SIGNER_CONTACT_COMMITTED", actor: "signer-coordinator", intentId: row.intent_id, generation: row.generation, finalizationId: id, reference: row.signer_operation_id });
      return { row: changed, contact: true };
    });
    if (["RESULT_AVAILABLE","REFUSED"].includes(committed.row.signer_state)) return operation(committed.row);
    const request = { operation: operation(committed.row), customerArtifact: Buffer.from(committed.row.customer_artifact) };
    let response: SignerResponse;
    try {
      // A process crash after commitment loses the one-shot grant. Recovery only queries the SAME operation.
      response = committed.contact ? await this.signer.finalize(request) : await this.signer.query(request);
    } catch {
      return this.recordUnknown(id);
    }
    try { return await this.acceptSignerResponse(id, response); }
    catch (error) {
      await this.recordUnknown(id);
      await transaction(this.pool, client => audit(client, { type: "SIGNER_RESULT_CONFLICT", actor: "signer-coordinator", finalizationId: id, reference: request.operation.signerOperationId }));
      throw error;
    }
  }

  private async recordUnknown(id: string): Promise<DurableFinalization> {
    return transaction(this.pool, async client => {
      const row = await this.lockOperation(client,id);
      if (["REFUSED","RESULT_AVAILABLE"].includes(row.signer_state)) return operation(row);
      requireCondition(["CONTACT_COMMITTED","RESULT_UNKNOWN"].includes(row.signer_state), "Signer not contacted.");
      const result = (await client.query(`UPDATE economic_finalizations SET signer_state='RESULT_UNKNOWN',exposure_state='UNCERTAIN',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=$1 RETURNING *`, [id])).rows[0];
      await audit(client, { type: "SIGNER_RESULT_UNKNOWN", actor: "signer-coordinator", intentId: row.intent_id, generation: row.generation, finalizationId: id, reference: row.exposure_id });
      return operation(result);
    });
  }

  private async acceptSignerResponse(id: string, response: SignerResponse): Promise<DurableFinalization> {
    return transaction(this.pool, async client => {
      const row = await this.lockOperation(client,id), op = operation(row);
      requireCondition(response.signerOperationId === op.signerOperationId && response.tupleDigest === op.tupleDigest && response.sponsorKeyVersion === op.tuple.sponsorKeyVersion && sameNetworkV1(response.network,op.tuple.network), "Signer response identity/network conflict.");
      requireCondition(row.signer_state !== "NOT_CONTACTED", "Missing signer-contact commitment.");
      if (response.state === "UNKNOWN") {
        if (["RESULT_AVAILABLE","REFUSED"].includes(row.signer_state)) return op;
        const changed = (await client.query(`UPDATE economic_finalizations SET signer_state='RESULT_UNKNOWN',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=$1 RETURNING *`, [id])).rows[0];
        await audit(client, { type: "SIGNER_RESULT_UNKNOWN", actor: "signer-coordinator", finalizationId: id, reference: op.signerOperationId });
        return operation(changed);
      }
      if (response.state === "REFUSED") {
        machineId(response.reference);
        if (row.signer_state === "REFUSED") { requireCondition(row.refusal_reference === response.reference, "Conflicting immutable refusal."); return op; }
        requireCondition(row.signer_state !== "RESULT_AVAILABLE", "Signer refusal conflicts with known signature.");
        const changed = (await client.query(`UPDATE economic_finalizations SET signer_state='REFUSED',refusal_reference=$2,exposure_state='RELEASED',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=$1 RETURNING *`, [id,response.reference])).rows[0];
        await audit(client, { type: "SIGNER_REFUSED_EXPOSURE_RELEASED", actor: "signer-coordinator", finalizationId: id, reference: row.exposure_id });
        return operation(changed);
      }
      requireCondition(response.state === "SIGNED", "Invalid signer result state.");
      const artifact = bytes(response.artifact);
      const signatures = inspectSponsoredSignaturesV1(artifact,op.tuple.messageDigest,op.tuple.userSigner,op.tuple.sponsorPublicKey);
      requireCondition(signatures.state === "FULLY_SIGNED" && signatures.customerSignatureDigest === op.tuple.customerSignatureDigest, "Invalid completed signer artifact.");
      const reference = `sha256:${sha256(artifact)}`;
      if (row.signer_state === "RESULT_AVAILABLE") {
        requireCondition(row.artifact_reference === reference && row.final_transaction_id === signatures.finalTransactionId && row.result_artifact.equals(artifact), "Conflicting immutable signer result.");
        return op;
      }
      requireCondition(row.signer_state !== "REFUSED", "Signature conflicts with terminal refusal.");
      const changed = (await client.query(`UPDATE economic_finalizations SET signer_state='RESULT_AVAILABLE',result_artifact=$2,artifact_reference=$3,final_transaction_id=$4,updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=$1 RETURNING *`, [id,artifact,reference,signatures.finalTransactionId])).rows[0];
      await audit(client, { type: "SIGNER_RESULT_VERIFIED", actor: "signer-coordinator", finalizationId: id, reference });
      return operation(changed);
    });
  }

  /** Known signed bytes do not imply chain effect. Only the configured authoritative observer can settle accounting. */
  async settleExposure(id: string): Promise<DurableFinalization> {
    requireCondition(this.observer, "No trusted finalized-exposure observer configured.");
    const snapshot = await this.find(id);
    requireCondition(snapshot?.signerState === "RESULT_AVAILABLE", "No verified completed artifact.");
    const evidence = await this.observer.observe(snapshot);
    if (evidence.state === "UNKNOWN") return (await this.find(id))!;
    requireCondition(evidence.state === "FINALIZED" && evidence.finalizationId === id && evidence.transactionId === snapshot.finalTransactionId && sameNetworkV1(evidence.network,snapshot.tuple.network), "Exposure observation binding mismatch.");
    machineId(evidence.reference); units(evidence.base); units(evidence.priority); units(evidence.rent);
    return transaction(this.pool, async client => {
      const row = await this.lockOperation(client,id);
      if (row.exposure_state === "CONSUMED") {
        requireCondition(row.accounting_reference === evidence.reference && row.base_consumed === evidence.base && row.priority_consumed === evidence.priority && row.rent_consumed === evidence.rent, "Conflicting immutable accounting evidence.");
        return operation(row);
      }
      const changed = (await client.query(`UPDATE economic_finalizations SET exposure_state='CONSUMED',base_consumed=$2,priority_consumed=$3,rent_consumed=$4,accounting_reference=$5,updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=$1 RETURNING *`, [id,evidence.base,evidence.priority,evidence.rent,evidence.reference])).rows[0];
      await audit(client, { type: "EXPOSURE_CONSUMED", actor: "trusted-finalized-observer", finalizationId: id, reference: evidence.reference });
      return operation(changed);
    });
  }
}
