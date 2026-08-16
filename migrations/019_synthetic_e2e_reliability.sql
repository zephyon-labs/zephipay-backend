CREATE TYPE synthetic_actor_kind AS ENUM ('human','agent');
CREATE TYPE synthetic_test_origin AS ENUM ('codex_e2e');
CREATE TYPE e2e_test_mode AS ENUM ('OFFLINE','LIVE_DEVNET_CANARY');
CREATE TYPE e2e_test_result AS ENUM ('RUNNING','PASSED','FAILED','UNSUPPORTED');

CREATE TABLE synthetic_test_actors (
  synthetic_actor_id text PRIMARY KEY CHECK (synthetic_actor_id=btrim(synthetic_actor_id) AND length(synthetic_actor_id)>0),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(account_id) ON DELETE RESTRICT,
  actor_class text NOT NULL DEFAULT 'synthetic_test' CHECK (actor_class='synthetic_test'),
  actor_kind synthetic_actor_kind NOT NULL,
  test_origin synthetic_test_origin NOT NULL,
  devnet_destination_address text,
  destination_relationship text CHECK (destination_relationship IS NULL OR destination_relationship='configured_test_destination_not_ownership'),
  created_at timestamptz NOT NULL DEFAULT now()
  ,CHECK ((devnet_destination_address IS NULL)=(destination_relationship IS NULL))
);

CREATE FUNCTION protect_synthetic_test_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'synthetic test actor classification is immutable';
END $$;
CREATE TRIGGER synthetic_test_actors_immutable BEFORE UPDATE OR DELETE ON synthetic_test_actors
  FOR EACH ROW EXECUTE FUNCTION protect_synthetic_test_actor();

CREATE TABLE e2e_test_runs (
  run_id uuid PRIMARY KEY,
  scenario_name text NOT NULL CHECK (scenario_name IN (
    'human-to-human-happy-path','duplicate-confirm','duplicate-execute','refresh-after-execute',
    'recover-after-ambiguous-response','restart-after-commit','reconciliation-recovery',
    'receipt-idempotency','payment-completion-idempotency','human-to-agent','agent-to-human','agent-to-agent'
  )),
  test_origin synthetic_test_origin NOT NULL,
  mode e2e_test_mode NOT NULL,
  source_actor_id text REFERENCES synthetic_test_actors(synthetic_actor_id) ON DELETE RESTRICT,
  destination_actor_id text REFERENCES synthetic_test_actors(synthetic_actor_id) ON DELETE RESTRICT,
  source_actor_kind synthetic_actor_kind NOT NULL,
  destination_actor_kind synthetic_actor_kind NOT NULL,
  actor_flow text NOT NULL CHECK (actor_flow IN ('H2H','H2B','B2B','H2A','A2H','A2A','A2B')),
  canonical_payment_flow text GENERATED ALWAYS AS (
    CASE actor_flow WHEN 'H2H' THEN 'P2P' WHEN 'H2B' THEN 'P2B' WHEN 'B2B' THEN 'B2B'
      WHEN 'H2A' THEN 'P2AI' WHEN 'A2H' THEN 'AI2P' WHEN 'A2A' THEN 'AI2AI' WHEN 'A2B' THEN 'AI2B' END
  ) STORED,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  result e2e_test_result NOT NULL DEFAULT 'RUNNING',
  payment_intent_id uuid REFERENCES payments(id) ON DELETE RESTRICT,
  execution_id uuid REFERENCES payment_executions(execution_id) ON DELETE RESTRICT,
  failure_stage text,
  failure_reason text,
  invariant_violations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(invariant_violations)='array'),
  final_payment_status text,
  final_execution_status text,
  receipt_count integer CHECK (receipt_count IS NULL OR receipt_count>=0),
  commitment_count integer CHECK (commitment_count IS NULL OR commitment_count>=0),
  submission_count integer CHECK (submission_count IS NULL OR submission_count>=0),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms>=0),
  CHECK ((result='RUNNING')=(completed_at IS NULL)),
  CHECK (result='RUNNING' OR duration_ms IS NOT NULL),
  CHECK ((result='FAILED') OR (failure_stage IS NULL AND failure_reason IS NULL)),
  CHECK ((scenario_name IN ('human-to-agent','agent-to-human','agent-to-agent')) OR
         (source_actor_kind='human' AND destination_actor_kind='human')),
  CHECK ((scenario_name='human-to-agent' AND actor_flow='H2A') OR
         (scenario_name='agent-to-human' AND actor_flow='A2H') OR
         (scenario_name='agent-to-agent' AND actor_flow='A2A') OR
         (scenario_name NOT IN ('human-to-agent','agent-to-human','agent-to-agent') AND actor_flow='H2H'))
);

CREATE FUNCTION protect_e2e_test_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.result<>'RUNNING' THEN RAISE EXCEPTION 'terminal E2E test runs are immutable'; END IF;
  IF NEW.result='RUNNING' THEN RAISE EXCEPTION 'E2E test run updates must be terminal'; END IF;
  IF ROW(NEW.run_id,NEW.scenario_name,NEW.test_origin,NEW.mode,NEW.source_actor_id,
         NEW.destination_actor_id,NEW.source_actor_kind,NEW.destination_actor_kind,NEW.actor_flow,NEW.started_at)
     IS DISTINCT FROM
     ROW(OLD.run_id,OLD.scenario_name,OLD.test_origin,OLD.mode,OLD.source_actor_id,
         OLD.destination_actor_id,OLD.source_actor_kind,OLD.destination_actor_kind,OLD.actor_flow,OLD.started_at)
  THEN RAISE EXCEPTION 'E2E test run identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER e2e_test_runs_monotonic BEFORE UPDATE ON e2e_test_runs
  FOR EACH ROW EXECUTE FUNCTION protect_e2e_test_run();
CREATE TRIGGER e2e_test_runs_no_delete BEFORE DELETE ON e2e_test_runs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE INDEX e2e_test_runs_qa_activity ON e2e_test_runs(started_at DESC,scenario_name,result);
CREATE INDEX synthetic_test_actors_classification ON synthetic_test_actors(account_id,test_origin,actor_kind);
