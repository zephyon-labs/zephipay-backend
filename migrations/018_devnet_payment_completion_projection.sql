ALTER TABLE payments
  ADD COLUMN execution_receipt_id text;

ALTER TABLE payments
  ADD CONSTRAINT payments_execution_receipt_fk
  FOREIGN KEY (execution_receipt_id)
  REFERENCES payment_execution_receipts(receipt_id)
  ON DELETE RESTRICT;

ALTER TABLE payments
  DROP CONSTRAINT payments_completed_evidence;

ALTER TABLE payments
  ADD CONSTRAINT payments_completed_evidence
  CHECK (
    status <> 'COMPLETED' OR (
      completed_at IS NOT NULL AND solana_signature IS NOT NULL AND
      confirmed_slot IS NOT NULL AND chain_error IS NULL AND (
        receipt_pda IS NOT NULL OR execution_receipt_id IS NOT NULL
      )
    )
  );

CREATE FUNCTION validate_execution_receipt_payment_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'COMPLETED' AND NEW.execution_receipt_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM payment_execution_receipts r
      JOIN payment_executions e ON e.execution_id = r.execution_id
      JOIN devnet_execution_preparations p ON p.execution_id = e.execution_id
      WHERE r.receipt_id = NEW.execution_receipt_id
        AND r.payment_intent_id = NEW.id
        AND r.actor_subject = NEW.actor_subject
        AND e.payment_intent_id = NEW.id
        AND e.actor_subject = NEW.actor_subject
        AND e.status = 'SETTLED'
        AND e.settled_at IS NOT NULL
        AND p.lifecycle_state = 'SETTLED'
        AND r.rail = 'solana'
        AND r.evidence_type = 'solana.signature'
        AND r.provider_reference = NEW.solana_signature
        AND p.transaction_signature = NEW.solana_signature
        AND r.settled_at = NEW.completed_at
        AND r.evidence->>'network' = 'solana-devnet'
        AND r.evidence->>'signature' = NEW.solana_signature
        AND EXISTS (
          SELECT 1 FROM devnet_reconciliation_observations o
          WHERE o.execution_id = e.execution_id
            AND o.preparation_id = p.preparation_id
            AND o.outcome = 'SETTLED'
            AND o.confirmation_status = 'finalized'
            AND o.slot = NEW.confirmed_slot
        )
    ) THEN
      RAISE EXCEPTION 'COMPLETED Devnet payment requires its canonical settled execution receipt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_execution_receipt_completion_guard
  BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION validate_execution_receipt_payment_completion();

CREATE OR REPLACE FUNCTION validate_payment_lifecycle_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    IF ROW(
      NEW.runtime_id, NEW.runtime_payment_id, NEW.runtime_transaction_id,
      NEW.user_confirmed_at, NEW.execution_started_at, NEW.submitted_at,
      NEW.last_checked_at, NEW.completed_at, NEW.failed_at,
      NEW.solana_signature, NEW.recent_blockhash, NEW.submitted_slot,
      NEW.confirmed_slot, NEW.confirmation_status, NEW.chain_error,
      NEW.receipt_pda, NEW.execution_receipt_id, NEW.failure_code, NEW.failure_reason,
      NEW.terminal_proof_kind, NEW.terminal_proof
    ) IS DISTINCT FROM ROW(
      OLD.runtime_id, OLD.runtime_payment_id, OLD.runtime_transaction_id,
      OLD.user_confirmed_at, OLD.execution_started_at, OLD.submitted_at,
      OLD.last_checked_at, OLD.completed_at, OLD.failed_at,
      OLD.solana_signature, OLD.recent_blockhash, OLD.submitted_slot,
      OLD.confirmed_slot, OLD.confirmation_status, OLD.chain_error,
      OLD.receipt_pda, OLD.execution_receipt_id, OLD.failure_code, OLD.failure_reason,
      OLD.terminal_proof_kind, OLD.terminal_proof
    ) THEN
      IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'lifecycle evidence updates must increment version exactly once'; END IF;
    ELSIF NEW.version <> OLD.version THEN RAISE EXCEPTION 'version cannot change without a lifecycle or evidence mutation'; END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'AWAITING_CONFIRMATION' AND NEW.status IN ('PROCESSING', 'FAILED')) OR
    (OLD.status = 'PROCESSING' AND NEW.status IN ('UNKNOWN', 'COMPLETED', 'FAILED')) OR
    (OLD.status = 'UNKNOWN' AND NEW.status IN ('COMPLETED', 'FAILED'))
  ) THEN RAISE EXCEPTION 'illegal payment lifecycle transition: % -> %', OLD.status, NEW.status; END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'payment status transitions must increment version exactly once'; END IF;
  IF NEW.status = 'FAILED' THEN
    IF OLD.status = 'AWAITING_CONFIRMATION' AND NEW.terminal_proof_kind <> 'PRE_SUBMISSION_REJECTION' THEN RAISE EXCEPTION 'AWAITING_CONFIRMATION may fail only with PRE_SUBMISSION_REJECTION proof'; END IF;
    IF OLD.status IN ('PROCESSING', 'UNKNOWN') AND NEW.terminal_proof_kind = 'PRE_SUBMISSION_REJECTION' THEN RAISE EXCEPTION '% cannot use PRE_SUBMISSION_REJECTION proof', OLD.status; END IF;
  END IF;
  IF NEW.status = 'COMPLETED' AND NOT (
    EXISTS (SELECT 1 FROM payment_receipts WHERE payment_id = NEW.id) OR
    EXISTS (SELECT 1 FROM payment_execution_receipts WHERE receipt_id = NEW.execution_receipt_id AND payment_intent_id = NEW.id)
  ) THEN RAISE EXCEPTION 'COMPLETED requires a verified receipt in the same transaction'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_authoritative_payment_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE payment payments%ROWTYPE;
BEGIN
  IF NEW.event_type NOT IN ('SETTLEMENT_CONFIRMED', 'SETTLEMENT_FAILED', 'RECEIPT_VERIFIED') THEN RETURN NEW; END IF;
  SELECT * INTO STRICT payment FROM payments WHERE id = NEW.payment_id;
  IF NEW.event_type = 'SETTLEMENT_CONFIRMED' AND NOT (
    (payment.status IN ('PROCESSING', 'UNKNOWN') AND payment.solana_signature IS NOT NULL AND payment.confirmed_slot IS NOT NULL AND NEW.from_status = payment.status AND NEW.to_status = payment.status) OR
    (payment.status = 'COMPLETED' AND payment.execution_receipt_id IS NOT NULL AND NEW.to_status = 'COMPLETED' AND EXISTS (SELECT 1 FROM payment_execution_receipts WHERE receipt_id=payment.execution_receipt_id AND payment_intent_id=payment.id))
  ) THEN RAISE EXCEPTION 'SETTLEMENT_CONFIRMED requires matching confirmation evidence'; END IF;
  IF NEW.event_type = 'SETTLEMENT_FAILED' AND NOT (payment.status = 'FAILED' AND payment.terminal_proof IS NOT NULL AND NEW.to_status = 'FAILED' AND NEW.details ? 'terminalProof') THEN RAISE EXCEPTION 'SETTLEMENT_FAILED requires persisted terminal proof'; END IF;
  IF NEW.event_type = 'RECEIPT_VERIFIED' AND NOT (payment.status = 'COMPLETED' AND NEW.to_status = 'COMPLETED' AND EXISTS (SELECT 1 FROM payment_receipts WHERE payment_id = NEW.payment_id)) THEN RAISE EXCEPTION 'RECEIPT_VERIFIED requires atomic payment completion and receipt'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payment_transition_artifacts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'AWAITING_CONFIRMATION' AND NEW.status = 'PROCESSING' AND NOT EXISTS (SELECT 1 FROM payment_events WHERE payment_id=NEW.id AND event_type='USER_CONFIRMED' AND from_status=OLD.status AND to_status=NEW.status) THEN RAISE EXCEPTION 'PROCESSING requires an atomic USER_CONFIRMED event'; END IF;
  IF OLD.status = 'PROCESSING' AND NEW.status = 'UNKNOWN' AND NOT EXISTS (SELECT 1 FROM payment_events WHERE payment_id=NEW.id AND event_type='SETTLEMENT_UNKNOWN' AND from_status=OLD.status AND to_status=NEW.status) THEN RAISE EXCEPTION 'UNKNOWN requires an atomic SETTLEMENT_UNKNOWN event'; END IF;
  IF NEW.status = 'COMPLETED' AND NOT (
    (EXISTS (SELECT 1 FROM payment_receipts WHERE payment_id=NEW.id) AND EXISTS (SELECT 1 FROM payment_events WHERE payment_id=NEW.id AND event_type='RECEIPT_VERIFIED')) OR
    (EXISTS (SELECT 1 FROM payment_execution_receipts WHERE receipt_id=NEW.execution_receipt_id AND payment_intent_id=NEW.id) AND EXISTS (SELECT 1 FROM payment_events WHERE payment_id=NEW.id AND event_type='SETTLEMENT_CONFIRMED' AND to_status='COMPLETED'))
  ) THEN RAISE EXCEPTION 'COMPLETED requires an atomic receipt and authoritative completion event'; END IF;
  IF NEW.status = 'FAILED' AND NOT EXISTS (SELECT 1 FROM payment_events WHERE payment_id=NEW.id AND event_type='SETTLEMENT_FAILED') THEN RAISE EXCEPTION 'FAILED requires an atomic SETTLEMENT_FAILED event'; END IF;
  RETURN NEW;
END;
$$;
