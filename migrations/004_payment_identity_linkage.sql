CREATE TYPE payment_recipient_type AS ENUM ('DIRECT_WALLET', 'PAYMENT_IDENTITY');
CREATE TYPE trust_confirmation_outcome AS ENUM ('NOT_REQUIRED', 'ACKNOWLEDGED', 'BLOCKED');

ALTER TABLE payments
  ADD COLUMN recipient_type payment_recipient_type NOT NULL DEFAULT 'DIRECT_WALLET',
  ADD COLUMN recipient_account_id uuid REFERENCES accounts(account_id) ON DELETE RESTRICT,
  ADD COLUMN recipient_snapshot jsonb,
  ADD COLUMN recipient_snapshot_version smallint,
  ADD COLUMN trust_confirmation_outcome trust_confirmation_outcome,
  ADD CONSTRAINT payments_recipient_identity_shape CHECK (
    (recipient_type = 'DIRECT_WALLET' AND recipient_account_id IS NULL AND
      recipient_snapshot IS NULL AND recipient_snapshot_version IS NULL AND
      trust_confirmation_outcome IS NULL) OR
    (recipient_type = 'PAYMENT_IDENTITY' AND recipient_account_id IS NOT NULL AND
      recipient_snapshot IS NOT NULL AND recipient_snapshot_version = 1 AND
      trust_confirmation_outcome IN ('NOT_REQUIRED', 'ACKNOWLEDGED') AND
      recipient_snapshot->>'accountId' = lower(recipient_account_id::text) AND
      recipient_snapshot->>'schemaVersion' = '1' AND
      recipient_snapshot->>'trustOutcome' = trust_confirmation_outcome::text)
  );

CREATE INDEX payments_recent_identity_idx
  ON payments (actor_subject, recipient_account_id, created_at DESC, id DESC)
  WHERE recipient_type = 'PAYMENT_IDENTITY';

CREATE FUNCTION protect_payment_identity_linkage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recipient_type IS DISTINCT FROM OLD.recipient_type OR
     NEW.recipient_address IS DISTINCT FROM OLD.recipient_address OR
     NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id OR
     NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot OR
     NEW.recipient_snapshot_version IS DISTINCT FROM OLD.recipient_snapshot_version OR
     NEW.trust_confirmation_outcome IS DISTINCT FROM OLD.trust_confirmation_outcome THEN
    RAISE EXCEPTION 'payment recipient linkage is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_protect_recipient_linkage
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION protect_payment_identity_linkage();
