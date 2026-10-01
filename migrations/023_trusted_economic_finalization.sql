-- Disconnected economic foundation. No existing payment/Devnet tables are migrated onto this flow.
CREATE TABLE economic_network_registry (
  registry_id text PRIMARY KEY,
  version text NOT NULL,
  identity jsonb NOT NULL UNIQUE,
  genesis_hash text NOT NULL UNIQUE,
  effective_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (identity->>'genesisHash' = genesis_hash),
  CHECK (identity->>'family' = 'solana'),
  CHECK (revoked_at IS NULL OR revoked_at >= effective_at)
);
CREATE TABLE economic_asset_registry (
  registry_id text PRIMARY KEY,
  network_id text NOT NULL REFERENCES economic_network_registry,
  version text NOT NULL,
  identity jsonb NOT NULL,
  use_role text NOT NULL CHECK (use_role IN ('PAYMENT','FEE')),
  effective_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (identity, use_role),
  CHECK (revoked_at IS NULL OR revoked_at >= effective_at)
);
CREATE TABLE economic_attempt_heads (
  intent_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES accounts(actor_subject),
  current_generation numeric(20,0) NOT NULL CHECK (current_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE economic_attempts (
  intent_id text NOT NULL REFERENCES economic_attempt_heads,
  generation numeric(20,0) NOT NULL CHECK (generation > 0),
  attempt_id text NOT NULL UNIQUE,
  fence_token text NOT NULL UNIQUE,
  envelope_digest text NOT NULL UNIQUE CHECK (envelope_digest ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL,
  message_digest text NOT NULL CHECK (message_digest ~ '^[a-f0-9]{64}$'),
  recent_blockhash text NOT NULL,
  requested_exposure_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','CANCELLED','FINALIZATION_COMMITTED')),
  finalization_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, generation),
  CHECK ((state = 'FINALIZATION_COMMITTED') = (finalization_id IS NOT NULL)),
  CHECK (envelope->'attempt'->>'intentId' = intent_id),
  CHECK ((envelope->'attempt'->>'generation')::numeric = generation),
  CHECK (envelope->'attempt'->>'attemptId' = attempt_id),
  CHECK (envelope->'attempt'->>'fenceToken' = fence_token)
);
ALTER TABLE economic_attempt_heads ADD CONSTRAINT economic_current_attempt_fk
  FOREIGN KEY (intent_id, current_generation) REFERENCES economic_attempts(intent_id,generation)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE economic_consent_evidence (
  consent_id uuid PRIMARY KEY,
  envelope_digest text NOT NULL REFERENCES economic_attempts(envelope_digest),
  principal_id text NOT NULL REFERENCES accounts(actor_subject),
  issuer text NOT NULL,
  audience text NOT NULL,
  context text NOT NULL CHECK (context = 'zephipay-economic-consent-v1'),
  provider_subject text NOT NULL,
  authentication_reference text NOT NULL CHECK (authentication_reference ~ '^[a-f0-9]{64}$'),
  session_reference text,
  authenticated_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > confirmed_at),
  CHECK (authenticated_at <= confirmed_at),
  CHECK (revoked_at IS NULL OR revoked_at >= confirmed_at)
);
CREATE TABLE economic_runtime_evidence (
  decision_id text PRIMARY KEY,
  envelope_digest text NOT NULL REFERENCES economic_attempts(envelope_digest),
  issuer text NOT NULL,
  policy_version text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  binding jsonb NOT NULL,
  network jsonb NOT NULL,
  scope text NOT NULL CHECK (scope IN ('production','devnet-test-only')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (valid_until > valid_from),
  CHECK (revoked_at IS NULL OR revoked_at >= valid_from)
);

CREATE TABLE economic_sponsor_budgets (
  budget_id text PRIMARY KEY,
  network jsonb NOT NULL,
  sponsor_public_key text NOT NULL,
  sponsor_key_version text NOT NULL,
  base_limit numeric(20,0) NOT NULL CHECK (base_limit >= 0),
  priority_limit numeric(20,0) NOT NULL CHECK (priority_limit >= 0),
  rent_limit numeric(20,0) NOT NULL CHECK (rent_limit >= 0),
  outstanding_limit integer NOT NULL CHECK (outstanding_limit > 0),
  UNIQUE (network, sponsor_public_key, sponsor_key_version)
);
CREATE TABLE economic_finalizations (
  finalization_id uuid PRIMARY KEY,
  intent_id text NOT NULL,
  generation numeric(20,0) NOT NULL,
  tuple jsonb NOT NULL,
  tuple_digest text NOT NULL CHECK (tuple_digest ~ '^[a-f0-9]{64}$'),
  consent_id uuid NOT NULL REFERENCES economic_consent_evidence,
  runtime_id text NOT NULL REFERENCES economic_runtime_evidence,
  payment_registry_id text NOT NULL REFERENCES economic_asset_registry,
  fee_registry_id text NOT NULL REFERENCES economic_asset_registry,
  budget_id text NOT NULL REFERENCES economic_sponsor_budgets,
  exposure_id uuid NOT NULL UNIQUE,
  base_requested numeric(20,0) NOT NULL CHECK (base_requested >= 0),
  priority_requested numeric(20,0) NOT NULL CHECK (priority_requested >= 0),
  rent_requested numeric(20,0) NOT NULL CHECK (rent_requested >= 0),
  exposure_state text NOT NULL DEFAULT 'RESERVED' CHECK (exposure_state IN ('RESERVED','UNCERTAIN','RELEASED','CONSUMED')),
  base_consumed numeric(20,0), priority_consumed numeric(20,0), rent_consumed numeric(20,0),
  accounting_reference text,
  signer_operation_id uuid NOT NULL UNIQUE,
  signer_state text NOT NULL DEFAULT 'NOT_CONTACTED' CHECK (signer_state IN ('NOT_CONTACTED','CONTACT_COMMITTED','RESULT_UNKNOWN','REFUSED','RESULT_AVAILABLE')),
  customer_artifact bytea NOT NULL CHECK (octet_length(customer_artifact) BETWEEN 1 AND 1232),
  result_artifact bytea CHECK (octet_length(result_artifact) BETWEEN 1 AND 1232),
  artifact_reference text,
  final_transaction_id text,
  refusal_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (intent_id,generation),
  FOREIGN KEY (intent_id,generation) REFERENCES economic_attempts,
  CHECK ((signer_state = 'RESULT_AVAILABLE' AND result_artifact IS NOT NULL AND artifact_reference IS NOT NULL AND final_transaction_id IS NOT NULL) OR
    (signer_state <> 'RESULT_AVAILABLE' AND result_artifact IS NULL AND artifact_reference IS NULL AND final_transaction_id IS NULL)),
  CHECK (signer_state <> 'RESULT_AVAILABLE' OR exposure_state IN ('UNCERTAIN','CONSUMED')),
  CHECK ((signer_state = 'REFUSED') = (refusal_reference IS NOT NULL)),
  CHECK (exposure_state <> 'RELEASED' OR signer_state = 'REFUSED'),
  CHECK (signer_state <> 'REFUSED' OR exposure_state = 'RELEASED'),
  CHECK (signer_state NOT IN ('CONTACT_COMMITTED','RESULT_UNKNOWN') OR exposure_state = 'UNCERTAIN'),
  CHECK (signer_state <> 'NOT_CONTACTED' OR exposure_state = 'RESERVED'),
  CHECK ((exposure_state = 'CONSUMED') = (accounting_reference IS NOT NULL)),
  CHECK (exposure_state = 'CONSUMED' OR (base_consumed IS NULL AND priority_consumed IS NULL AND rent_consumed IS NULL)),
  CHECK (exposure_state <> 'CONSUMED' OR (signer_state = 'RESULT_AVAILABLE' AND
    base_consumed IS NOT NULL AND priority_consumed IS NOT NULL AND rent_consumed IS NOT NULL AND
    base_consumed BETWEEN 0 AND base_requested AND priority_consumed BETWEEN 0 AND priority_requested AND rent_consumed BETWEEN 0 AND rent_requested)),
  CHECK (tuple->'attempt'->>'intentId' = intent_id),
  CHECK ((tuple->'attempt'->>'generation')::numeric = generation),
  CHECK (tuple->>'consentId' = consent_id::text),
  CHECK (tuple->'runtime'->>'decisionId' = runtime_id),
  CHECK (tuple->>'reservedExposureId' = exposure_id::text)
);
ALTER TABLE economic_attempts ADD CONSTRAINT economic_finalization_fk
  FOREIGN KEY (finalization_id) REFERENCES economic_finalizations DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX economic_finalization_recovery_idx ON economic_finalizations(signer_state,created_at);
CREATE INDEX economic_finalization_budget_idx ON economic_finalizations(budget_id,exposure_state);

CREATE TABLE economic_authority_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL, actor text NOT NULL,
  intent_id text, generation numeric(20,0), finalization_id uuid,
  consent_id uuid, runtime_id text, reference text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX economic_authority_events_intent_idx ON economic_authority_events(intent_id,event_id);

CREATE FUNCTION economic_revocation_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'economic authority records cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') OR
    OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'economic evidence/configuration is immutable except one-way revocation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_network_immutable BEFORE UPDATE OR DELETE ON economic_network_registry FOR EACH ROW EXECUTE FUNCTION economic_revocation_only();
CREATE TRIGGER economic_asset_immutable BEFORE UPDATE OR DELETE ON economic_asset_registry FOR EACH ROW EXECUTE FUNCTION economic_revocation_only();
CREATE TRIGGER economic_consent_immutable BEFORE UPDATE OR DELETE ON economic_consent_evidence FOR EACH ROW EXECUTE FUNCTION economic_revocation_only();
CREATE TRIGGER economic_runtime_immutable BEFORE UPDATE OR DELETE ON economic_runtime_evidence FOR EACH ROW EXECUTE FUNCTION economic_revocation_only();
CREATE TRIGGER economic_budget_immutable BEFORE UPDATE OR DELETE ON economic_sponsor_budgets FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_events_append_only BEFORE UPDATE OR DELETE ON economic_authority_events FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE FUNCTION economic_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'economic attempts cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['state','finalization_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','finalization_id']) OR
    OLD.state <> 'OPEN' OR NEW.state NOT IN ('CANCELLED','FINALIZATION_COMMITTED') THEN
    RAISE EXCEPTION 'economic attempt identity/fence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_attempt_immutable BEFORE UPDATE OR DELETE ON economic_attempts FOR EACH ROW EXECUTE FUNCTION economic_attempt_guard();
CREATE FUNCTION economic_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'economic head cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'current_generation') IS DISTINCT FROM (to_jsonb(OLD) - 'current_generation') OR
    NEW.current_generation <> OLD.current_generation + 1 OR NOT EXISTS (
      SELECT 1 FROM economic_attempts WHERE intent_id = OLD.intent_id AND generation = OLD.current_generation AND state = 'CANCELLED'
    ) THEN RAISE EXCEPTION 'replacement requires durable predecessor cancellation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_head_immutable BEFORE UPDATE OR DELETE ON economic_attempt_heads FOR EACH ROW EXECUTE FUNCTION economic_head_guard();

CREATE FUNCTION economic_finalization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'finalizations cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['signer_state','exposure_state','result_artifact','artifact_reference','final_transaction_id','refusal_reference','base_consumed','priority_consumed','rent_consumed','accounting_reference','updated_at','version'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['signer_state','exposure_state','result_artifact','artifact_reference','final_transaction_id','refusal_reference','base_consumed','priority_consumed','rent_consumed','accounting_reference','updated_at','version']) THEN
    RAISE EXCEPTION 'finalization tuple and signer operation are immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN RAISE EXCEPTION 'invalid finalization version'; END IF;
  IF OLD.signer_state IN ('REFUSED','RESULT_AVAILABLE') AND
    ROW(NEW.signer_state,NEW.result_artifact,NEW.artifact_reference,NEW.final_transaction_id,NEW.refusal_reference)
    IS DISTINCT FROM ROW(OLD.signer_state,OLD.result_artifact,OLD.artifact_reference,OLD.final_transaction_id,OLD.refusal_reference) THEN
    RAISE EXCEPTION 'authoritative signer result is immutable';
  END IF;
  IF NEW.signer_state <> OLD.signer_state AND NOT (
    (OLD.signer_state = 'NOT_CONTACTED' AND NEW.signer_state = 'CONTACT_COMMITTED') OR
    (OLD.signer_state IN ('CONTACT_COMMITTED','RESULT_UNKNOWN') AND NEW.signer_state IN ('RESULT_UNKNOWN','REFUSED','RESULT_AVAILABLE'))
  ) THEN RAISE EXCEPTION 'invalid signer transition'; END IF;
  IF OLD.exposure_state IN ('RELEASED','CONSUMED') AND
    ROW(NEW.exposure_state,NEW.base_consumed,NEW.priority_consumed,NEW.rent_consumed,NEW.accounting_reference)
    IS DISTINCT FROM ROW(OLD.exposure_state,OLD.base_consumed,OLD.priority_consumed,OLD.rent_consumed,OLD.accounting_reference) THEN
    RAISE EXCEPTION 'terminal exposure is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_finalization_immutable BEFORE UPDATE OR DELETE ON economic_finalizations FOR EACH ROW EXECUTE FUNCTION economic_finalization_guard();

CREATE FUNCTION economic_finalization_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM economic_attempts a JOIN economic_finalizations f
    ON f.intent_id=a.intent_id AND f.generation=a.generation AND a.finalization_id=f.finalization_id
    WHERE f.finalization_id=NEW.finalization_id AND a.state='FINALIZATION_COMMITTED'
      AND a.envelope_digest=f.tuple->>'envelopeDigest' AND a.message_digest=f.tuple->>'messageDigest'
      AND a.envelope->'attempt'=f.tuple->'attempt') THEN
    RAISE EXCEPTION 'finalization requires matching durable committed fence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER economic_finalization_fence_guard AFTER INSERT ON economic_finalizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_finalization_consistency();

-- The reverse fence constraint prevents a committed attempt pointing at another generation's operation.
CREATE FUNCTION economic_attempt_finalization_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='FINALIZATION_COMMITTED' AND NOT EXISTS (
    SELECT 1 FROM economic_finalizations f WHERE f.finalization_id=NEW.finalization_id
      AND f.intent_id=NEW.intent_id AND f.generation=NEW.generation
      AND f.tuple->>'envelopeDigest'=NEW.envelope_digest AND f.tuple->>'messageDigest'=NEW.message_digest
      AND f.tuple->'attempt'=NEW.envelope->'attempt'
  ) THEN RAISE EXCEPTION 'committed attempt requires its own canonical finalization'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER economic_attempt_finalization_guard AFTER INSERT OR UPDATE ON economic_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_attempt_finalization_consistency();

CREATE FUNCTION economic_budget_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b economic_sponsor_budgets%ROWTYPE;
  total_base numeric; total_priority numeric; total_rent numeric; outstanding bigint;
BEGIN
  SELECT * INTO b FROM economic_sponsor_budgets WHERE budget_id=NEW.budget_id FOR UPDATE;
  IF b.network <> NEW.tuple->'network' OR b.sponsor_public_key <> NEW.tuple->>'sponsorPublicKey' OR
    b.sponsor_key_version <> NEW.tuple->>'sponsorKeyVersion' THEN
    RAISE EXCEPTION 'reservation sponsor/network budget mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM economic_attempts a
    JOIN economic_consent_evidence c ON c.consent_id=NEW.consent_id
    JOIN economic_runtime_evidence r ON r.decision_id=NEW.runtime_id
    JOIN economic_asset_registry p ON p.registry_id=NEW.payment_registry_id
    JOIN economic_asset_registry f ON f.registry_id=NEW.fee_registry_id
    WHERE a.intent_id=NEW.intent_id AND a.generation=NEW.generation
      AND a.requested_exposure_id=NEW.exposure_id
      AND (a.envelope->'fee'->>'maxBaseFee')::numeric=NEW.base_requested
      AND (a.envelope->'fee'->>'maxPriorityFee')::numeric=NEW.priority_requested
      AND (a.envelope->'fee'->>'maxRent')::numeric=NEW.rent_requested
      AND p.identity=a.envelope->'amount'->'asset' AND p.use_role='PAYMENT'
      AND f.identity=a.envelope->'fee'->'asset' AND f.use_role='FEE'
      AND c.envelope_digest=a.envelope_digest AND c.principal_id=a.envelope->'principal'->>'id'
      AND r.envelope_digest=a.envelope_digest AND r.network=NEW.tuple->'network'
      AND r.binding->'reference'=NEW.tuple->'runtime' AND r.binding->>'result'='approved'
      AND r.binding->>'envelopeDigest'=a.envelope_digest
  ) THEN RAISE EXCEPTION 'reservation/evidence/registry binding mismatch'; END IF;
  SELECT
    COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN base_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN base_requested ELSE 0 END),0),
    COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN priority_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN priority_requested ELSE 0 END),0),
    COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN rent_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN rent_requested ELSE 0 END),0),
    count(*) FILTER (WHERE exposure_state IN ('RESERVED','UNCERTAIN'))
    INTO total_base,total_priority,total_rent,outstanding FROM economic_finalizations WHERE budget_id=NEW.budget_id;
  IF total_base>b.base_limit OR total_priority>b.priority_limit OR total_rent>b.rent_limit OR outstanding>b.outstanding_limit THEN
    RAISE EXCEPTION 'durable sponsor exposure capacity exceeded';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER economic_budget_capacity_guard AFTER INSERT OR UPDATE ON economic_finalizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_budget_capacity();

-- Requested is an intent bound, not a reservation. Released includes verified unused capacity after realization.
CREATE VIEW economic_exposure_projection AS
SELECT a.intent_id,a.generation,a.state AS attempt_state,a.requested_exposure_id,
  f.finalization_id,f.budget_id,COALESCE(f.exposure_state,'REQUESTED') AS exposure_state,
  (a.envelope->'fee'->>'maxBaseFee')::numeric AS base_requested,
  (a.envelope->'fee'->>'maxPriorityFee')::numeric AS priority_requested,
  (a.envelope->'fee'->>'maxRent')::numeric AS rent_requested,
  CASE WHEN f.exposure_state IN ('RESERVED','UNCERTAIN') THEN f.base_requested ELSE 0 END AS base_reserved,
  CASE WHEN f.exposure_state IN ('RESERVED','UNCERTAIN') THEN f.priority_requested ELSE 0 END AS priority_reserved,
  CASE WHEN f.exposure_state IN ('RESERVED','UNCERTAIN') THEN f.rent_requested ELSE 0 END AS rent_reserved,
  COALESCE(f.base_consumed,0) AS base_consumed,COALESCE(f.priority_consumed,0) AS priority_consumed,COALESCE(f.rent_consumed,0) AS rent_consumed,
  CASE WHEN f.exposure_state='RELEASED' THEN f.base_requested WHEN f.exposure_state='CONSUMED' THEN f.base_requested-f.base_consumed ELSE 0 END AS base_released,
  CASE WHEN f.exposure_state='RELEASED' THEN f.priority_requested WHEN f.exposure_state='CONSUMED' THEN f.priority_requested-f.priority_consumed ELSE 0 END AS priority_released,
  CASE WHEN f.exposure_state='RELEASED' THEN f.rent_requested WHEN f.exposure_state='CONSUMED' THEN f.rent_requested-f.rent_consumed ELSE 0 END AS rent_released
FROM economic_attempts a LEFT JOIN economic_finalizations f USING(intent_id,generation);

-- Evidence storage is separate from operational logs; a rejected callback never changes an attempt fence.
CREATE TABLE economic_callback_evidence (
  evidence_id uuid PRIMARY KEY,
  intent_id text NOT NULL,
  generation numeric(20,0) NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  artifact bytea NOT NULL CHECK (octet_length(artifact) BETWEEN 1 AND 1232),
  validation text NOT NULL CHECK (validation IN ('CUSTOMER_VERIFIED','REJECTED')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (intent_id,generation) REFERENCES economic_attempts
);
CREATE TRIGGER economic_callback_append_only BEFORE UPDATE OR DELETE ON economic_callback_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
