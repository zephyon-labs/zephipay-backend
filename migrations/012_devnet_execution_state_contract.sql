CREATE TYPE payment_execution_mode AS ENUM ('mock_beta','devnet_validation');
CREATE TYPE devnet_execution_lifecycle AS ENUM (
  'PREPARED_NOT_CONTACTED','SUBMISSION_COMMITTED_RECONCILE_ONLY','ACCEPTED_PENDING',
  'UNKNOWN_RECONCILIATION_REQUIRED','SETTLED','FAILED','ABANDONED_PRE_CONTACT'
);

ALTER TABLE payment_executions DROP CONSTRAINT payment_executions_selected_rail_check;
ALTER TABLE payment_executions ALTER COLUMN selected_rail DROP DEFAULT;
ALTER TABLE payment_executions ALTER COLUMN selected_rail SET DEFAULT 'mock';
ALTER TABLE payment_executions ADD CONSTRAINT payment_executions_selected_rail_check CHECK (selected_rail IN ('mock','solana'));
ALTER TABLE payment_executions ADD COLUMN execution_mode payment_execution_mode NOT NULL DEFAULT 'mock_beta';
ALTER TABLE payment_executions ADD COLUMN settlement_network text NOT NULL DEFAULT 'simulated';
ALTER TABLE payment_executions ADD COLUMN policy_hash bytea;
ALTER TABLE payment_executions ADD CONSTRAINT payment_executions_mode_shape CHECK (
  (execution_mode='mock_beta' AND selected_rail='mock' AND settlement_network='simulated' AND policy_hash IS NULL) OR
  (execution_mode='devnet_validation' AND selected_rail='solana' AND settlement_network='solana-devnet' AND octet_length(policy_hash)=32)
);

CREATE OR REPLACE FUNCTION protect_payment_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SETTLED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal payment executions are immutable'; END IF;
  IF ROW(NEW.execution_mode,NEW.selected_rail,NEW.settlement_network,NEW.policy_hash) IS DISTINCT FROM ROW(OLD.execution_mode,OLD.selected_rail,OLD.settlement_network,OLD.policy_hash) THEN RAISE EXCEPTION 'execution mode, rail, network, and policy are immutable'; END IF;
  IF NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key THEN RAISE EXCEPTION 'provider idempotency key is immutable'; END IF;
  IF OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN RAISE EXCEPTION 'provider reference is immutable'; END IF;
  IF OLD.reconciliation_reference IS NOT NULL AND NEW.reconciliation_reference IS DISTINCT FROM OLD.reconciliation_reference THEN RAISE EXCEPTION 'reconciliation reference is immutable'; END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'execution updates must increment version exactly once'; END IF;
  IF NOT ((OLD.status='READY' AND NEW.status IN ('SUBMITTING','CANCELLED')) OR (OLD.status='SUBMITTING' AND NEW.status IN ('PROCESSING','UNKNOWN','FAILED')) OR (OLD.status='PROCESSING' AND NEW.status IN ('SETTLED','UNKNOWN','FAILED')) OR (OLD.status='UNKNOWN' AND NEW.status IN ('PROCESSING','SETTLED','FAILED')) OR OLD.status=NEW.status) THEN RAISE EXCEPTION 'invalid payment execution transition % -> %',OLD.status,NEW.status; END IF;
  RETURN NEW;
END $$;

CREATE TABLE devnet_execution_preparations (
  preparation_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL,
  payment_intent_id uuid NOT NULL,
  actor_subject text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  lifecycle_state devnet_execution_lifecycle NOT NULL DEFAULT 'PREPARED_NOT_CONTACTED',
  encryption_algorithm text NOT NULL CHECK (encryption_algorithm='aes-256-gcm'),
  encryption_key_version text NOT NULL CHECK (length(btrim(encryption_key_version)) > 0 AND encryption_key_version=btrim(encryption_key_version)),
  encryption_iv bytea NOT NULL CHECK (octet_length(encryption_iv)=12),
  encryption_auth_tag bytea NOT NULL CHECK (octet_length(encryption_auth_tag)=16),
  signed_transaction_ciphertext bytea NOT NULL CHECK (octet_length(signed_transaction_ciphertext)>0),
  signed_transaction_digest bytea NOT NULL UNIQUE CHECK (octet_length(signed_transaction_digest)=32),
  transaction_signature text NOT NULL UNIQUE CHECK (length(btrim(transaction_signature))>0 AND transaction_signature=btrim(transaction_signature)),
  source_token_account text NOT NULL, mint_address text NOT NULL, destination_address text NOT NULL,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units>0), amount_decimals integer NOT NULL CHECK (amount_decimals BETWEEN 0 AND 255),
  recent_blockhash text NOT NULL, last_valid_block_height numeric(78,0) NOT NULL CHECK(last_valid_block_height>=0),
  signer_key_id text NOT NULL, signer_key_version text NOT NULL, signer_public_key text NOT NULL,
  policy_hash bytea NOT NULL CHECK(octet_length(policy_hash)=32),
  submission_provider_id text NOT NULL, reconciliation_provider_id text NOT NULL,
  prepared_at timestamptz NOT NULL, abandoned_at timestamptz, committed_at timestamptz,
  UNIQUE(execution_id,generation),
  FOREIGN KEY(execution_id,payment_intent_id,actor_subject) REFERENCES payment_executions(execution_id,payment_intent_id,actor_subject) ON DELETE RESTRICT,
  CHECK(submission_provider_id=btrim(submission_provider_id) AND length(submission_provider_id)>0),
  CHECK(reconciliation_provider_id=btrim(reconciliation_provider_id) AND length(reconciliation_provider_id)>0),
  CHECK(submission_provider_id<>reconciliation_provider_id),
  CHECK((lifecycle_state='ABANDONED_PRE_CONTACT')=(abandoned_at IS NOT NULL)),
  CHECK((lifecycle_state IN ('SUBMISSION_COMMITTED_RECONCILE_ONLY','ACCEPTED_PENDING','UNKNOWN_RECONCILIATION_REQUIRED','SETTLED','FAILED'))=(committed_at IS NOT NULL))
);
CREATE UNIQUE INDEX devnet_execution_one_active_preparation ON devnet_execution_preparations(execution_id)
  WHERE lifecycle_state<>'ABANDONED_PRE_CONTACT';
CREATE INDEX devnet_execution_preparation_work ON devnet_execution_preparations(lifecycle_state,prepared_at,execution_id);

CREATE TABLE devnet_submission_commitments (
  commitment_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL UNIQUE,
  preparation_id uuid NOT NULL UNIQUE REFERENCES devnet_execution_preparations(preparation_id) ON DELETE RESTRICT,
  transaction_signature text NOT NULL UNIQUE,
  signed_transaction_digest bytea NOT NULL UNIQUE CHECK(octet_length(signed_transaction_digest)=32),
  committed_at timestamptz NOT NULL,
  FOREIGN KEY(execution_id) REFERENCES payment_executions(execution_id) ON DELETE RESTRICT
);
CREATE TRIGGER devnet_submission_commitments_append_only BEFORE UPDATE OR DELETE ON devnet_submission_commitments
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE FUNCTION protect_devnet_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Devnet preparations cannot be deleted'; END IF;
  IF ROW(NEW.preparation_id,NEW.execution_id,NEW.payment_intent_id,NEW.actor_subject,NEW.generation,NEW.encryption_algorithm,NEW.encryption_key_version,NEW.encryption_iv,NEW.encryption_auth_tag,NEW.signed_transaction_ciphertext,NEW.signed_transaction_digest,NEW.transaction_signature,NEW.source_token_account,NEW.mint_address,NEW.destination_address,NEW.amount_units,NEW.amount_decimals,NEW.recent_blockhash,NEW.last_valid_block_height,NEW.signer_key_id,NEW.signer_key_version,NEW.signer_public_key,NEW.policy_hash,NEW.submission_provider_id,NEW.reconciliation_provider_id,NEW.prepared_at) IS DISTINCT FROM ROW(OLD.preparation_id,OLD.execution_id,OLD.payment_intent_id,OLD.actor_subject,OLD.generation,OLD.encryption_algorithm,OLD.encryption_key_version,OLD.encryption_iv,OLD.encryption_auth_tag,OLD.signed_transaction_ciphertext,OLD.signed_transaction_digest,OLD.transaction_signature,OLD.source_token_account,OLD.mint_address,OLD.destination_address,OLD.amount_units,OLD.amount_decimals,OLD.recent_blockhash,OLD.last_valid_block_height,OLD.signer_key_id,OLD.signer_key_version,OLD.signer_public_key,OLD.policy_hash,OLD.submission_provider_id,OLD.reconciliation_provider_id,OLD.prepared_at) THEN RAISE EXCEPTION 'Devnet prepared economic artifact is immutable'; END IF;
  IF NOT ((OLD.lifecycle_state='PREPARED_NOT_CONTACTED' AND NEW.lifecycle_state IN ('ABANDONED_PRE_CONTACT','SUBMISSION_COMMITTED_RECONCILE_ONLY')) OR (OLD.lifecycle_state='SUBMISSION_COMMITTED_RECONCILE_ONLY' AND NEW.lifecycle_state IN ('ACCEPTED_PENDING','UNKNOWN_RECONCILIATION_REQUIRED','SETTLED','FAILED')) OR (OLD.lifecycle_state='ACCEPTED_PENDING' AND NEW.lifecycle_state IN ('UNKNOWN_RECONCILIATION_REQUIRED','SETTLED','FAILED')) OR (OLD.lifecycle_state='UNKNOWN_RECONCILIATION_REQUIRED' AND NEW.lifecycle_state IN ('ACCEPTED_PENDING','SETTLED','FAILED')) OR OLD.lifecycle_state=NEW.lifecycle_state) THEN RAISE EXCEPTION 'Invalid Devnet lifecycle transition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devnet_execution_preparations_protect BEFORE UPDATE OR DELETE ON devnet_execution_preparations
  FOR EACH ROW EXECUTE FUNCTION protect_devnet_preparation();
