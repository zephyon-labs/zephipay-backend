ALTER TABLE devnet_reconciliation_observations
  ADD COLUMN transaction_signature text;

ALTER TABLE devnet_reconciliation_observations
  ADD CONSTRAINT devnet_reconciliation_signature_shape
  CHECK (
    transaction_signature IS NULL OR (
      transaction_signature = btrim(transaction_signature)
      AND length(transaction_signature) BETWEEN 1 AND 256
    )
  );

CREATE FUNCTION validate_devnet_finalized_reconciliation_truth() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prepared devnet_execution_preparations%ROWTYPE;
  commitment devnet_submission_commitments%ROWTYPE;
BEGIN
  SELECT * INTO prepared
  FROM devnet_execution_preparations
  WHERE preparation_id = NEW.preparation_id
    AND execution_id = NEW.execution_id;

  SELECT * INTO commitment
  FROM devnet_submission_commitments
  WHERE preparation_id = NEW.preparation_id
    AND execution_id = NEW.execution_id;

  IF prepared.preparation_id IS NULL
    OR commitment.commitment_id IS NULL
    OR NEW.provider_id <> prepared.reconciliation_provider_id
    OR prepared.submission_provider_id = prepared.reconciliation_provider_id
    OR NEW.transaction_signature IS NULL
    OR NEW.transaction_signature <> prepared.transaction_signature
    OR NEW.transaction_signature <> commitment.transaction_signature
    OR NEW.observed_at < commitment.committed_at
  THEN
    RAISE EXCEPTION 'Reconciliation observation does not match the immutable commitment and provider policy';
  END IF;

  IF NEW.outcome IN ('SETTLED','FAILED') AND (
    NEW.confirmation_status IS DISTINCT FROM 'finalized'
    OR NEW.slot IS NULL
    OR (NEW.outcome = 'FAILED' AND NEW.error_code IS DISTINCT FROM 'PROVIDER_REPORTED_FAILURE')
  ) THEN
    RAISE EXCEPTION 'Terminal reconciliation requires finalized exact-signature chain evidence';
  END IF;

  IF NEW.outcome NOT IN ('SETTLED','FAILED')
    AND NEW.confirmation_status = 'finalized'
  THEN
    RAISE EXCEPTION 'Finalized reconciliation evidence must be represented as terminal truth';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER devnet_finalized_reconciliation_truth_guard
  BEFORE INSERT OR UPDATE ON devnet_reconciliation_observations
  FOR EACH ROW EXECUTE FUNCTION validate_devnet_finalized_reconciliation_truth();

CREATE OR REPLACE FUNCTION protect_devnet_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Devnet preparations cannot be deleted'; END IF;
  IF ROW(NEW.preparation_id,NEW.execution_id,NEW.payment_intent_id,NEW.actor_subject,NEW.generation,NEW.encryption_algorithm,NEW.encryption_key_version,NEW.encryption_iv,NEW.encryption_auth_tag,NEW.signed_transaction_ciphertext,NEW.signed_transaction_digest,NEW.transaction_signature,NEW.source_token_account,NEW.mint_address,NEW.destination_address,NEW.amount_units,NEW.amount_decimals,NEW.recent_blockhash,NEW.last_valid_block_height,NEW.signer_key_id,NEW.signer_key_version,NEW.signer_public_key,NEW.policy_hash,NEW.submission_provider_id,NEW.reconciliation_provider_id,NEW.prepared_at) IS DISTINCT FROM ROW(OLD.preparation_id,OLD.execution_id,OLD.payment_intent_id,OLD.actor_subject,OLD.generation,OLD.encryption_algorithm,OLD.encryption_key_version,OLD.encryption_iv,OLD.encryption_auth_tag,OLD.signed_transaction_ciphertext,OLD.signed_transaction_digest,OLD.transaction_signature,OLD.source_token_account,OLD.mint_address,OLD.destination_address,OLD.amount_units,OLD.amount_decimals,OLD.recent_blockhash,OLD.last_valid_block_height,OLD.signer_key_id,OLD.signer_key_version,OLD.signer_public_key,OLD.policy_hash,OLD.submission_provider_id,OLD.reconciliation_provider_id,OLD.prepared_at) THEN RAISE EXCEPTION 'Devnet prepared economic artifact is immutable'; END IF;
  IF NOT ((OLD.lifecycle_state='PREPARED_NOT_CONTACTED' AND NEW.lifecycle_state IN ('ABANDONED_PRE_CONTACT','SUBMISSION_COMMITTED_RECONCILE_ONLY')) OR (OLD.lifecycle_state='SUBMISSION_COMMITTED_RECONCILE_ONLY' AND NEW.lifecycle_state IN ('ACCEPTED_PENDING','UNKNOWN_RECONCILIATION_REQUIRED','SETTLED','FAILED')) OR (OLD.lifecycle_state='ACCEPTED_PENDING' AND NEW.lifecycle_state IN ('UNKNOWN_RECONCILIATION_REQUIRED','SETTLED','FAILED')) OR (OLD.lifecycle_state='UNKNOWN_RECONCILIATION_REQUIRED' AND NEW.lifecycle_state IN ('ACCEPTED_PENDING','SETTLED','FAILED')) OR OLD.lifecycle_state=NEW.lifecycle_state) THEN RAISE EXCEPTION 'Invalid Devnet lifecycle transition'; END IF;
  IF NEW.lifecycle_state='FAILED' AND OLD.lifecycle_state<>'FAILED' AND NOT (
    EXISTS (
      SELECT 1 FROM devnet_submission_observations s
      WHERE s.execution_id=NEW.execution_id
        AND s.preparation_id=NEW.preparation_id
        AND s.outcome='REJECTED'
    ) OR EXISTS (
      SELECT 1
      FROM devnet_reconciliation_observations r
      JOIN devnet_submission_commitments c
        ON c.execution_id=r.execution_id
       AND c.preparation_id=r.preparation_id
      WHERE r.execution_id=NEW.execution_id
        AND r.preparation_id=NEW.preparation_id
        AND r.provider_id=NEW.reconciliation_provider_id
        AND r.transaction_signature=NEW.transaction_signature
        AND r.transaction_signature=c.transaction_signature
        AND r.outcome='FAILED'
        AND r.confirmation_status='finalized'
        AND r.slot IS NOT NULL
        AND r.error_code='PROVIDER_REPORTED_FAILURE'
    )
  ) THEN RAISE EXCEPTION 'FAILED Devnet lifecycle requires durable terminal evidence'; END IF;
  RETURN NEW;
END $$;
