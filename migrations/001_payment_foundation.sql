CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE payment_status AS ENUM (
  'AWAITING_CONFIRMATION',
  'PROCESSING',
  'UNKNOWN',
  'COMPLETED',
  'FAILED'
);

CREATE TYPE payment_event_type AS ENUM (
  'CREATED',
  'USER_CONFIRMED',
  'RUNTIME_APPROVED',
  'SUBMISSION_STARTED',
  'SIGNATURE_OBSERVED',
  'SETTLEMENT_UNKNOWN',
  'SETTLEMENT_CONFIRMED',
  'SETTLEMENT_FAILED',
  'RECEIPT_VERIFIED'
);

CREATE TYPE terminal_proof_kind AS ENUM (
  'PRE_SUBMISSION_REJECTION',
  'SOLANA_TRANSACTION_ERROR',
  'EXPIRED_UNSIGNED_TRANSACTION'
);

CREATE TABLE beta_allowlist (
  actor_subject text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  note text,
  CONSTRAINT beta_allowlist_subject_not_blank
    CHECK (length(btrim(actor_subject)) BETWEEN 1 AND 255),
  CONSTRAINT beta_allowlist_revoked_not_enabled
    CHECK (revoked_at IS NULL OR enabled = false),
  CONSTRAINT beta_allowlist_expiry_after_add
    CHECK (expires_at IS NULL OR expires_at > added_at)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_subject text NOT NULL REFERENCES beta_allowlist(actor_subject),
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  status payment_status NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
  version bigint NOT NULL DEFAULT 0,
  network text NOT NULL DEFAULT 'solana-devnet',
  rail text NOT NULL DEFAULT 'solana',
  asset text NOT NULL DEFAULT 'USDC',
  mint_address text NOT NULL,
  recipient_address text NOT NULL,
  amount_raw bigint NOT NULL,
  purpose text NOT NULL,
  runtime_id text,
  runtime_payment_id text,
  runtime_transaction_id text,
  user_confirmed_at timestamptz,
  execution_started_at timestamptz,
  submitted_at timestamptz,
  last_checked_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  solana_signature text,
  recent_blockhash text,
  submitted_slot bigint,
  confirmed_slot bigint,
  confirmation_status text,
  chain_error jsonb,
  receipt_pda text,
  failure_code text,
  failure_reason text,
  terminal_proof_kind terminal_proof_kind,
  terminal_proof jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_actor_idempotency_unique UNIQUE (actor_subject, idempotency_key),
  CONSTRAINT payments_request_hash_length CHECK (octet_length(request_hash) = 32),
  CONSTRAINT payments_idempotency_key_length CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT payments_version_nonnegative CHECK (version >= 0),
  CONSTRAINT payments_devnet_only CHECK (network = 'solana-devnet'),
  CONSTRAINT payments_solana_only CHECK (rail = 'solana'),
  CONSTRAINT payments_usdc_only CHECK (asset = 'USDC'),
  CONSTRAINT payments_amount_positive CHECK (amount_raw > 0),
  CONSTRAINT payments_purpose_length
    CHECK (octet_length(convert_to(purpose, 'UTF8')) BETWEEN 1 AND 120),
  CONSTRAINT payments_signature_unique UNIQUE (solana_signature),
  CONSTRAINT payments_receipt_pda_unique UNIQUE (receipt_pda),
  CONSTRAINT payments_confirmation_boundary
    CHECK (status = 'AWAITING_CONFIRMATION' OR user_confirmed_at IS NOT NULL OR status = 'FAILED'),
  CONSTRAINT payments_processing_started
    CHECK (status NOT IN ('PROCESSING', 'UNKNOWN', 'COMPLETED') OR execution_started_at IS NOT NULL),
  CONSTRAINT payments_completed_evidence
    CHECK (
      status <> 'COMPLETED' OR (
        completed_at IS NOT NULL AND solana_signature IS NOT NULL AND
        confirmed_slot IS NOT NULL AND receipt_pda IS NOT NULL AND chain_error IS NULL
      )
    ),
  CONSTRAINT payments_failed_evidence
    CHECK (
      status <> 'FAILED' OR (
        failed_at IS NOT NULL AND failure_code IS NOT NULL AND
        terminal_proof_kind IS NOT NULL AND terminal_proof IS NOT NULL
      )
    ),
  CONSTRAINT payments_terminal_proof_pair
    CHECK ((terminal_proof_kind IS NULL) = (terminal_proof IS NULL)),
  CONSTRAINT payments_terminal_proof_kind_matches
    CHECK (
      terminal_proof IS NULL OR
      terminal_proof->>'kind' = terminal_proof_kind::text
    ),
  CONSTRAINT payments_terminal_proof_shape
    CHECK (
      terminal_proof IS NULL OR
      (
        terminal_proof_kind = 'PRE_SUBMISSION_REJECTION' AND
        length(btrim(terminal_proof->>'code')) > 0 AND
        length(btrim(terminal_proof->>'reason')) > 0
      ) OR (
        terminal_proof_kind = 'SOLANA_TRANSACTION_ERROR' AND
        length(btrim(terminal_proof->>'signature')) > 0 AND
        terminal_proof ? 'chainError' AND
        (NOT terminal_proof ? 'slot' OR terminal_proof->>'slot' ~ '^\d+$')
      ) OR (
        terminal_proof_kind = 'EXPIRED_UNSIGNED_TRANSACTION' AND
        length(btrim(terminal_proof->>'recentBlockhash')) > 0 AND
        terminal_proof->>'lastValidBlockHeight' ~ '^\d+$' AND
        terminal_proof->'transactionWasSigned' = 'false'::jsonb AND
        terminal_proof->'submissionWasAttempted' = 'false'::jsonb
      )
    ),
  CONSTRAINT payments_terminal_exclusive
    CHECK (NOT (completed_at IS NOT NULL AND failed_at IS NOT NULL))
);

CREATE INDEX payments_actor_created_idx ON payments (actor_subject, created_at DESC);
CREATE INDEX payments_reconciliation_idx
  ON payments (status, last_checked_at)
  WHERE status IN ('PROCESSING', 'UNKNOWN');

CREATE TABLE payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  network text NOT NULL CHECK (network = 'solana-devnet'),
  program_id text NOT NULL,
  receipt_pda text NOT NULL UNIQUE,
  solana_signature text NOT NULL UNIQUE,
  slot bigint NOT NULL CHECK (slot >= 0),
  mint_address text NOT NULL,
  recipient_address text NOT NULL,
  amount_raw bigint NOT NULL CHECK (amount_raw > 0),
  onchain_reference bytea NOT NULL CHECK (octet_length(onchain_reference) = 32),
  raw_receipt jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  event_type payment_event_type NOT NULL,
  from_status payment_status,
  to_status payment_status,
  runtime_event_id text,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_event_sequence_unique UNIQUE (payment_id, sequence_number)
);

CREATE UNIQUE INDEX payment_events_runtime_event_unique
  ON payment_events (runtime_event_id)
  WHERE runtime_event_id IS NOT NULL;

CREATE UNIQUE INDEX payment_events_authoritative_once
  ON payment_events (payment_id, event_type)
  WHERE event_type IN ('SETTLEMENT_CONFIRMED', 'SETTLEMENT_FAILED', 'RECEIPT_VERIFIED');

CREATE INDEX payment_events_payment_time_idx
  ON payment_events (payment_id, occurred_at, sequence_number);

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER payment_receipts_append_only
  BEFORE UPDATE OR DELETE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE FUNCTION protect_payment_settlement_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('COMPLETED', 'FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal payment records are immutable';
  END IF;

  IF OLD.solana_signature IS NOT NULL AND NEW.solana_signature IS DISTINCT FROM OLD.solana_signature THEN
    RAISE EXCEPTION 'solana_signature is immutable once observed';
  END IF;
  IF OLD.receipt_pda IS NOT NULL AND NEW.receipt_pda IS DISTINCT FROM OLD.receipt_pda THEN
    RAISE EXCEPTION 'receipt_pda is immutable once observed';
  END IF;
  IF OLD.confirmed_slot IS NOT NULL AND NEW.confirmed_slot IS DISTINCT FROM OLD.confirmed_slot THEN
    RAISE EXCEPTION 'confirmed_slot is immutable once observed';
  END IF;
  IF OLD.submitted_slot IS NOT NULL AND NEW.submitted_slot IS DISTINCT FROM OLD.submitted_slot THEN
    RAISE EXCEPTION 'submitted_slot is immutable once observed';
  END IF;
  IF OLD.recent_blockhash IS NOT NULL AND NEW.recent_blockhash IS DISTINCT FROM OLD.recent_blockhash THEN
    RAISE EXCEPTION 'recent_blockhash is immutable once observed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_protect_settlement_evidence
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION protect_payment_settlement_evidence();

CREATE FUNCTION validate_payment_lifecycle_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    IF ROW(
      NEW.runtime_id, NEW.runtime_payment_id, NEW.runtime_transaction_id,
      NEW.user_confirmed_at, NEW.execution_started_at, NEW.submitted_at,
      NEW.last_checked_at, NEW.completed_at, NEW.failed_at,
      NEW.solana_signature, NEW.recent_blockhash, NEW.submitted_slot,
      NEW.confirmed_slot, NEW.confirmation_status, NEW.chain_error,
      NEW.receipt_pda, NEW.failure_code, NEW.failure_reason,
      NEW.terminal_proof_kind, NEW.terminal_proof
    ) IS DISTINCT FROM ROW(
      OLD.runtime_id, OLD.runtime_payment_id, OLD.runtime_transaction_id,
      OLD.user_confirmed_at, OLD.execution_started_at, OLD.submitted_at,
      OLD.last_checked_at, OLD.completed_at, OLD.failed_at,
      OLD.solana_signature, OLD.recent_blockhash, OLD.submitted_slot,
      OLD.confirmed_slot, OLD.confirmation_status, OLD.chain_error,
      OLD.receipt_pda, OLD.failure_code, OLD.failure_reason,
      OLD.terminal_proof_kind, OLD.terminal_proof
    ) THEN
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'lifecycle evidence updates must increment version exactly once';
      END IF;
    ELSIF NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'version cannot change without a lifecycle or evidence mutation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'AWAITING_CONFIRMATION' AND NEW.status IN ('PROCESSING', 'FAILED')) OR
    (OLD.status = 'PROCESSING' AND NEW.status IN ('UNKNOWN', 'COMPLETED', 'FAILED')) OR
    (OLD.status = 'UNKNOWN' AND NEW.status IN ('COMPLETED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'illegal payment lifecycle transition: % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'payment status transitions must increment version exactly once';
  END IF;

  IF NEW.status = 'FAILED' THEN
    IF OLD.status = 'AWAITING_CONFIRMATION' AND
       NEW.terminal_proof_kind <> 'PRE_SUBMISSION_REJECTION' THEN
      RAISE EXCEPTION 'AWAITING_CONFIRMATION may fail only with PRE_SUBMISSION_REJECTION proof';
    END IF;
    IF OLD.status IN ('PROCESSING', 'UNKNOWN') AND
       NEW.terminal_proof_kind = 'PRE_SUBMISSION_REJECTION' THEN
      RAISE EXCEPTION '% cannot use PRE_SUBMISSION_REJECTION proof', OLD.status;
    END IF;
  END IF;

  IF NEW.status = 'COMPLETED' AND NOT EXISTS (
    SELECT 1 FROM payment_receipts WHERE payment_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'COMPLETED requires a verified receipt in the same transaction';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_validate_lifecycle
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION validate_payment_lifecycle_transition();

CREATE FUNCTION validate_receipt_matches_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment payments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT payment FROM payments WHERE id = NEW.payment_id;
  IF NEW.network <> payment.network OR NEW.mint_address <> payment.mint_address OR
     NEW.recipient_address <> payment.recipient_address OR
     NEW.amount_raw <> payment.amount_raw OR
     NEW.solana_signature <> payment.solana_signature OR
     NEW.receipt_pda <> payment.receipt_pda THEN
    RAISE EXCEPTION 'receipt settlement evidence does not match payment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_receipts_match_payment
  AFTER INSERT ON payment_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_receipt_matches_payment();

CREATE FUNCTION validate_authoritative_payment_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment payments%ROWTYPE;
BEGIN
  IF NEW.event_type NOT IN ('SETTLEMENT_CONFIRMED', 'SETTLEMENT_FAILED', 'RECEIPT_VERIFIED') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO STRICT payment FROM payments WHERE id = NEW.payment_id;
  IF NEW.event_type = 'SETTLEMENT_CONFIRMED' AND NOT (
    payment.status IN ('PROCESSING', 'UNKNOWN') AND
    payment.solana_signature IS NOT NULL AND payment.confirmed_slot IS NOT NULL AND
    NEW.from_status = payment.status AND NEW.to_status = payment.status
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_CONFIRMED requires matching confirmation evidence';
  END IF;
  IF NEW.event_type = 'SETTLEMENT_FAILED' AND NOT (
    payment.status = 'FAILED' AND payment.terminal_proof IS NOT NULL AND
    NEW.to_status = 'FAILED' AND NEW.details ? 'terminalProof'
  ) THEN
    RAISE EXCEPTION 'SETTLEMENT_FAILED requires persisted terminal proof';
  END IF;
  IF NEW.event_type = 'RECEIPT_VERIFIED' AND NOT (
    payment.status = 'COMPLETED' AND NEW.to_status = 'COMPLETED' AND
    EXISTS (SELECT 1 FROM payment_receipts WHERE payment_id = NEW.payment_id)
  ) THEN
    RAISE EXCEPTION 'RECEIPT_VERIFIED requires atomic payment completion and receipt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_events_authoritative_guard
  AFTER INSERT ON payment_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_authoritative_payment_event();

CREATE FUNCTION validate_payment_transition_artifacts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'AWAITING_CONFIRMATION' AND NEW.status = 'PROCESSING' AND NOT EXISTS (
    SELECT 1 FROM payment_events
    WHERE payment_id = NEW.id AND event_type = 'USER_CONFIRMED'
      AND from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'PROCESSING requires an atomic USER_CONFIRMED event';
  END IF;
  IF OLD.status = 'PROCESSING' AND NEW.status = 'UNKNOWN' AND NOT EXISTS (
    SELECT 1 FROM payment_events
    WHERE payment_id = NEW.id AND event_type = 'SETTLEMENT_UNKNOWN'
      AND from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'UNKNOWN requires an atomic SETTLEMENT_UNKNOWN event';
  END IF;
  IF NEW.status = 'COMPLETED' AND NOT (
    EXISTS (SELECT 1 FROM payment_receipts WHERE payment_id = NEW.id) AND
    EXISTS (
      SELECT 1 FROM payment_events
      WHERE payment_id = NEW.id AND event_type = 'RECEIPT_VERIFIED'
    )
  ) THEN
    RAISE EXCEPTION 'COMPLETED requires an atomic receipt and RECEIPT_VERIFIED event';
  END IF;
  IF NEW.status = 'FAILED' AND NOT EXISTS (
    SELECT 1 FROM payment_events
    WHERE payment_id = NEW.id AND event_type = 'SETTLEMENT_FAILED'
  ) THEN
    RAISE EXCEPTION 'FAILED requires an atomic SETTLEMENT_FAILED event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER payments_terminal_artifacts_guard
  AFTER UPDATE ON payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payment_transition_artifacts();
