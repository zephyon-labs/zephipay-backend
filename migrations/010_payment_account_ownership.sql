-- Phase C: canonical account ownership for payment records.
--
-- beta_allowlist is an optional access-policy mechanism.
-- It must not be the referential owner of economic records.
--
-- New payment and execution records belong to canonical accounts through
-- accounts(actor_subject). Existing historical rows are preserved.

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_actor_subject_fkey;

ALTER TABLE payments
  ADD CONSTRAINT payments_actor_subject_account_fkey
  FOREIGN KEY (actor_subject)
  REFERENCES accounts(actor_subject)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE payment_executions
  DROP CONSTRAINT IF EXISTS payment_executions_actor_subject_fkey;

ALTER TABLE payment_executions
  ADD CONSTRAINT payment_executions_actor_subject_account_fkey
  FOREIGN KEY (actor_subject)
  REFERENCES accounts(actor_subject)
  ON DELETE RESTRICT
  NOT VALID;

-- Validate immediately when all existing historical rows already map to
-- canonical accounts. If legacy rows predate canonical account provisioning,
-- keep the new FK NOT VALID: PostgreSQL still enforces it for every new row
-- without destroying historical records.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM payments p
    LEFT JOIN accounts a ON a.actor_subject = p.actor_subject
    WHERE a.actor_subject IS NULL
  ) THEN
    ALTER TABLE payments
      VALIDATE CONSTRAINT payments_actor_subject_account_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM payment_executions e
    LEFT JOIN accounts a ON a.actor_subject = e.actor_subject
    WHERE a.actor_subject IS NULL
  ) THEN
    ALTER TABLE payment_executions
      VALIDATE CONSTRAINT payment_executions_actor_subject_account_fkey;
  END IF;
END
$$;
