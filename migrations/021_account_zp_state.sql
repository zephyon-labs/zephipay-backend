CREATE TABLE account_zp_state (
  account_id uuid PRIMARY KEY
    REFERENCES accounts(account_id)
    ON DELETE RESTRICT,

  policy_version integer NOT NULL
    CHECK (policy_version = 1),

  total_points bigint NOT NULL DEFAULT 0
    CHECK (total_points >= 0),

  sent_count bigint NOT NULL DEFAULT 0
    CHECK (sent_count >= 0),

  received_count bigint NOT NULL DEFAULT 0
    CHECK (received_count >= 0),

  last_growth_event_id bigint NOT NULL DEFAULT 0
    CHECK (last_growth_event_id >= 0),

  updated_at timestamptz NOT NULL
);

CREATE INDEX account_zp_state_progress
  ON account_zp_state(total_points DESC, account_id);
