CREATE TABLE synthetic_beta_identities (
  synthetic_id uuid PRIMARY KEY,
  normalized_name text NOT NULL UNIQUE CHECK(octet_length(normalized_name) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK(octet_length(display_name) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION protect_payment_identity_linkage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.recipient_type IS DISTINCT FROM OLD.recipient_type OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address OR NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id OR NEW.recipient_synthetic_id IS DISTINCT FROM OLD.recipient_synthetic_id OR NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot OR NEW.recipient_snapshot_version IS DISTINCT FROM OLD.recipient_snapshot_version OR NEW.trust_confirmation_outcome IS DISTINCT FROM OLD.trust_confirmation_outcome THEN RAISE EXCEPTION 'payment recipient linkage is immutable'; END IF; RETURN NEW; END; $$;

ALTER TABLE payments ADD COLUMN recipient_synthetic_id uuid REFERENCES synthetic_beta_identities(synthetic_id) ON DELETE RESTRICT;
UPDATE payments SET recipient_snapshot=jsonb_set(recipient_snapshot,'{identitySource}','"RECIPIENT_DIRECTORY"'::jsonb,true) WHERE recipient_type='PAYMENT_IDENTITY';
ALTER TABLE payments DROP CONSTRAINT payments_recipient_identity_shape;
ALTER TABLE payments ADD CONSTRAINT payments_recipient_identity_shape CHECK (
 (recipient_type='DIRECT_WALLET' AND recipient_account_id IS NULL AND recipient_synthetic_id IS NULL AND recipient_snapshot IS NULL AND recipient_snapshot_version IS NULL AND trust_confirmation_outcome IS NULL) OR
 (recipient_type='PAYMENT_IDENTITY' AND recipient_snapshot IS NOT NULL AND recipient_snapshot_version=1 AND trust_confirmation_outcome IN ('NOT_REQUIRED','ACKNOWLEDGED') AND
  ((recipient_account_id IS NOT NULL AND recipient_synthetic_id IS NULL AND recipient_snapshot->>'identitySource'='RECIPIENT_DIRECTORY' AND recipient_snapshot->>'accountId'=lower(recipient_account_id::text)) OR
   (recipient_account_id IS NULL AND recipient_synthetic_id IS NOT NULL AND recipient_snapshot->>'identitySource'='SYNTHETIC_BETA' AND recipient_snapshot->>'accountId'=lower(recipient_synthetic_id::text))) AND
  recipient_snapshot->>'schemaVersion'='1' AND recipient_snapshot->>'trustOutcome'=trust_confirmation_outcome::text)
);
