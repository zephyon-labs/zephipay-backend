CREATE TYPE devnet_reconciliation_outcome AS ENUM ('MISSING','PENDING','SETTLED','FAILED','UNKNOWN');

ALTER TABLE devnet_execution_preparations ADD CONSTRAINT devnet_preparation_execution_identity UNIQUE(preparation_id,execution_id);

CREATE TABLE devnet_reconciliation_observations (
  observation_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES payment_executions(execution_id) ON DELETE RESTRICT,
  preparation_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK(sequence_number > 0),
  provider_id text NOT NULL CHECK(provider_id=btrim(provider_id) AND length(provider_id) BETWEEN 1 AND 128),
  outcome devnet_reconciliation_outcome NOT NULL,
  observed_at timestamptz NOT NULL,
  slot numeric(78,0) CHECK(slot >= 0),
  confirmation_status varchar(32) CHECK(confirmation_status ~ '^[A-Za-z0-9_-]{1,32}$'),
  error_code varchar(64) CHECK(error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  UNIQUE(execution_id,sequence_number),
  FOREIGN KEY(preparation_id,execution_id) REFERENCES devnet_execution_preparations(preparation_id,execution_id) ON DELETE RESTRICT,
  CHECK((outcome='FAILED')=(error_code IS NOT NULL))
);
CREATE INDEX devnet_reconciliation_observations_execution ON devnet_reconciliation_observations(execution_id,sequence_number);
CREATE TRIGGER devnet_reconciliation_observations_append_only BEFORE UPDATE OR DELETE ON devnet_reconciliation_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
