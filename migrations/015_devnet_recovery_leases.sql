CREATE TYPE devnet_recovery_task_kind AS ENUM ('PREPARATION','RECONCILIATION');

CREATE TABLE devnet_recovery_leases (
  execution_id uuid NOT NULL REFERENCES payment_executions(execution_id) ON DELETE CASCADE,
  task_kind devnet_recovery_task_kind NOT NULL,
  lease_owner text NOT NULL CHECK(lease_owner=btrim(lease_owner) AND length(lease_owner) BETWEEN 1 AND 128),
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL CHECK(lease_expires_at>claimed_at),
  PRIMARY KEY(execution_id,task_kind)
);
CREATE INDEX devnet_recovery_leases_expiry ON devnet_recovery_leases(task_kind,lease_expires_at,execution_id);
