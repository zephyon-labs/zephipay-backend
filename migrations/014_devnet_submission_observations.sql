CREATE TYPE devnet_submission_outcome AS ENUM ('ACCEPTED','SETTLED','REJECTED','UNKNOWN','VALIDATION_FAILED');
CREATE TYPE devnet_provider_contact_certainty AS ENUM ('NOT_STARTED','MAY_HAVE_OCCURRED','ACCEPTED');

CREATE TABLE devnet_submission_observations (
  observation_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES payment_executions(execution_id) ON DELETE RESTRICT,
  preparation_id uuid NOT NULL,
  commitment_id uuid NOT NULL REFERENCES devnet_submission_commitments(commitment_id) ON DELETE RESTRICT,
  provider_id text NOT NULL CHECK(provider_id=btrim(provider_id) AND length(provider_id) BETWEEN 1 AND 128),
  transaction_signature text NOT NULL CHECK(transaction_signature=btrim(transaction_signature) AND length(transaction_signature)>0),
  outcome devnet_submission_outcome NOT NULL,
  contact_certainty devnet_provider_contact_certainty NOT NULL,
  observed_at timestamptz NOT NULL,
  provider_error_code varchar(64) CHECK(provider_error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  slot numeric(78,0) CHECK(slot >= 0),
  confirmation_status varchar(32) CHECK(confirmation_status ~ '^[A-Za-z0-9_-]{1,32}$'),
  FOREIGN KEY(preparation_id,execution_id) REFERENCES devnet_execution_preparations(preparation_id,execution_id) ON DELETE RESTRICT,
  CHECK((outcome='VALIDATION_FAILED')=(contact_certainty='NOT_STARTED')),
  CHECK((outcome IN ('ACCEPTED','SETTLED'))=(contact_certainty='ACCEPTED'))
);
CREATE INDEX devnet_submission_observations_execution ON devnet_submission_observations(execution_id,observed_at,observation_id);
CREATE TRIGGER devnet_submission_observations_append_only BEFORE UPDATE OR DELETE ON devnet_submission_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
