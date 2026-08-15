ALTER TABLE devnet_reconciliation_observations
  DROP CONSTRAINT devnet_reconciliation_observations_check;

ALTER TABLE devnet_reconciliation_observations
  ADD CONSTRAINT devnet_reconciliation_observations_error_evidence_check
  CHECK (
    (outcome <> 'FAILED' OR error_code IS NOT NULL)
    AND (error_code IS NULL OR outcome IN ('FAILED', 'UNKNOWN'))
  );
