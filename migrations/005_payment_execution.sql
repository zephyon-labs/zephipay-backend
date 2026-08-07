CREATE TYPE payment_execution_status AS ENUM ('READY','SUBMITTING','PROCESSING','UNKNOWN','SETTLED','FAILED','CANCELLED');
CREATE TYPE payment_execution_operation AS ENUM ('SUBMIT','RECONCILE');

CREATE TABLE payment_executions (
  execution_id uuid PRIMARY KEY,
  payment_intent_id uuid NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  actor_subject text NOT NULL REFERENCES beta_allowlist(actor_subject),
  status payment_execution_status NOT NULL DEFAULT 'READY', version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  selected_rail text NOT NULL DEFAULT 'mock' CHECK (selected_rail='mock'),
  runtime_contract_version integer NOT NULL DEFAULT 1 CHECK (runtime_contract_version=1),
  adapter_version integer NOT NULL DEFAULT 1 CHECK (adapter_version=1),
  provider_idempotency_key text NOT NULL UNIQUE CHECK (length(provider_idempotency_key) BETWEEN 16 AND 128),
  provider_reference text, reconciliation_reference text, attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  observation_sequence integer NOT NULL DEFAULT 0 CHECK (observation_sequence >= 0), next_attempt_at timestamptz,
  last_reconciled_at timestamptz, failure_code text, failure_category text, failure_retryable boolean,
  review_reason text, settlement_evidence jsonb, lease_owner text, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL, started_at timestamptz, submitted_at timestamptz, settled_at timestamptz,
  failed_at timestamptz, cancelled_at timestamptz, updated_at timestamptz NOT NULL,
  CHECK (status <> 'SETTLED' OR (settled_at IS NOT NULL AND settlement_evidence IS NOT NULL)),
  CHECK (status <> 'FAILED' OR (failed_at IS NOT NULL AND failure_code IS NOT NULL))
);
CREATE INDEX payment_executions_work_idx ON payment_executions(status,next_attempt_at,lease_expires_at)
  WHERE status IN ('READY','SUBMITTING','PROCESSING','UNKNOWN');

CREATE TABLE payment_execution_attempts (
  attempt_id uuid PRIMARY KEY, execution_id uuid NOT NULL REFERENCES payment_executions(execution_id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0), operation payment_execution_operation NOT NULL,
  started_at timestamptz NOT NULL, completed_at timestamptz, outcome text, failure_code text, side_effect text,
  recovery_action text, evidence jsonb, UNIQUE(execution_id,attempt_number)
);
CREATE TABLE payment_execution_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, execution_id uuid NOT NULL REFERENCES payment_executions(execution_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL CHECK(sequence_number>0), event_type text NOT NULL,
  from_status payment_execution_status, to_status payment_execution_status, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL, UNIQUE(execution_id,sequence_number)
);
CREATE TRIGGER payment_execution_attempts_append_only BEFORE UPDATE OR DELETE ON payment_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER payment_execution_events_append_only BEFORE UPDATE OR DELETE ON payment_execution_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE FUNCTION protect_payment_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SETTLED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal payment executions are immutable'; END IF;
  IF NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key THEN RAISE EXCEPTION 'provider idempotency key is immutable'; END IF;
  IF OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN RAISE EXCEPTION 'provider reference is immutable'; END IF;
  IF OLD.reconciliation_reference IS NOT NULL AND NEW.reconciliation_reference IS DISTINCT FROM OLD.reconciliation_reference THEN RAISE EXCEPTION 'reconciliation reference is immutable'; END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'execution updates must increment version exactly once'; END IF;
  IF NOT ((OLD.status='READY' AND NEW.status IN ('SUBMITTING','CANCELLED')) OR
          (OLD.status='SUBMITTING' AND NEW.status IN ('PROCESSING','UNKNOWN','FAILED')) OR
          (OLD.status='PROCESSING' AND NEW.status IN ('SETTLED','UNKNOWN','FAILED')) OR
          (OLD.status='UNKNOWN' AND NEW.status IN ('PROCESSING','SETTLED','FAILED')) OR OLD.status=NEW.status) THEN
    RAISE EXCEPTION 'invalid payment execution transition % -> %',OLD.status,NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_executions_protect BEFORE UPDATE ON payment_executions FOR EACH ROW EXECUTE FUNCTION protect_payment_execution();
